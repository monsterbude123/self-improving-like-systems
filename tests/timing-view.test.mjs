/**
 * timing-view.test.mjs —— `--dry-run` 的「连续超时守卫」视图（node:test，零框架依赖）
 *
 * 为什么这组用例必须存在：
 *   看门狗超时按协议是 **fail-open**（放行、只喊一嗓子）。这意味着一个守卫可以连续几十次
 *   跑飞而 commit 全部「成功」—— 没有这个视图，这就是静默失效本身。所以视图的**存在性**
 *   必须有回归保护，否则哪天有人觉得「反正 fail-open」就把它删了，而没人发现。
 *
 * 本文件钉的四根桩（每条都做过破坏验证）：
 *   ① 路径必须跟 **配置里的** events_dir 走，而不是硬编码缺省值。
 *      —— 这条是本文件存在的直接起因：实现初版硬编码 `.self-improving/events/`，
 *         而本仓 `.self-improving.yaml` 配的是 `.learnings-work/events/`，于是视图恒为空。
 *         「实现了但从没生效过」是比没实现更坏的形态：代码读起来像有防护。
 *   ② 损坏/缺失台账 → 当作没有（返回 null），**绝不抛**：dry-run 的契约是零 spawn 零写盘只看不判。
 *   ③ 破坏测试：把 ① 的读取摘掉，视图必须消失（证明这组用例真的会红）。
 *   ④ JSON 输出里的 timing_timeout_streaks 与人读视图同源，不能一个有一个没有。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTimingLedger } from '../scripts/run-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, '..', 'scripts', 'run-guard.mjs')
const SKILL_ROOT = path.resolve(HERE, '..')
const LIFECYCLE_FIXTURE = path.join(HERE, 'fixtures', 'lifecycle')
const FIXTURE_KEY = 'guard-fixture-dup-token'

/** 造一个临时仓根，events_dir 由入参决定（复现本仓把 events_dir 指向 .learnings-work 的形状）。 */
function sandbox(eventsDir) {
  const root = mkdtempSync(path.join(tmpdir(), 'timing-view-'))
  const timingDir = path.join(root, path.dirname(eventsDir), 'timing')
  mkdirSync(timingDir, { recursive: true })
  return { root, ledger: path.join(timingDir, 'ledger.json') }
}

/**
 * 端到端用的沙箱：整份复制 lifecycle fixture（自带 config.yaml + registry.yaml）。
 * 必须复用真 fixture 而非空目录 —— 空目录会让 runner 走「registry 不存在」fail-open 提前返回，
 * 视图永远不执行，测试就成了永远绿的空断言。而且 fixture 的 audit_log 指向仓内，
 * 避免注入审计落到 os.tmpdir() 的全局共享文件（那会污染别的用例，也违反 dry-run 的零副作用直觉）。
 */
function cliSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'timing-view-cli-'))
  cpSync(LIFECYCLE_FIXTURE, root, { recursive: true })
  // fixture 的 events_dir = events/（仓根下），所以台账落在 <root>/timing/ledger.json
  const ledger = path.join(root, 'timing', 'ledger.json')
  mkdirSync(path.dirname(ledger), { recursive: true })
  return { root, ledger }
}

function configWith(eventsDir) {
  return { storage: { events_dir: eventsDir } }
}

function writeLedger(file, guards) {
  writeFileSync(file, JSON.stringify({ v: 1, guards }), 'utf8')
}

describe('readTimingLedger', () => {
  it('① 路径跟着配置里的 events_dir 走，不认硬编码缺省值', () => {
    const eventsDir = '.learnings-work/events/'
    const { root, ledger } = sandbox(eventsDir)
    try {
      writeLedger(ledger, { 'guard-x': { consecutive_timeout: 2 } })
      assert.equal(readTimingLedger(configWith(eventsDir), root)?.guards['guard-x'].consecutive_timeout, 2)
      // 换一份配置就换一份路径：读 .learnings-work 的实现，绝不能从 .self-improving 里读到东西。
      const other = sandbox('.self-improving/events/')
      try {
        assert.equal(readTimingLedger(configWith('.self-improving/events/'), other.root), null)
        assert.equal(readTimingLedger(configWith(eventsDir), other.root), null)
      } finally {
        rmSync(other.root, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('② 缺失 / 损坏 / 结构不对 一律当「没有」，不抛', () => {
    const { root, ledger } = sandbox('.learnings-work/events/')
    const cfg = configWith('.learnings-work/events/')
    try {
      rmSync(ledger, { force: true })
      assert.equal(readTimingLedger(cfg, root), null, '缺失')
      writeFileSync(ledger, '{ 这不是 JSON', 'utf8')
      assert.equal(readTimingLedger(cfg, root), null, '损坏')
      writeFileSync(ledger, JSON.stringify({ v: 1 }), 'utf8')
      assert.equal(readTimingLedger(cfg, root), null, '缺 guards 段')
      writeFileSync(ledger, JSON.stringify({ v: 1, guards: 'nope' }), 'utf8')
      assert.equal(readTimingLedger(cfg, root), null, 'guards 不是对象')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('--dry-run 连续超时视图', () => {
  /** 在临时仓根上真跑一次 CLI dry-run：视图打在 stderr，--json 输出在 stdout，两边都要抓。 */
  function dryRun(root, { json = false } = {}) {
    const args = [RUNNER, '--all', '--dry-run', '--config', path.join(root, 'config.yaml')]
    if (json) args.push('--json')
    const r = spawnSync(process.execPath, args, { cwd: SKILL_ROOT, encoding: 'utf8' })
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('台账里有 consecutive_timeout > 0 时，人读视图与 JSON 字段同时出现', () => {
    const { root, ledger } = cliSandbox()
    try {
      writeLedger(ledger, { [FIXTURE_KEY]: { consecutive_timeout: 3, total_timeouts: 5, p95_ms: 1800 } })
      const human = dryRun(root)
      assert.match(human.stderr, /连续超时守卫 1 条/, `人读视图，实际 stderr:\n${human.stderr}`)
      assert.match(human.stderr, new RegExp(`${FIXTURE_KEY} · 连续超时 3 次 · 累计 5 次`), '条目明细')

      const asJson = dryRun(root, { json: true })
      const doc = JSON.parse(asJson.stdout)
      assert.deepEqual(doc.timing_timeout_streaks, [FIXTURE_KEY], 'JSON 字段与人读视图同源')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('全为 0 / 无台账时，视图明确说「无」，不是静默', () => {
    const { root, ledger } = cliSandbox()
    try {
      writeLedger(ledger, { [FIXTURE_KEY]: { consecutive_timeout: 0, total_timeouts: 4 } })
      const r = dryRun(root)
      assert.match(r.stderr, /无连续超时守卫/, `实际 stderr:\n${r.stderr}`)
      assert.doesNotMatch(r.stderr, /· 连续超时/, 'consecutive_timeout=0 不该被列出来')

      rmSync(ledger, { force: true })
      const none = dryRun(root)
      assert.match(none.stderr, /无连续超时守卫/, '台账缺失也走同一句话')
      assert.equal(none.code, 0, '零信号不判红（fail-open 纪律）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('③ 破坏测试：读取失效时视图必须消失（证明本文件真的会红）', () => {
    const src = readFileSync(RUNNER, 'utf8')
    assert.match(src, /readTimingLedger\(config, baseDir\)/, '实现仍在读配置驱动的路径')
    // 断链模拟：有台账、但配置把 events_dir 指到别处 —— 等价于「读取被摘掉」。
    // 必须指到**嵌套**路径：台账位置取的是 events_dir 的 dirname（与 guardStatePath 同惯例），
    // 指成 `elsewhere` 这种单段名会被 dirname 削回仓根，仍是同一份台账，测不出任何东西。
    const { root, ledger } = cliSandbox()
    try {
      writeLedger(ledger, { [FIXTURE_KEY]: { consecutive_timeout: 3 } })
      const cfg = readFileSync(path.join(root, 'config.yaml'), 'utf8')
      writeFileSync(path.join(root, 'config.yaml'), cfg.replace(/events_dir:.*/, 'events_dir: elsewhere/deep/'), 'utf8')
      const r = dryRun(root)
      assert.match(r.stderr, /无连续超时守卫/, `读取失效后视图消失，实际 stderr:\n${r.stderr}`)
      assert.doesNotMatch(r.stderr, new RegExp(`${FIXTURE_KEY} · 连续超时`), '不再列出任何守卫')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
