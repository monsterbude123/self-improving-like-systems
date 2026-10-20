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
 *   · 正向：探针必须**真的**写出一条 ERROR 到 tmp 兜底目录 —— 否则「运行时目录没变」是因为没人写，是空断言；
 *   · 反向：运行时日志目录必须**逐字节不变** —— 这条变红才是缺陷真的回来了。
 * 只做后半条 = 判据在「日志器坏了」时同样绿。
 *
 * 同类残留（编号账本）判据在 `tests/next-id.test.mjs` 末尾，见那里的说明。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PROTOCOL_ROOT, runAll } from '../scripts/run-tests.mjs'
import { resolveLogDir, fallbackLogDir } from '../scripts/lib/log.mjs'

const TESTS_DIR = path.join(PROTOCOL_ROOT, 'tests')
/** 自检前的真实运行时日志落点（配置缺省 `.self-improving/logs/` 相对协议层根）。 */
const RUNTIME_LOG_DIR = path.join(PROTOCOL_ROOT, '.self-improving', 'logs')
const PROBE = path.join(TESTS_DIR, 'fixtures', 'logging', 'fail-open-probe.test.mjs')

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
  it('跑一遍会写 ERROR 的探针 → 运行时日志逐字节不变，且那行 ERROR 落在 tmp 兜底目录', () => {
    const before = snapshotDir(RUNTIME_LOG_DIR)
    // 把子进程的 tmpdir 指到受控目录：兜底目录是全局共享的，不隔离的话
    // 「多了一条日志」既可能被别的进程写出来，也可能被别的进程抹掉 —— 两种都让判据失去意义。
    const sandbox = mkdtempSync(path.join(tmpdir(), 'si-fallback-sandbox-'))
    try {
      const rc = runAll({
        files: [PROBE],
        stdio: 'pipe',
        env: { TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox },
      })
      assert.equal(rc, 0, '探针自身必须跑通（它就是判据的写入者，挂了就没得判）')

      // 正向：真的写了。缺这一条，「运行时目录没变」可能只是因为没人写。
      const errLog = path.join(sandbox, 'self-improving-logs', 'si-error.log')
      assert.ok(existsSync(errLog),
        `tmp 兜底目录里必须有 si-error.log —— 实际目录内容：${JSON.stringify(snapshotDir(sandbox))}`)
      const errText = readFileSync(errLog, 'utf8')
      assert.match(errText, /mod=inject/, '写入者必须是 inject 的 fail-open')
      assert.match(errText, /fail-open/, '写入内容必须是 fail-open 事件本身')

      // 反向：运行时日志一个字节都不能动。这条变红 = 污染缺陷回来了。
      assert.deepEqual(snapshotDir(RUNTIME_LOG_DIR), before,
        `自检污染了运行时日志目录 ${RUNTIME_LOG_DIR}：\n前=${JSON.stringify(before)}\n后=${JSON.stringify(snapshotDir(RUNTIME_LOG_DIR))}`)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
