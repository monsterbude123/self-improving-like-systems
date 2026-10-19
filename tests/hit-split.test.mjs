/**
 * hit-split.test.mjs —— 命中记账拆成「野外 wild / 探针 probe」两型（node:test，零框架依赖）
 *
 * 为什么这组用例必须存在（本改动的全部风险都在这里）：
 *   破坏测试（解冻前的那一步，stoploss.md §4）与真实路由走**同一个 CLI 入口**。不拆账时，
 *   「我们自己造出来验证守卫能用的违规」与「野外真发生的违规」在账上完全不可分 ——
 *   一次人造违规就换到「用这份守卫退役真实经验条目」的资格（verify.mjs 退役链读守卫级 `ever_hit`）。
 *   于是本文件把四条不可退让的边界各钉一根桩：
 *     ① `--probe` 跑一次违规 → probe_hits=1 且 `ever_hit` 仍为 false（核心）。
 *        拆成 shadow 期（warn-only / exit 0）与 blocking 期（exit 2）两条，各自只派发一次 ——
 *        每次派发都要 spawn 一次守卫，宿主满载时一次 bash spawn 可能超过 run-guard 的
 *        `GUARD_TIMEOUT_MS`（10s）记为 error（实测全套件并行下会偶发，不绿 → 晋升失败），
 *        所以本文件**不做多轮晋升**，blocking 前置一律用**预置账**（mode 直接给 blocking）；
 *     ② 不带 `--probe` 跑一次违规 → wild_hits=1 且 `ever_hit`=true；
 *     ③ 拍5 在「只有 probe 证据」时判绿、在「无任何证据」时判红；
 *     ④ 退役在「只有 probe 证据」时拒绝。
 *   外加两条容易漏的：
 *     ⑤ **拍6 必须跟着拍5 改**（拍6 依赖 swept_hits > 0，而它只在 wild 命中时递增）——
 *        只放宽拍5 而不改拍6，probe-only 的链会从「拍5 红」变成「拍6 红」，改动等于完全无效；
 *     ⑥ 存量回填保守：分型前的 hits / ever_hit 属 legacy-unknown，**不追溯追认** wild。
 *
 * fixture：生命周期侧复用 tests/fixtures/lifecycle/（真跑派发器 + verify CLI）；
 *          对账侧复用 tests/fixtures/trace/（真跑 trace CLI）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeHitLedger, HIT_LEDGER_VERSION } from '../scripts/run-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const RUNNER = path.join(SKILL_ROOT, 'scripts', 'run-guard.mjs')
const VERIFY = path.join(SKILL_ROOT, 'scripts', 'verify.mjs')
const TRACE = path.join(SKILL_ROOT, 'scripts', 'trace.mjs')
const LIFECYCLE_FIXTURE = path.join(HERE, 'fixtures', 'lifecycle')
const TRACE_FIXTURE = path.join(HERE, 'fixtures', 'trace')
const GUARD_KEY = 'guard-fixture-dup-token'
const HIT_ID = 'LRN-20261016-010'
const STALE_ID = 'LRN-20261016-011'
const STALE_ENTRY = 'LRN-20261016-011-fixture-stale-entry.md'
const CHAIN_ID = 'LRN-20261016-001'
const CHAIN_GUARD = 'guard-fixture-trace-chain'
const VIOLATION = 'chore: touch dup-token twice -> dup-token'

function fresh(fixture, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), tag))
  cpSync(fixture, dir, { recursive: true })
  return dir
}

function run(cli, args, dir) {
  const r = spawnSync(process.execPath, [cli, ...args, '--config', path.join(dir, 'config.yaml')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const dispatch = (dir, { probe = false, text = VIOLATION } = {}) =>
  run(RUNNER, ['--key', GUARD_KEY, '--text', text, ...(probe ? ['--probe'] : [])], dir)
const state = (dir) => JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'))
const entryText = (dir, name) => readFileSync(path.join(dir, 'entries', name), 'utf8')
const traceJson = (dir, args = []) => {
  const r = run(TRACE, [...args, '--json'], dir)
  return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null }
}

/** 把 trace 夹具的六拍链改写成「只有 probe 证据」的形态（wild_hits 一律清零）。 */
function toProbeOnlyChain(dir, { sweptProbes = 1, pendingProbes = 0, probeAt = null, observedErrorRuns = 0, probeOutcome = 'proven' } = {}) {
  const p = path.join(dir, 'work', 'guard-state.json')
  const st = JSON.parse(readFileSync(p, 'utf8'))
  const at = probeAt ?? new Date().toISOString()
  const g = st.guards[CHAIN_GUARD]
  Object.assign(g, {
    hit_ledger_version: HIT_LEDGER_VERSION,
    wild_hits: 0,
    first_wild_hit: undefined,
    last_wild_hit: undefined,
    ever_hit: false, // probe 永不置 ever_hit —— 这就是本改动的核心不变量
    probe_hits: 1,
    last_probe_at: at,
    probe_last_outcome: probeOutcome,
    probe_last_outcome_at: at,
  })
  Object.assign(st.entries[CHAIN_ID], {
    hit_ledger_version: HIT_LEDGER_VERSION,
    legacy_hits: 0,
    wild_hits: 0,
    first_wild_hit: undefined,
    last_wild_hit: undefined,
    // 拍1 的 date-overlap 弱链接仍读 first_hit/last_hit（拍1 判据本次不动），保留原值。
    probe_hits: 1,
    probe_last_outcome: probeOutcome,
    probe_last_outcome_at: at,
    observed_error_runs: observedErrorRuns,
    pending_hits: 0,
    pending_records: [],
    pending_probes: pendingProbes,
    pending_probe_records: pendingProbes > 0 ? [{ guard: CHAIN_GUARD, date: at.slice(0, 10), at }] : [],
    swept_hits: 0,
    swept_probes: sweptProbes,
  })
  writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
}

const beat = (traces, n) => traces.find((t) => t.id === CHAIN_ID).beats.find((b) => b.beat === n)

describe('① --probe 命中只记 probe 账，永不置 ever_hit', () => {
  // 拆成两条确定性用例（各只派发一次，暴露面最小）：
  //   (a) 本条 —— shadow 期：warn-only / exit 0；
  //   (b) 见下 —— blocking 期：exit 2 阻断（前置用预置账，不靠「跑几次碰巧攒满」）。
  it('shadow 期 probe 违规：outcome=shadow-warn / exit 0，且 ever_hit 仍为 false', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-probe-')
    try {
      const r = dispatch(dir, { probe: true })
      assert.equal(r.status, 0, `shadow 期 probe 命中只 warn-only（放行语义不变）:\n${r.all}`)
      assert.match(r.all, /shadow-warn/, r.all)
      assert.match(r.all, /hit=probe/, '报表须点明这次的命中是 probe（人审一眼能分型）')

      const g = state(dir).guards[GUARD_KEY]
      assert.equal(g.mode, 'shadow', '前提：新账还在 shadow 期（本例不预置任何状态）')
      assert.equal(g.ever_hit, false, 'probe 命中**永不**置 ever_hit —— 一次人造违规不得换来退役资格')
      assert.equal(g.wild_hits, 0, 'probe 命中不得记进 wild 账')
      assert.equal(g.probe_hits, 1)
      assert.equal(g.probe_last_outcome, 'proven')
      assert.equal(typeof g.last_probe_at, 'string')

      const rec = state(dir).entries[HIT_ID]
      assert.equal(rec.probe_hits, 1, '条目级 probe 账须记账')
      assert.equal(rec.wild_hits, 0, '条目级 wild 账须保持零')
      assert.equal(rec.pending_probes, 1, 'probe 命中进 probe 待结账队列')
      assert.equal(rec.pending_hits ?? 0, 0, 'probe 命中不得进 wild 待回写队列（否则 sweep 会改写条目正文）')
      assert.equal(rec.pending_probe_records.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('blocking 期 probe 命中：仍照常 exit 2 阻断，但记账只在 probe 账', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-probe-block-')
    try {
      // ===== 前置为什么是「预置账」而不是「跑 3 次碰巧攒满」=====
      // 旧写法连跑 4 次干净派发来攒 green → 曾间歇性失败（本条守的是核心不变量，时红时绿等于废掉）。
      // 抓到的现场是：**其中一次干净派发没有变绿**，于是 `shadow_green(3) ≠ shadow_runs(5)`，
      // 晋升永不发生，违规那次落在 shadow 期 → `shadow-warn` / exit 0：
      //   [run-guard] guard-fixture-dup-token · error · exit=null · 10019ms · spawn 失败:
      //   spawnSync bash ETIMEDOUT（fail-open：守卫自身异常不阻塞提交）
      // 即宿主满载时一次 bash spawn 超过 `GUARD_TIMEOUT_MS`（10s）→ outcome=error → 不计绿。
      // 每次派发都要 spawn 一次守卫，5 次派发 = 5 倍暴露面；这里降到**恰好 1 次**。
      //
      // 「mode 是由计数派生的」只在**晋升那一步**成立（commitGuardRun：`mode==='shadow' &&
      // shadow_runs >= required && shadow_green === shadow_runs` 才升）。读账那一步
      // （dispatch 的快照、commitGuardRun 的 prior）都是**直接读 `mode` 字段**，不会重算，
      // 所以预置 `mode: 'blocking'` + `shadow_runs === shadow_green === 3`（≥ registry 的
      // `shadow_required: 3`）是确定性的：下一次派发直接按 blocking 语义裁决退出码。
      const st = {
        guards: {
          [GUARD_KEY]: {
            mode: 'blocking',
            shadow_runs: 3,
            shadow_green: 3,
            error_runs: 0,
            error_streak: 0,
            last_result: 'pass',
            last_run: '2026-10-16T00:00:00.000Z',
            hit_ledger_version: HIT_LEDGER_VERSION,
            wild_hits: 0,
            probe_hits: 0,
            ever_hit: false,
          },
        },
        entries: {},
      }
      writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8')

      const r = dispatch(dir, { probe: true })
      assert.equal(r.status, 2, 'blocking 期 probe 命中照常阻断:\n' + r.all)
      assert.match(r.all, /hit=probe/, `报表须标出这次命中是 probe:\n${r.all}`)
      const g = state(dir).guards[GUARD_KEY]
      assert.equal(g.mode, 'blocking')
      assert.equal(g.ever_hit, false, '即便 blocking 阻断，probe 也不置 ever_hit')
      assert.equal(g.probe_hits, 1)
      assert.equal(g.wild_hits, 0)
      const rec = state(dir).entries[HIT_ID]
      assert.equal(rec.probe_hits, 1)
      assert.equal(rec.wild_hits, 0)
      assert.equal(rec.pending_hits ?? 0, 0, 'blocking 阻断也不许把人造违规送进条目回写队列')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sweep 只给 probe 结账：条目正文（recurrence / last_verified_at / 对质段）一个字都不动', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-probe-sweep-')
    try {
      const name = 'LRN-20261016-010-fixture-dup-token.md'
      dispatch(dir, { probe: true })
      const before = entryText(dir, name)
      const s = run(VERIFY, ['--sweep'], dir)
      assert.equal(s.status, 0, s.all)
      const rec = state(dir).entries[HIT_ID]
      assert.equal(rec.pending_probes, 0, 'probe 账必须被结清')
      assert.equal(rec.swept_probes, 1, '结清结果须落 swept_probes（拍6 的判据读它）')
      assert.equal(rec.pending_hits ?? 0, 0)
      assert.equal(rec.swept_hits ?? 0, 0, 'probe 不得抬 swept_hits（那是 wild 回写的落点）')
      assert.equal(entryText(dir, name), before, 'probe 命中是自证，不是野外复发 —— 条目正文必须逐字节不变')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('② 不带 --probe 的命中 = wild：ever_hit 照常置位', () => {
  it('wild 违规：wild_hits=1 / ever_hit=true / probe 账保持零', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-wild-')
    try {
      const r = dispatch(dir)
      assert.equal(r.status, 0, r.all) // shadow 期 warn-only
      const g = state(dir).guards[GUARD_KEY]
      assert.equal(g.ever_hit, true, '野外捕获必须置 ever_hit（退役链的证据面）')
      assert.equal(g.wild_hits, 1)
      assert.equal(g.probe_hits, 0)
      assert.equal(g.probe_last_outcome ?? null, null, 'wild 派发不得写 probe 结论')
      const rec = state(dir).entries[HIT_ID]
      assert.equal(rec.wild_hits, 1)
      assert.equal(rec.first_wild_hit, new Date().toISOString().slice(0, 10))
      assert.equal(rec.probe_hits, 0)
      assert.equal(rec.pending_hits, 1, 'wild 命中照常进待回写队列')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('两型互不串账：先 probe 再 wild，两个计数器各归各位', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-mixed-')
    try {
      dispatch(dir, { probe: true })
      dispatch(dir)
      const g = state(dir).guards[GUARD_KEY]
      assert.equal(g.probe_hits, 1)
      assert.equal(g.wild_hits, 1)
      assert.equal(g.ever_hit, true)
      const rec = state(dir).entries[HIT_ID]
      assert.equal(rec.probe_hits, 1)
      assert.equal(rec.wild_hits, 1)
      assert.equal(rec.pending_probes, 1)
      assert.equal(rec.pending_hits, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('③ 拍5 两型判据', () => {
  it('只有 probe 证据 → 拍5 判绿（六拍全链 exit 0）', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-probe-')
    try {
      toProbeOnlyChain(dir)
      const r = traceJson(dir)
      assert.equal(r.status, 0, `probe-only 的链应当走完六拍:\n${r.all}`)
      assert.equal(beat(r.json.traces, 5).ok, true, '拍5：末次 proven 的探针可作替代路径')
      assert.equal(r.json.verdict, 'pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无任何拦截证据 → 拍5 判红', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-none-')
    try {
      const p = path.join(dir, 'work', 'guard-state.json')
      const st = JSON.parse(readFileSync(p, 'utf8'))
      st.entries[CHAIN_ID].wild_hits = 0
      st.entries[CHAIN_ID].first_wild_hit = undefined
      st.entries[CHAIN_ID].probe_hits = 0
      st.entries[CHAIN_ID].probe_last_outcome = undefined
      st.entries[CHAIN_ID].probe_last_outcome_at = undefined
      writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 5).ok, false, '没有任何命中证据时拍5 必须红')
      assert.equal(r.status, 1)
      assert.match(beat(r.json.traces, 5).evidence.map((e) => e.note ?? '').join('\n'), /无任何拦截证据/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('探针没拦住（末次 missed）→ 拍5 判红（上一次 proven 不一直有效）', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-missed-')
    try {
      toProbeOnlyChain(dir, { probeOutcome: 'missed' })
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 5).ok, false, '末次探针没拦住就判红')
      assert.equal(r.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('探针证据过期（> cycle_days）→ 拍5 判红（守卫判据会漂移，半年前的探针不算数）', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-stale-')
    try {
      // trace fixture 的 config.retire.cycle_days = 90（与 verify.mjs 同源，不另立数字）
      const stale = new Date(Date.now() - 91 * 86_400_000).toISOString()
      toProbeOnlyChain(dir, { probeAt: stale })
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 5).ok, false, '过期探针不得判绿')
      assert.equal(r.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('判据异常派发过（observed_error_runs > 0）→ 拍5 判红', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-err-')
    try {
      toProbeOnlyChain(dir, { observedErrorRuns: 2 })
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 5).ok, false, '判据没跑起来的那段时间里，「它能拦」无从谈起')
      assert.equal(r.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('⑤ 拍6 必须跟着拍5 改（最容易漏的一处）', () => {
  it('probe 账未由 --sweep 结清 → 拍6 判红（探针证据必须有落点）', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-unswept-')
    try {
      toProbeOnlyChain(dir, { sweptProbes: 0, pendingProbes: 1 })
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 5).ok, true, '前提：拍5 已判绿（只放宽了拍5）')
      assert.equal(beat(r.json.traces, 6).ok, false, '若拍6 没跟着改，这里会是绿的 —— 那就是「拍5 改了拍6 没改」的漏法')
      assert.equal(r.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probe 账已结清（swept_probes ≥ 1 且 pending_probes = 0）→ 拍6 判绿，且不要求条目正文被改', () => {
    const dir = fresh(TRACE_FIXTURE, 'hit-split-trace-swept-')
    try {
      toProbeOnlyChain(dir, { sweptProbes: 1, pendingProbes: 0 })
      const before = entryText(dir, `${CHAIN_ID}-fixture-trace-chain.md`)
      const r = traceJson(dir)
      assert.equal(beat(r.json.traces, 6).ok, true)
      assert.equal(entryText(dir, `${CHAIN_ID}-fixture-trace-chain.md`), before, 'trace 是只读命令')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('④ 退役：只有 probe 证据一律拒绝', () => {
  const staleIso = '2026-02-01T00:00:00.000Z'

  it('覆盖守卫的 ever_hit 只由 wild 置位 → probe-only 的条目不退役', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-retire-probe-')
    try {
      // 守卫级：blocking + 绿灯攒满 + probe 命中过（这就是「我们自己造违规验证过」的形态），
      // 观测久远（lifecycle fixture cycle_days=30，2026-02 已远超）—— 旧判据会放行退役。
      const st = {
        guards: {
          [GUARD_KEY]: {
            mode: 'blocking',
            shadow_runs: 3,
            shadow_green: 3,
            error_runs: 0,
            hit_ledger_version: HIT_LEDGER_VERSION,
            wild_hits: 0,
            probe_hits: 1,
            probe_last_outcome: 'proven',
            ever_hit: false,
            last_result: 'pass',
          },
        },
        entries: {
          [STALE_ID]: {
            hit_ledger_version: HIT_LEDGER_VERSION,
            guard_keys: [GUARD_KEY],
            observed_runs: 42,
            last_observed: staleIso,
            legacy_hits: 0,
            wild_hits: 0,
            probe_hits: 1,
            probe_last_outcome: 'proven',
            pending_hits: 0,
            pending_records: [],
            pending_probes: 0,
            swept_probes: 1,
          },
        },
      }
      writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      const r = run(VERIFY, ['--retire'], dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /退役 0 条/, r.all)
      assert.match(r.all, /判据从未在野外命中过任何东西/, `必须说清是「野外出事」这一型缺失:\n${r.all}`)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), 'probe 证据不得把真实条目移出知识库')
      assert.ok(!existsSync(path.join(dir, 'archive', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('条目级：野外出过事（wild_hits > 0）→ 不退役', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-retire-wild-')
    try {
      const st = {
        guards: {
          [GUARD_KEY]: {
            mode: 'blocking',
            shadow_runs: 3,
            shadow_green: 3,
            error_runs: 0,
            hit_ledger_version: HIT_LEDGER_VERSION,
            wild_hits: 1,
            ever_hit: true,
            last_result: 'pass',
          },
        },
        entries: {
          [STALE_ID]: {
            hit_ledger_version: HIT_LEDGER_VERSION,
            guard_keys: [GUARD_KEY],
            observed_runs: 42,
            last_observed: staleIso,
            legacy_hits: 0,
            wild_hits: 3,
            first_wild_hit: '2026-02-01',
            last_wild_hit: '2026-02-01',
            probe_hits: 0,
            pending_hits: 0,
            pending_records: [],
            pending_probes: 0,
          },
        },
      }
      writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      const r = run(VERIFY, ['--retire'], dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /曾野外出事 3 次/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('⑥ 存量回填保守且幂等（不追溯追认 wild）', () => {
  it('分型前的 hits / ever_hit → legacy-unknown：不记 wild、不作退役证据', () => {
    const st = {
      guards: {
        g1: { mode: 'blocking', shadow_runs: 9, shadow_green: 9, ever_hit: true },
      },
      entries: {
        e1: { guard_keys: ['g1'], observed_runs: 42, last_observed: '2026-02-01T00:00:00.000Z', hits: 7, first_hit: '2026-02-01', pending_hits: 0, pending_records: [], swept_hits: 7 },
      },
    }
    const r = normalizeHitLedger(st)
    assert.equal(r.changed, true)
    assert.equal(st.guards.g1.ever_hit, false, '历史 ever_hit 来源不可知（可能是一次探针点的亮）→ 不得继续当 wild 证据')
    assert.equal(st.guards.g1.legacy_ever_hit, 1, '但要留标记（人审能看出「这里曾经有过一说不清的命中」）')
    assert.equal(st.guards.g1.wild_hits, 0)
    assert.equal(st.entries.e1.wild_hits, 0, '历史 hits 不得回填成 wild')
    assert.equal(st.entries.e1.probe_hits, 0)
    assert.equal(st.entries.e1.legacy_hits, 7, '历史命中归 legacy-unknown（既不证明命中过、也不证明没命中过）')
    assert.equal(st.entries.e1.hits, undefined, '旧 hits 字段退役，留着只会诱发「还有谁在读它」')
    assert.equal(st.entries.e1.swept_hits, 7, '已回写的历史事实不动（它是正文里已经落地的对质段）')

    // 幂等：再跑一次不得叠加、不得二次清零
    const again = normalizeHitLedger(st)
    assert.equal(again.changed, false, '回填必须幂等（重复跑不叠加）')
    assert.equal(st.entries.e1.legacy_hits, 7)
    assert.equal(st.guards.g1.legacy_ever_hit, 1)
  })

  it('回填后真的野外出事 → ever_hit 重新置位且不被下次回填清掉', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-backfill-real-')
    try {
      // 造一份「分型前 + ever_hit 曾为真」的存量账，再走一次真实派发
      const st = {
        guards: { [GUARD_KEY]: { mode: 'blocking', shadow_runs: 3, shadow_green: 3, error_runs: 0, ever_hit: true, last_result: 'pass' } },
        entries: { [HIT_ID]: { guard_keys: [GUARD_KEY], observed_runs: 9, last_observed: '2026-01-01T00:00:00.000Z', hits: 3, first_hit: '2026-01-01', pending_hits: 0, pending_records: [] } },
      }
      writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      assert.equal(dispatch(dir).status, 2, '存量账已是 blocking，这次野外捕获照常阻断')
      const g = state(dir).guards[GUARD_KEY]
      assert.equal(g.hit_ledger_version, HIT_LEDGER_VERSION)
      assert.equal(g.legacy_ever_hit, 1, '存量标记留痕')
      assert.equal(g.ever_hit, true, '新的**野外**捕获照常置 ever_hit（保守 ≠ 永久冻结）')
      assert.equal(g.wild_hits, 1, '只记这一次野外出事，历史那几次归 legacy')
      assert.equal(state(dir).entries[HIT_ID].legacy_hits, 3)
      assert.equal(state(dir).entries[HIT_ID].wild_hits, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('回填让「历史 ever_hit 为真」的存量守卫失去退役资格（不追溯追认）', () => {
    const dir = fresh(LIFECYCLE_FIXTURE, 'hit-split-backfill-retire-')
    try {
      const st = {
        guards: { [GUARD_KEY]: { mode: 'blocking', shadow_runs: 3, shadow_green: 3, error_runs: 0, ever_hit: true, last_result: 'pass' } },
        entries: {
          [STALE_ID]: { guard_keys: [GUARD_KEY], observed_runs: 42, last_observed: '2026-02-01T00:00:00.000Z', hits: 0, pending_hits: 0, pending_records: [] },
        },
      }
      writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      const r = run(VERIFY, ['--retire'], dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /退役 0 条/, '存量守卫的历史 ever_hit 不得直接换来退役资格')
      assert.match(r.all, /legacy-unknown/, `须明说来源不可知:\n${r.all}`)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
