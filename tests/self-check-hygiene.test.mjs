/**
 * 自检污染检查 —— 「跑判据」这件事本身不得留下痕迹。
 *
 * 背景（2026-10-20 实测）：判据里有一条专门喂坏配置给 `inject.mjs` 的夹具，
 * 用来证明 fail-open 生效。fail-open 按设计必须记 ERROR，而配置损坏时 `loadContext`
 * 拿不到 `baseDir` —— 日志器早先把内置缺省解析到 `process.cwd()`，于是每跑一次自检，
 * 安装目录的**真实运行时日志**里就多一条与线上真故障逐字节同形的「注入坏了」。
 * 同一处缺陷还让写侧与读侧（`log-query.mjs` 查的是 tmp 兜底目录）对不上：
 * 真的注入挂了，去查日志会一无所获。
 *
 * 本文件的判据是**双向**的，缺一不可：
 *   · 正向：必须**真的**写出一条 ERROR 到 tmp 兜底目录 —— 否则「运行时目录没变」是因为没人写，是空断言；
 *   · 反向：运行时日志目录必须**逐字节不变** —— 这条变红才是缺陷真的回来了。
 * 只做后半条 = 判据在「日志器坏了」时同样绿。
 *
 * 同类残留（编号账本）判据在 `tests/next-id.test.mjs` 末尾，见那里的说明。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROTOCOL_ROOT } from '../scripts/run-tests.mjs'
import { resolveLogDir, fallbackLogDir } from '../scripts/lib/log.mjs'

/** 自检前的真实运行时日志落点（配置缺省 `.self-improving/logs/` 相对协议层根）。 */
const RUNTIME_LOG_DIR = path.join(PROTOCOL_ROOT, '.self-improving', 'logs')
const INJECT = path.join(PROTOCOL_ROOT, 'scripts', 'inject.mjs')

/** 目录快照：不存在 → null；存在 → { 文件名: 内容 }，用于逐字节比对。只收普通文件（子目录跳过）。 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return null
  const out = {}
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f)
    if (statSync(p).isFile()) out[f] = readFileSync(p, 'utf8')
  }
  return out
}

describe('日志目录解析：写侧与读侧必须同址', () => {
  it('配置显式给了 dir → 相对 baseDir 解析（调用方说了写哪就写哪）', () => {
    assert.equal(resolveLogDir('/base/dir', 'logs/'), path.resolve('/base/dir', 'logs'))
  })

  it('配置没给 dir 但有 baseDir → 内置缺省落在 baseDir 下', () => {
    assert.equal(resolveLogDir('/base/dir'), path.resolve('/base/dir', '.self-improving/logs/'))
  })

  it('baseDir 缺失（配置不可用）→ tmp 兜底目录，**绝不猜 cwd**', () => {
    // 这条是判据的核心：早先这里 resolve 到 process.cwd()，于是自检把「注入坏了」写进
    // 安装目录的真实日志。baseDir 为 null 是「配置坏了」的信号，cwd 什么都不是。
    for (const bad of [null, undefined, '', '   ']) {
      assert.equal(resolveLogDir(bad), fallbackLogDir(),
        `baseDir=${JSON.stringify(bad)} 时必须落兜底目录，而不是当前工作目录`)
    }
  })

  it('兜底目录与 log-query.mjs 的读侧是同一处', () => {
    // 写侧改了而读侧没改 = 故障现场查不到日志，比污染更难查。
    assert.ok(existsSync(path.dirname(fallbackLogDir())), '兜底目录的父（tmpdir）必须真实存在')
    assert.notEqual(fallbackLogDir(), path.resolve('.self-improving/logs/'))
  })
})

describe('自检不得污染运行时日志', () => {
  it('跑一遍真会 fail-open 的注入 → 运行时日志逐字节不变，且那行 ERROR 落在 tmp 兜底目录', () => {
    const before = snapshotDir(RUNTIME_LOG_DIR)
    const sandbox = mkdtempSync(path.join(tmpdir(), 'si-fallback-sandbox-'))
    const cfgDir = mkdtempSync(path.join(sandbox, 'cfg-'))
    try {
      // 坏配置：行内数组缺右括号，解析必失败 → inject 走 fail-open → 日志器在 baseDir 缺失时落兜底目录。
      // 与 tests/fixtures/inject/config-broken.yaml 同一形态。
      const cfg = path.join(cfgDir, 'config-broken.yaml')
      writeFileSync(cfg, 'version: 1\nscope:\n  values: [infra, testing\n  default: other\n', 'utf8')

      // 直接起一次真进程，而不是经 runAll 再嵌一层 node --test：
      // 被测的是 inject → log 的落点判定，runAll 只是转发环境，嵌进来只多一份负载
      // （实测嵌套 runner 会把全量判据的并发用例挤到偶发变红）。tmpdir 用环境变量重定向，
      // 兜底目录是全局共享的，不隔离的话「多了一条」既可能被别的进程写出、也可能被抹掉。
      const r = spawnSync(process.execPath, [INJECT, '--config', cfg, '--scope', 'infra', '--keywords', 'docker'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox },
      })
      assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.stderr ?? ''}`)
      assert.match(r.stderr ?? '', /fail-open/, '必须真的走到 fail-open 分支，否则本判据是空断言')

      // 正向：真的写了。缺这一条，「运行时目录没变」可能只是因为没人写。
      const errLog = path.join(sandbox, 'self-improving-logs', 'si-error.log')
      assert.ok(existsSync(errLog),
        `tmp 兜底目录里必须有 si-error.log —— 实际目录内容：${JSON.stringify(snapshotDir(sandbox))}`)
      const errText = readFileSync(errLog, 'utf8')
      assert.match(errText, /mod=inject/, '写入者必须是 inject 的 fail-open')
      assert.match(errText, /fail-open/, '写入内容必须是 fail-open 事件本身')

      // 反向：运行时日志一个字节都不能动。这条变红 = 污染缺陷回来了。
      assert.deepEqual(snapshotDir(RUNTIME_LOG_DIR), before,
        `注入的 fail-open 污染了运行时日志目录 ${RUNTIME_LOG_DIR}：\n前=${JSON.stringify(before)}\n后=${JSON.stringify(snapshotDir(RUNTIME_LOG_DIR))}`)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
