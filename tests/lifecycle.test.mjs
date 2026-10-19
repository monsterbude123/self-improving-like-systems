/**
 * lifecycle.test.mjs —— 证伪拍 sweep / 退役 retire / 恢复 restore（node:test，零框架依赖）
 *
 * 口径（票 11 AC 全部 fixture 化）：
 *   - 命中刷新：守卫命中**不改仓内条目**（高频记账只落 gitignored 状态账），`--sweep` 才回写
 *     `recurrence` / `last_verified_at` —— 一次 sweep = 一条 commit 粒度的可审计写入；
 *   - 复发对质：条目**末尾**追加 `### 复发 N · YYYY-MM-DD` + 证据行，历史段落零改动
 *     （用「原行在新文本中按序全数保留」= diff 删除行 0 证明，前置只豁免两个被授权改写的 frontmatter 键）；
 *   - 退役：证据充分才移入 archive（只移动、不改内容、不删正文），证据不足如实跳过；
 *   - 恢复：`--restore` 字节级还原（sha256 比对），重复恢复 / archive 缺文件一律报错不静默；
 *   - 破坏：状态文件损坏、重复退役、账上条目在活动区缺失 —— 全部 exit 1。
 *
 * fixture = tests/fixtures/lifecycle/（整目录拷到临时目录；项目实例配置不动）。
 * 双后端：YAML 读取经 scripts/lib/yaml-lite.mjs（宿主无 js-yaml → 降级后端；容器有 js-yaml → js-yaml）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const VERIFY = path.join(SKILL_ROOT, 'scripts', 'verify.mjs')
const RUNNER = path.join(SKILL_ROOT, 'scripts', 'run-guard.mjs')
const VALIDATE = path.join(SKILL_ROOT, 'scripts', 'validate.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'lifecycle')
const CONFIG = 'config.yaml'
const GUARD_KEY = 'guard-fixture-dup-token'
const HIT_ENTRY = 'LRN-20261016-010-fixture-dup-token.md'
const STALE_ENTRY = 'LRN-20261016-011-fixture-stale-entry.md'
const HIT_ID = 'LRN-20261016-010'
const STALE_ID = 'LRN-20261016-011'
const CROSS_ID = 'ERR-20261016-012'
const VIOLATION = 'chore: touch dup-token twice -> dup-token'
const CLEAN = 'chore: nothing to see here'
/** 只这两个 frontmatter 键被 sweep 授权改写，其余任何行被改都算「历史段落被动了」。 */
const MUTABLE_KEYS = /^(recurrence|last_verified_at):/

/** 整棵目录的「相对路径集合 + 文件内容指纹」（含目录条目）：比只比文件内容更强 ——
 *  取锁本身会建出锁目录，只比文件内容的断言会漏掉「dry-run 其实写了盘」。 */
function treeDigest(dir) {
  const walk = (d, prefix = '') =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        // 审计日志是每次调用的副产物（dry-run 也留痕），内容另由专门断言判；此处只关心「有没有多出目录/文件」
        if (prefix === '' && name === 'audit') return []
        const p = path.join(d, name)
        const rel = prefix ? `${prefix}/${name}` : name
        if (statSync(p).isDirectory()) return [`${rel}/`, ...walk(p, rel)]
        return [`${rel}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`]
      })
  return walk(dir).join('\n')
}

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lifecycle-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

function runCli(cli, args, dir, { config = CONFIG } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, '--config', path.join(dir, config)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const verify = (dir, args, opts) => runCli(VERIFY, args, dir, opts)
const sweep = (dir, extra = []) => verify(dir, ['--sweep', ...extra])
const retire = (dir, extra = []) => verify(dir, ['--retire', ...extra])
const restore = (dir, id, extra = []) => verify(dir, ['--restore', id, ...extra])
const dispatch = (dir, { text = CLEAN } = {}) => runCli(RUNNER, ['--key', GUARD_KEY, '--text', text], dir)

const readState = (dir) => JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'))
const entryText = (dir, name) => readFileSync(path.join(dir, 'entries', name), 'utf8')
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const frontValue = (text, key) => {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}

/** 直接写状态账（退役用例需要「观测久远」的历史事实，派发器只会写今天）。 */
function craftState(dir, entries, guards = RETIRABLE_GUARDS) {
  writeFileSync(path.join(dir, 'guard-state.json'), `${JSON.stringify({ guards, entries }, null, 2)}\n`, 'utf8')
}

/**
 * 「够格提供退役证据」的守卫级账：已升 blocking + 判据**野外出过事**（`ever_hit`）+ 无错误运行。
 * 收紧后的退役判据（schema.md §3.3）要求覆盖守卫满足这些，故默认给这份。
 *
 * ⚠ 必须带 `hit_ledger_version: 2`（wild/probe 两型已归型的账）：缺这个标记的账是**分型前的存量**，
 * 历史 `ever_hit` 来源不可知（可能就是一次人造破坏测试点的亮），回填会**清零**它 —— 那正是本改动的
 * 保守面，不许在「够格」这份夹具里绕过（绕过它的用例见 LEGACY_GUARDS）。
 */
const RETIRABLE_GUARDS = {
  [GUARD_KEY]: {
    mode: 'blocking',
    shadow_runs: 3,
    shadow_green: 3,
    error_runs: 0,
    hit_ledger_version: 2,
    wild_hits: 1,
    first_wild_hit: '2026-01-05',
    probe_hits: 0,
    ever_hit: true,
    last_result: 'pass',
  },
}

/** 分型前的存量守卫级账（无版本标记 + `ever_hit: true`）：来源不可知 → 回填清零、不作 wild 证据。 */
const LEGACY_GUARDS = { [GUARD_KEY]: { mode: 'blocking', shadow_runs: 3, shadow_green: 3, error_runs: 0, ever_hit: true, last_result: 'pass' } }

/** 「不够格」的守卫级账：恒 exit 0 的空守卫 —— 绿灯攒满升了 blocking，但判据从未野外出过事。 */
const VACUOUS_GUARDS = {
  [GUARD_KEY]: {
    mode: 'blocking',
    shadow_runs: 3,
    shadow_green: 3,
    error_runs: 0,
    hit_ledger_version: 2,
    wild_hits: 0,
    probe_hits: 1,
    ever_hit: false,
    last_result: 'pass',
  },
}

/** 观测久远的账：守卫长期覆盖但一次没响（= 退役的正证据）。`wildHits > 0` = 野外出过事，不该退役。 */
function silentLedger(lastObserved, wildHits = 0) {
  return {
    hit_ledger_version: 2,
    guard_keys: [GUARD_KEY],
    observed_runs: 42,
    last_observed: lastObserved,
    legacy_hits: 0,
    wild_hits: wildHits,
    probe_hits: 0,
    pending_hits: 0,
    pending_records: [],
    pending_probes: 0,
    pending_probe_records: [],
    ...(wildHits > 0 ? { first_wild_hit: lastObserved.slice(0, 10), last_wild_hit: lastObserved.slice(0, 10) } : {}),
  }
}

/**
 * 冲刺到 blocking：3 次绿 → 第 4 次起才阻断（拦截权要挣）。
 * 并行跑全套件时宿主 fork 偶发超过守卫 10s 上限 —— 那按契约算「守卫自身异常」（fail-open，不计绿），
 * 重派即可；连续 8 次仍拿不到 blocking 就是真故障，断言在这里炸而不是把异常吞成绿。
 */
function toBlocking(dir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = dispatch(dir)
    assert.equal(r.status, 0, 'shadow 期必须放行')
    if (readState(dir).guards[GUARD_KEY].mode === 'blocking') return
  }
  assert.fail('守卫连续 8 次派发仍未升 blocking（shadow_green 未攒满）')
}

/**
 * 「历史段落零改动」= diff 的删除行数为 0：原文每一行（除两个被授权改写的 frontmatter 键）
 * 都必须按原顺序出现在新文本里。多一行（追加的对质段）不算删除。
 */
function deletedLineCount(before, after) {
  const a = after.split('\n')
  let i = 0
  let deleted = 0
  for (const line of before.split('\n')) {
    if (MUTABLE_KEYS.test(line)) continue
    while (i < a.length && a[i] !== line) i++
    if (i >= a.length) deleted++
    else i++
  }
  return deleted
}

function changedFrontmatterKeys(before, after) {
  const keys = new Set()
  const grab = (t) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(t)
    return m ? m[1].split('\n') : []
  }
  const b = grab(before)
  const af = grab(after)
  if (b.length !== af.length) return ['<frontmatter 行数变了>']
  b.forEach((line, i) => {
    if (line !== af[i]) keys.add(line.split(':')[0])
  })
  return [...keys]
}

describe('证伪拍 · sweep（高频记账在运行时，回写在仓内）', () => {
  it('shadow 期命中同样记账（2026-10-17 补洞：改前 shadow 命中只进守卫级 ever_hit，条目级账在攒 blocking 的窗口期恰好是复发数据黑洞）', () => {
    const dir = freshTmp()
    try {
      // 不升 blocking，直接在 shadow 期喂违规样本：warn-only（exit 0）但证据必须落账
      const r = dispatch(dir, { text: VIOLATION })
      assert.equal(r.status, 0, 'shadow 期命中必须只警告不阻断（放行语义不变）:\n' + r.all)
      assert.match(r.all, /shadow-warn/, 'outcome 须如实报 shadow-warn:\n' + r.all)
      const rec = readState(dir).entries[HIT_ID]
      assert.equal(rec.wild_hits, 1, 'shadow 期命中必须进条目级 wild_hits（shadow-warn 算 wild）:\n' + JSON.stringify(rec))
      assert.equal(rec.probe_hits, 0, 'wild 命中不得落进 probe 账（两型不可混）:\n' + JSON.stringify(rec))
      assert.equal(rec.pending_hits, 1, 'shadow 期命中必须进待回写明细:\n' + JSON.stringify(rec))
      assert.equal(rec.pending_records[0].guard, GUARD_KEY)
      // sweep 回写后与 blocking 期命中走同一条闭环：recurrence +1、账清零
      const s = sweep(dir)
      assert.equal(s.status, 0, `sweep 须成功:\n${s.all}`)
      const recAfter = readState(dir).entries[HIT_ID]
      assert.equal(recAfter.pending_hits, 0, '回写后账须清零')
      assert.equal(frontValue(entryText(dir, HIT_ENTRY), 'recurrence'), '1', 'recurrence 须回写 +1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('守卫命中：仓内条目一字不动，记账只落状态账', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      const before = entryText(dir, HIT_ENTRY)
      const r = dispatch(dir, { text: VIOLATION })
      assert.equal(r.status, 2, `命中判据必须阻断:\n${r.all}`)
      assert.equal(entryText(dir, HIT_ENTRY), before, '高频命中不得改写仓内条目')
      const rec = readState(dir).entries[HIT_ID]
      assert.equal(rec.wild_hits, 1)
      assert.equal(rec.probe_hits, 0, 'wild 命中不进 probe 账')
      assert.equal(rec.pending_hits, 1)
      assert.equal(rec.pending_probes, undefined, 'wild 命中不进 probe 待结账队列（否则 sweep 会把人造违规写进条目正文）')
      assert.equal(rec.pending_records.length, 1)
      assert.equal(rec.pending_records[0].guard, GUARD_KEY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sweep 回写 recurrence +1 与 last_verified_at（带引号，日期类键双后端同款理由）', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      const r = sweep(dir)
      assert.equal(r.status, 0, r.all)
      const after = entryText(dir, HIT_ENTRY)
      assert.equal(frontValue(after, 'recurrence'), '1')
      assert.match(frontValue(after, 'last_verified_at'), /^"\d{4}-\d{2}-\d{2}"$/, '裸日期两条 YAML 后端都判红')
      assert.equal(readState(dir).entries[HIT_ID].pending_hits, 0, '回写后账须清零')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sweep 后条目仍过 validateEntry（改写没破坏契约）', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      assert.equal(sweep(dir).status, 0)
      const v = runCli(VALIDATE, ['--all', path.join(dir, 'entries')], dir)
      assert.equal(v.status, 0, `回写后条目仍须过校验:\n${v.all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多次命中 → 一次 sweep 记 N 段（编号连续，不丢不重）', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      for (let i = 0; i < 3; i++) dispatch(dir, { text: VIOLATION })
      assert.equal(readState(dir).entries[HIT_ID].pending_hits, 3)
      assert.equal(sweep(dir).status, 0)
      const after = entryText(dir, HIT_ENTRY)
      assert.equal(frontValue(after, 'recurrence'), '3')
      assert.deepEqual(after.match(/^### 复发 (\d+) · /gm), ['### 复发 1 · ', '### 复发 2 · ', '### 复发 3 · '])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('幂等：再 sweep 一次零改动、零双记', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      assert.equal(sweep(dir).status, 0)
      const after = entryText(dir, HIT_ENTRY)
      const second = sweep(dir)
      assert.equal(second.status, 0, second.all)
      assert.equal(entryText(dir, HIT_ENTRY), after, '重复 sweep 不得双记')
      assert.match(second.all, /无待回写命中/, second.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('崩溃恢复：条目已写、账未清（inflight 仍在）→ 收尾不双记', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      assert.equal(sweep(dir).status, 0)
      // 模拟崩在「条目已写、状态未清」：账上补回 inflight（起点 0 + 1 笔命中），条目已是回写后状态。
      //
      // ⚠ 日期必须取**条目里实际写进去的那个日期**，不能硬编码（2026-10-17 修）：
      // 上一步 sweep 写的是「今天」，而 already-applied 判据（verify.mjs:300）比对
      // `last_verified_at: "<records 末条 date>"` —— 硬编码日期一旦与真实今天跨日不等，
      // 判据就判不出「已回写」，用例必然红。写这个用例当天绿、隔天必红（实测）。
      // ⚠⚠ 取值必须**剥掉源码里的引号**（2026-10-17 同日二次修正）：frontmatter 存的是
      // `last_verified_at: "2026-10-17"`（裸日期两后端解法相反，故强制带引号），
      // 直接把读回的 `"2026-10-17"` 当 date 塞进 records，写回时又包一层 → `""2026-10-17""`，
      // 判据照样匹配不上，且症状（双引号）离真因（引号）很远。日期一律用 toISOString 现场取。
      const appliedDate = new Date().toISOString().slice(0, 10)
      assert.equal(
        frontValue(entryText(dir, HIT_ENTRY), 'last_verified_at')?.replace(/^"|"$/g, ''),
        appliedDate,
        '上一步 sweep 必须已把今天写进 last_verified_at（本用例前提；不一致说明回写坏了，先修产品）',
      )
      const applied = { guard: GUARD_KEY, date: appliedDate, at: `${appliedDate}T00:00:00.000Z` }
      const st = readState(dir)
      st.entries[HIT_ID].pending_hits = 1
      st.entries[HIT_ID].pending_records = [applied]
      st.entries[HIT_ID].sweep_inflight = {
        prev_recurrence: 0,
        records: [applied],
      }
      writeFileSync(path.join(dir, 'guard-state.json'), JSON.stringify(st, null, 2), 'utf8')
      const before = entryText(dir, HIT_ENTRY)
      const r = sweep(dir)
      assert.equal(r.status, 0, r.all)
      assert.equal(entryText(dir, HIT_ENTRY), before, '已回写过的不许二次回写')
      assert.match(r.all, /already-applied/, r.all)
      const rec = readState(dir).entries[HIT_ID]
      assert.equal(rec.pending_hits, 0, '账仍须清零')
      assert.equal(rec.sweep_inflight, undefined, 'inflight 必须收尾清除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('崩溃恢复：条目还没写、inflight 在 → 按账上起点重放（不吞账）', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      // 模拟崩在「记账已落、条目未写」：账上是 inflight + pending，条目仍是回写前状态。
      craftState(dir, {
        [HIT_ID]: {
          guard_keys: [GUARD_KEY],
          observed_runs: 4,
          last_observed: '2026-10-16T00:00:00.000Z',
          hit_ledger_version: 2,
          legacy_hits: 0,
          wild_hits: 1,
          first_wild_hit: '2026-10-16',
          probe_hits: 0,
          pending_hits: 1,
          pending_records: [{ guard: GUARD_KEY, date: '2026-10-16', at: '2026-10-16T00:00:00.000Z' }],
          sweep_inflight: { prev_recurrence: 0, records: [{ guard: GUARD_KEY, date: '2026-10-16', at: '2026-10-16T00:00:00.000Z' }] },
        },
      })
      const r = sweep(dir)
      assert.equal(r.status, 0, r.all)
      const after = entryText(dir, HIT_ENTRY)
      assert.equal(frontValue(after, 'recurrence'), '1', '未写过的必须补写（命中不许被吞）')
      assert.match(after, /^### 复发 1 · /m)
      assert.equal(readState(dir).entries[HIT_ID].sweep_inflight, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--dry-run 零写盘：条目与状态账都不动', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      const stateBefore = readFileSync(path.join(dir, 'guard-state.json'), 'utf8')
      const entryBefore = entryText(dir, HIT_ENTRY)
      const treeBefore = treeDigest(dir)
      const r = sweep(dir, ['--dry-run'])
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /would-sweep/, r.all)
      assert.equal(entryText(dir, HIT_ENTRY), entryBefore)
      assert.equal(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'), stateBefore)
      // 整树也要一致（票 H2）：取锁会建出锁目录，只比文件内容会漏掉「dry-run 其实落了盘」
      assert.equal(treeDigest(dir), treeBefore, '--dry-run 连目录都不许新增（锁目录也算写盘）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无状态文件时 sweep 是零副作用的 no-op（不是故障）', () => {
    const dir = freshTmp()
    try {
      const r = sweep(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /无状态文件/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('复发对质记录（append-only · 历史段落零改动）', () => {
  it('对质段追加在正文末尾，编号接在既有 recurrence 之后', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      const before = entryText(dir, HIT_ENTRY)
      assert.equal(sweep(dir).status, 0)
      const after = entryText(dir, HIT_ENTRY)
      assert.equal(deletedLineCount(before, after), 0, '历史段落删除行数必须为 0（append-only）')
      assert.deepEqual(changedFrontmatterKeys(before, after).sort(), ['last_verified_at', 'recurrence'], '只许改这两个键')
      assert.ok(after.trimEnd().endsWith('以上各段按命中顺序追加在正文末尾，既有内容按字节原样保留。'), '对质段须落在正文末尾')
      assert.match(after, /^### 复发 1 · \d{4}-\d{2}-\d{2}$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('对质段含证据行（守卫 key + 拦截形态 + 回写前后值）', () => {
    const dir = freshTmp()
    try {
      toBlocking(dir)
      dispatch(dir, { text: VIOLATION })
      assert.equal(sweep(dir).status, 0)
      const after = entryText(dir, HIT_ENTRY)
      assert.match(after, new RegExp(`- 证据：守卫 \`${GUARD_KEY}\` 于 \\d{4}-\\d{2}-\\d{2} 命中判据被拦截（blocking · exit 2）。`))
      assert.match(after, /- 回写：本次 sweep 记 `recurrence` 0 → 1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('条目 recurrence 已有值时，对质段编号从既有值续上（不重排历史）', () => {
    const dir = freshTmp()
    try {
      // ERR-20261016-012 起始 recurrence=4：命中一次后应是 5，对质段标题 `### 复发 5 · …`
      craftState(dir, {
        [CROSS_ID]: {
          guard_keys: [GUARD_KEY],
          observed_runs: 3,
          last_observed: '2026-10-16T00:00:00.000Z',
          hit_ledger_version: 2,
          legacy_hits: 0,
          wild_hits: 1,
          first_wild_hit: '2026-10-16',
          probe_hits: 0,
          pending_hits: 1,
          pending_records: [{ guard: GUARD_KEY, date: '2026-10-16', at: '2026-10-16T00:00:00.000Z' }],
        },
      })
      const before = entryText(dir, `${CROSS_ID}-fixture-cross.md`)
      assert.equal(sweep(dir).status, 0)
      const after = entryText(dir, `${CROSS_ID}-fixture-cross.md`)
      assert.equal(deletedLineCount(before, after), 0)
      assert.match(after, /^### 复发 5 · /m, '编号接在既有 recurrence=4 之后')
      assert.equal(frontValue(after, 'recurrence'), '5')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('退役（只进 archive · 不改内容 · 证据不足不退役）', () => {
  it('证据充分（长期被覆盖且从不命中）→ 移入 archive，内容字节级不变', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const beforeHash = sha(path.join(dir, 'entries', STALE_ENTRY))
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /退役 1 条/, r.all)
      assert.ok(!existsSync(path.join(dir, 'entries', STALE_ENTRY)), '活动区不应再有该条目')
      const archived = path.join(dir, 'archive', STALE_ENTRY)
      assert.ok(existsSync(archived), '退役区须有该条目')
      assert.equal(sha(archived), beforeHash, '退役只移动不改内容（append-only，不删正文）')
      assert.ok(readState(dir).entries[STALE_ID].archived_at, '退役须在账上留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无观测账（从未被任何守卫覆盖）→ 保守跳过并说明，零变更', () => {
    const dir = freshTmp()
    try {
      // 011 给「近期仍在派发」（不退役），013 完全不在账上（没证据）—— 两者都不许退役。
      craftState(dir, { [STALE_ID]: silentLedger(new Date().toISOString()) })
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /LRN-20261016-013/, r.all)
      assert.match(r.all, /状态账无观测记录/, '「没证据」必须与「无人命中」区分开')
      assert.ok(existsSync(path.join(dir, 'entries', 'LRN-20261016-013-fixture-unwatched.md')), '未看守条目不得被退役')
      assert.ok(!existsSync(path.join(dir, 'archive')), '无一可退役时不许造退役区')
      assert.match(r.all, /退役 0 条/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('曾野外出事（wild_hits > 0）→ 不退役（守卫在野外响过就不是「长期不响」）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, {
        [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z'),
        [CROSS_ID]: silentLedger('2026-02-01T00:00:00.000Z', 5),
      })
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /曾野外出事 5 次/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', `${CROSS_ID}-fixture-cross.md`)))
      assert.ok(!existsSync(path.join(dir, 'archive', `${CROSS_ID}-fixture-cross.md`)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('守卫近期仍在派发 → 不退役', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger(new Date().toISOString()) })
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /守卫近期仍在派发/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('有待回写命中 → 拒绝退役（先把账算清）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, {
        [STALE_ID]: { ...silentLedger('2026-02-01T00:00:00.000Z'), pending_hits: 2, pending_records: [{ guard: GUARD_KEY, date: '2026-10-16' }] },
      })
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /有 2 笔命中未回写/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--dry-run 零写盘（不退役、不造退役区、不改账）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const stateBefore = readFileSync(path.join(dir, 'guard-state.json'), 'utf8')
      const r = retire(dir, ['--dry-run'])
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /would-retire/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
      assert.ok(!existsSync(path.join(dir, 'archive')))
      assert.equal(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'), stateBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('退役区缺省推导：config 不写 archive_dir 时落 <entries_dir>/archive/', () => {
    const dir = freshTmp()
    try {
      const cfg = readFileSync(path.join(dir, CONFIG), 'utf8').replace(/^.*archive_dir.*\n/m, '')
      writeFileSync(path.join(dir, 'config-no-archive.yaml'), cfg, 'utf8')
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = verify(dir, ['--retire', '--dry-run'], { config: 'config-no-archive.yaml' })
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /entries[\\/]archive[\\/]/, `缺省退役区应是 entries/archive/:\n${r.all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('空守卫不得清空知识库（证伪机制被反向武器化的堵口 · 票 H1）', () => {
  /** 往 fixture registry 追加一条空守卫（不污染 fixture 本体：每次用例都在 tmp 副本上改）。 */
  function appendGuard(dir, entry) {
    const p = path.join(dir, 'registry.yaml')
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n  - key: guard-fixture-vacuous\n`
      + `    args: ['scripts/run-guard.mjs', '--key', 'guard-fixture-vacuous']\n`
      + `    when: always\n    kind: gate\n    path: 'guards/vacuous.sh'\n`
      + `    command: [${entry.command}]\n    covered_entries: ['${STALE_ID}', '${HIT_ID}']\n`
      + `    mode: shadow\n    shadow_required: 3\n`, 'utf8')
  }

  it('空守卫（恒 exit 0 · 判据从未野外出过事）→ 不退役它覆盖的真实条目', () => {
    const dir = freshTmp()
    try {
      // 这份账正是收紧前的形状：绿灯攒满升 blocking、观测 42 次、久未命中 → 旧判据会整批退役。
      // 它另有 probe_hits=1：只有我们自己造的破坏测试点亮过它，wild 一分没有 —— 同样不退役。
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') }, VACUOUS_GUARDS)
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /判据从未在野外命中过任何东西/, `必须说明「沉默不含信息量」:\n${r.all}`)
      assert.match(r.all, /退役 0 条/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), '空守卫不得把它覆盖的真实条目移出知识库')
      assert.ok(!existsSync(path.join(dir, 'archive')), '无可退役项时不得造退役区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空守卫（command 起不来）→ 派发只记 observed_error_runs，observed_runs 恒 0 → 不退役', () => {
    const dir = freshTmp()
    try {
      appendGuard(dir, { command: "'exit', '0'" }) // 审计原文的 `command: exit 0`：根本不是可执行文件
      for (let i = 0; i < 3; i++) {
        const d = runCli(RUNNER, ['--key', 'guard-fixture-vacuous', '--text', CLEAN], dir)
        assert.equal(d.status, 0, `守卫自身异常必须 fail-open 放行:\n${d.all}`)
      }
      const rec = readState(dir).entries[STALE_ID]
      assert.equal(rec.observed_runs, 0, '判据没跑起来不得发放 observed_runs')
      assert.equal(rec.observed_error_runs, 3, '三次异常派发须单列在 observed_error_runs')
      assert.equal(rec.last_observed, undefined, '异常派发不刷新 last_observed（否则会把「久未观测」洗掉）')
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /状态账无观测记录/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), '起不来的守卫不得退役它声明覆盖的条目')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('shadow-only 覆盖守卫（没挣到拦截权）→ 不退役', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') }, {
        [GUARD_KEY]: { mode: 'shadow', shadow_runs: 1, shadow_green: 1, hit_ledger_version: 2, wild_hits: 0, ever_hit: false },
      })
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /都还在 shadow/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('观测账无 guard_keys（无人声明覆盖）→ 不退役', () => {
    const dir = freshTmp()
    try {
      const rec = silentLedger('2026-02-01T00:00:00.000Z')
      delete rec.guard_keys
      craftState(dir, { [STALE_ID]: rec }, RETIRABLE_GUARDS)
      const r = retire(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /未登记覆盖守卫/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('真守卫（野外出过事）→ 同一份久远观测账仍可退役（收紧不误伤）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') }, RETIRABLE_GUARDS)
      assert.equal(retire(dir).status, 0)
      assert.ok(existsSync(path.join(dir, 'archive', STALE_ENTRY)), '够格的证据仍须能退役，否则收紧就成了永久冻结')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('run-guard --all --dry-run：逐条标 evidence 档位，零 spawn 零写盘', () => {
    const dir = freshTmp()
    try {
      appendGuard(dir, { command: "'exit', '0'" })
      runCli(RUNNER, ['--key', 'guard-fixture-vacuous', '--text', CLEAN], dir)
      const before = readFileSync(path.join(dir, 'guard-state.json'), 'utf8')
      const r = runCli(RUNNER, ['--all', '--dry-run', '--json'], dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /evidence=no-evidence/, `从未派发的守卫:\n${r.all}`)
      assert.match(r.all, /evidence=debt/, `只出异常没攒够绿的守卫:\n${r.all}`)
      assert.match(r.all, /guard-fixture-dup-token/, r.all)
      const rows = JSON.parse(r.stdout).guards
      assert.ok(rows.length >= 2)
      assert.ok(rows.every((x) => ['strong', 'weak', 'debt', 'no-evidence'].includes(x.evidence)))
      assert.equal(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'), before, '--dry-run 零写盘')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('恢复（可逆 · 字节级还原）', () => {
  it('restore 后条目字节级还原（sha256 相等），账上退役标记被清', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const original = sha(path.join(dir, 'entries', STALE_ENTRY))
      assert.equal(retire(dir).status, 0)
      const r = restore(dir, STALE_ID)
      assert.equal(r.status, 0, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), 'restore 后回到活动区')
      assert.ok(!existsSync(path.join(dir, 'archive', STALE_ENTRY)), '退役区不该留残骸')
      assert.equal(sha(path.join(dir, 'entries', STALE_ENTRY)), original, 'restore 必须字节级还原')
      const rec = readState(dir).entries[STALE_ID]
      assert.equal(rec.archived_at, undefined, '退役标记须清（否则重复退役判定会误判）')
      assert.ok(rec.restored_at, '恢复须留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('退役 → 恢复 → 再退役：可反复来回，字节不变', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const original = sha(path.join(dir, 'entries', STALE_ENTRY))
      for (let round = 0; round < 2; round++) {
        assert.equal(retire(dir).status, 0, `第 ${round + 1} 轮退役`)
        assert.equal(restore(dir, STALE_ID).status, 0, `第 ${round + 1} 轮恢复`)
        assert.equal(sha(path.join(dir, 'entries', STALE_ENTRY)), original)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('活动区已存在同名条目 → restore 报错且零变更（不许覆盖）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      assert.equal(retire(dir).status, 0)
      writeFileSync(path.join(dir, 'entries', STALE_ENTRY), '人工改过的内容\n', 'utf8')
      const r = restore(dir, STALE_ID)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /活动区已存在/, r.all)
      assert.equal(entryText(dir, STALE_ENTRY), '人工改过的内容\n', '拒绝覆盖 = 零变更')
      assert.ok(existsSync(path.join(dir, 'archive', STALE_ENTRY)), '退役区原件须保留')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('破坏测试（红向 · 必须报错而非静默）', () => {
  it('archive 缺文件 → restore exit 1 并说明', () => {
    const dir = freshTmp()
    try {
      mkdirSync(path.join(dir, 'archive'), { recursive: true })
      const r = restore(dir, STALE_ID)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /退役区无此条目/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重复退役：退役区已有同名文件 → exit 1，不覆盖历史归档', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      mkdirSync(path.join(dir, 'archive'), { recursive: true })
      const pre = path.join(dir, 'archive', STALE_ENTRY)
      writeFileSync(pre, '历史归档内容\n', 'utf8')
      const r = retire(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /退役目标已存在/, r.all)
      assert.equal(readFileSync(pre, 'utf8'), '历史归档内容\n', '既有归档内容一字不动')
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), '失败时活动区条目须原样保留')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('状态文件损坏（非法 JSON）→ sweep / retire 均 exit 1，不静默当空账', () => {
    const dir = freshTmp()
    try {
      writeFileSync(path.join(dir, 'guard-state.json'), '{ 这不是 JSON', 'utf8')
      const sw = sweep(dir)
      assert.equal(sw.status, 1, sw.all)
      assert.match(sw.all, /状态文件损坏/, sw.all)
      const rt = retire(dir)
      assert.equal(rt.status, 1, rt.all)
      assert.match(rt.all, /状态文件损坏/, rt.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('状态文件结构非法（entries 是数组）→ exit 1', () => {
    const dir = freshTmp()
    try {
      writeFileSync(path.join(dir, 'guard-state.json'), JSON.stringify({ guards: {}, entries: [] }), 'utf8')
      const r = retire(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /entries 段结构非法/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('状态文件缺失 → retire exit 1（没有账就没有「无人命中」证据）', () => {
    const dir = freshTmp()
    try {
      const r = retire(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /状态文件不存在/, r.all)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), '全部条目须留在活动区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('账上有待回写命中、条目却不在活动区 → sweep exit 1（不许吞掉命中）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, {
        [STALE_ID]: { ...silentLedger('2026-02-01T00:00:00.000Z'), pending_hits: 1, pending_records: [{ guard: GUARD_KEY, date: '2026-10-16' }] },
      })
      rmSync(path.join(dir, 'entries', STALE_ENTRY))
      const r = sweep(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /活动区不存在/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用法错误：无动作 / 双动作 / --restore 缺 ID → exit 2', () => {
    const dir = freshTmp()
    try {
      assert.equal(verify(dir, []).status, 2)
      assert.equal(verify(dir, ['--sweep', '--retire']).status, 2)
      assert.equal(verify(dir, ['--restore']).status, 2)
      assert.equal(verify(dir, ['--nope']).status, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('通用性（零项目耦合）', () => {
  it('verify.mjs 不含本仓项目物（路径 / 域名 / 门禁名硬编码）', () => {
    // 全目录扫描面与 banned 名单的**单一归宿** = approve.test.mjs 的「通用性」那条
    // （2026-10-16 F5：点名式名单会漏文件）。此处只保留 verify 专属的 destructive 断言。
    // 判注释一律经共用的 stripComments（「注释里的不算」—— 否则「修掉硬编码后在注释里
    // 说明『此前此处硬编码本仓 X』」本身就会让门禁变红，修复动作与守卫互锁）。
    const banned = [/\.learnings\b/, /ai-short-studio/, /vvicat/i, /devbox/, /D13-entry-guard-binding/, /touchesExperienceSystem/]
    const src = stripComments(readFileSync(VERIFY, 'utf8'))
    for (const re of banned) assert.ok(!re.test(src), `verify.mjs 命中项目物 ${re}（注释已剥离 ⇒ 可执行/用户可见字符串）`)
  })

  it('退役/恢复只做整文件移动，无删除路径（append-only）', () => {
    const src = readFileSync(VERIFY, 'utf8')
    const destructive = [...src.matchAll(/\b(unlinkSync|rmSync|rmdirSync|truncateSync)\s*\(/g)].map((m) => m[1])
    assert.equal(destructive.length, 0, `发现删除类调用: ${destructive.join(', ')}`)
  })

  it('退役条目不误判：退役后活动区 validate --all 仍全绿（退役区不在扫描面）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      assert.equal(retire(dir).status, 0)
      const v = runCli(VALIDATE, ['--all', path.join(dir, 'entries')], dir)
      assert.equal(v.status, 0, `退役后活动区须仍全绿:\n${v.all}`)
      assert.equal(readdirSync(path.join(dir, 'archive')).length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录级文件（README.md）不被当成条目退役', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      assert.equal(retire(dir).status, 0)
      assert.ok(existsSync(path.join(dir, 'entries', 'README.md')), '目录级文件不许被退役')
      assert.ok(!statSync(path.join(dir, 'entries', 'README.md')).isDirectory())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== 撞号 ID：观测 / 退役 / restore 三路都不得污染（架构审计 F2/B2 · 2026-10-16）=====
describe('撞号 ID 不产生污染', () => {
  /** 在 fixture 上造一对**共用 ID** 的条目（撞号），返回该 ID。 */
  function seedCollision(dir) {
    const id = 'LRN-20261016-777'
    const tpl = readFileSync(path.join(dir, 'entries', STALE_ENTRY), 'utf8')
    writeFileSync(path.join(dir, 'entries', `${id}-alpha.md`), tpl, 'utf8')
    writeFileSync(path.join(dir, 'entries', `${id}-beta.md`), tpl, 'utf8')
    return id
  }

  it('findEntryFile 对撞号 ID 不静默取第一个（单数定位必返 null）', async () => {
    const dir = freshTmp()
    try {
      const id = seedCollision(dir)
      const v = await import('../scripts/verify.mjs')
      assert.equal(v.findEntryFiles(path.join(dir, 'entries'), id).length, 2, '复数定位必须看到两个候选')
      assert.equal(v.findEntryFile(path.join(dir, 'entries'), id), null, '单数定位遇撞号必须返回 null（绝不静默取首个）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--sweep 遇撞号硬失败：命中绝不回写进任意一条正文', () => {
    const dir = freshTmp()
    try {
      const id = seedCollision(dir)
      // 账上有待回写命中（pending_records 非空）→ sweep 必须动手回写
      const rec = silentLedger('2026-10-16T00:00:00.000Z', 2)
      rec.pending_hits = 2
      rec.pending_records = [{ guard: GUARD_KEY, date: '2026-10-16', at: '2026-10-16T00:00:00.000Z' }]
      craftState(dir, { [id]: rec })
      const before = readFileSync(path.join(dir, 'entries', `${id}-alpha.md`), 'utf8')
      const r = sweep(dir)
      assert.equal(r.status, 1, `撞号 ID 的 sweep 必须硬失败（把 A 的命中写进 B 就是污染）:\n${r.all}`)
      assert.match(r.all, /撞号/, `报错须点明撞号:\n${r.all}`)
      assert.equal(readFileSync(path.join(dir, 'entries', `${id}-alpha.md`), 'utf8'), before, '撞号时正文一个字都不许被改')
      assert.ok(!readFileSync(path.join(dir, 'entries', `${id}-beta.md`), 'utf8').includes('recurrence: 2'), '命中不得被记到另一条上')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--retire 遇撞号跳过该组并说明理由（不拿混合证据退役）', () => {
    const dir = freshTmp()
    try {
      const id = seedCollision(dir)
      craftState(dir, { [id]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = retire(dir, ['--json'])
      assert.equal(r.status, 0, `撞号只该跳过、不该整轮失败:\n${r.all}`)
      const rows = JSON.parse(r.stdout).report.filter((x) => String(x.name ?? '').startsWith(id))
      assert.equal(rows.length, 2, '两个撞号文件都须出现在报表里')
      for (const row of rows) {
        assert.equal(row.status, 'skipped', '撞号条目不得退役')
        assert.match(row.reason, /撞号/, `跳过理由须点明撞号:\n${JSON.stringify(row)}`)
      }
      assert.ok(existsSync(path.join(dir, 'entries', `${id}-alpha.md`)), '撞号条目须留在活动区')
      assert.ok(existsSync(path.join(dir, 'entries', `${id}-beta.md`)), '撞号条目须留在活动区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--restore 遇退役区撞号硬失败：绝不搬回「别的」那条', () => {
    const dir = freshTmp()
    try {
      const id = seedCollision(dir)
      // 两条都进退役区（模拟撞号条目先后被退役的历史形态）
      mkdirSync(path.join(dir, 'archive'), { recursive: true })
      for (const s of ['alpha', 'beta']) {
        renameSync(path.join(dir, 'entries', `${id}-${s}.md`), path.join(dir, 'archive', `${id}-${s}.md`))
      }
      const r = verify(dir, ['--restore', id])
      assert.equal(r.status, 1, `撞号 ID 的 restore 必须硬失败（静默取首个 = 搬回别的条目）:\n${r.all}`)
      assert.match(r.all, /撞号/, `报错须点明撞号:\n${r.all}`)
      // 关键：一条都不许被搬回活动区
      assert.equal(readdirSync(path.join(dir, 'archive')).filter((f) => f.startsWith(id)).length, 2, '两条都必须留在退役区')
      assert.equal(readdirSync(path.join(dir, 'entries')).filter((f) => f.startsWith(id)).length, 0, '活动区不得出现任何一条')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非撞号 ID 行为不受影响（唯一性收紧不得误伤正常路径）', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      assert.equal(retire(dir).status, 0, '唯一 ID 仍须能正常退役（否则收紧就成了永久冻结）')
      assert.ok(existsSync(path.join(dir, 'archive', STALE_ENTRY)), '唯一 ID 的退役区须有该条目')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== 退役的跨副本语义（架构审计 F7/B4 · 2026-10-16）=====
describe('退役跨副本语义（退役区不入库 = 拒绝退役）', () => {
  /** 把 fixture 目录变成一个真 git 仓，并按 need 参数写入 .gitignore（决定退役区是否入库）。 */
  function gitInitWithIgnore(dir, ignoreBody) {
    const g = (args) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(g(['init', '-q']).status, 0, 'fixture 须能 git init（跨副本判据以真 git 为准）')
    writeFileSync(path.join(dir, '.gitignore'), ignoreBody, 'utf8')
  }

  it('退役区被 git 排除 → 退役被拒（否则提交后别人那边条目无副本地消失）', () => {
    const dir = freshTmp()
    try {
      gitInitWithIgnore(dir, 'archive/\n')
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = retire(dir)
      assert.equal(r.status, 1, `退役区不入库时必须拒绝退役:\n${r.all}`)
      assert.match(r.all, /git 排除/, `报错须说明「退役区不入库」这一跨副本后果:\n${r.all}`)
      assert.ok(existsSync(path.join(dir, 'entries', STALE_ENTRY)), '被拒后条目必须留在活动区（零副作用）')
      assert.ok(!existsSync(path.join(dir, 'archive', STALE_ENTRY)), '被拒后不得留下归档残骸')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--dry-run 也照样拦（dry-run 的用途正是让人在动手前看到这类条件）', () => {
    const dir = freshTmp()
    try {
      gitInitWithIgnore(dir, 'archive/\n')
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = retire(dir, ['--dry-run'])
      assert.equal(r.status, 1, `--dry-run 不许绕过跨副本检查:\n${r.all}`)
      assert.match(r.all, /git 排除/, `报错须说明跨副本后果:\n${r.all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('退役区入库（未被排除）→ 退役照常放行（守卫不得把正常路径也堵死）', () => {
    const dir = freshTmp()
    try {
      gitInitWithIgnore(dir, 'node_modules/\n')
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = retire(dir)
      assert.equal(r.status, 0, `退役区入库时须放行（堵死正常路径就是守卫写坏了）:\n${r.all}`)
      assert.ok(existsSync(path.join(dir, 'archive', STALE_ENTRY)), '放行后条目应已移入退役区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 git 目录（普通项目用法）→ 放行，不误伤', () => {
    const dir = freshTmp()
    try {
      craftState(dir, { [STALE_ID]: silentLedger('2026-02-01T00:00:00.000Z') })
      const r = retire(dir)
      assert.equal(r.status, 0, `非 git 目录无从谈跨副本跟踪，不许误伤:\n${r.all}`)
      assert.ok(existsSync(path.join(dir, 'archive', STALE_ENTRY)), '非 git 目录须照常退役')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('archiveIsShareable 判据本身可证（防守卫恒绿/恒红）', async () => {
    const dir = freshTmp()
    try {
      const v = await import('../scripts/verify.mjs')
      gitInitWithIgnore(dir, 'archive/\n')
      const ignored = v.archiveIsShareable(path.join(dir, 'archive'), dir)
      assert.equal(ignored.ignored, true, `排除的退役区必须判为不可共享: ${JSON.stringify(ignored)}`)
      const tracked = v.archiveIsShareable(path.join(dir, 'entries'), dir)
      assert.equal(tracked.ignored, false, `入库目录必须判为可共享: ${JSON.stringify(tracked)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
