#!/usr/bin/env node
/**
 * trace.mjs —— 运维验收与止损对账 CLI（通用技能，零项目耦合，宿主可跑，**只读**）
 *
 * 角色：把「经验系统到底有没有真的跑起来」这件事，从人读日志变成一条可复跑的只读命令。
 *   一条命令再生完整 trace：**条目 ID → 关联事件记录 → 守卫登记 → 守卫运行记录 → recurrence /
 *   last_verified_at 时间线**，每个结论都带指向原始审计 / 状态记录的**行级引用**（`文件:行号`）。
 *
 * 用法：
 *   node trace.mjs [--id <ID>] [--json] [--config <p>] [--project-dir <d>]
 * 退出码：0 = 通过（≥1 条**真实**条目自然走完六拍，全链可追溯）
 *         1 = 触发冻结（无任何条目走完六拍 —— 见 references/stoploss.md）
 *         2 = 用法错误 / 数据源非法（配置指向夹具目录、registry 或状态文件损坏）
 *
 * ===== 数据源纪律（本命令的全部可信度都压在这一条上）=====
 *   只读五处，且**只读这五处**：① 条目区 `storage.entries_dir`（frontmatter 源码行）
 *   ② 事件库 `storage.events_dir`（按日 JSONL 分片）③ 注册表 `storage.registry`
 *   ④ 守卫运行时状态 `storage.guard_state` ⑤ 注入/读路径审计 `storage.audit_log`。
 *   **禁止**拿测试夹具冒充真实数据：任何落在夹具特征路径（fixtures / tests / __tests__ /
 *   test-data / node_modules 目录段，或 `*.example.*` 文件名）的文件在报告里被**显式排除并列出**
 *   （谁被排除、为什么，见报告「排除的夹具路径」段）；若**配置声明的数据源本身**落在夹具目录，
 *   不出报告、直接 exit 2 —— 用夹具当事实源的报告比没有报告更危险。
 *
 * ===== 六拍 = 判定「系统真的活着」的最小充分条件（与落盘重放同一口径）=====
 *   拍1 事件（失效形态被捕获）→ 拍2 条目（有 guard_ref 的正式条目）
 *   → 拍3 守卫登记（registry 里存在该 key 且 covered_entries 覆盖本条目）
 *   → 拍4 守卫运行（last_run 非空 + shadow 已挣到 blocking）
 *   → 拍5 拦截命中（**两型**判据：wild 命中 `wild_hits ≥ 1` + `first_wild_hit`；
 *                    否则 probe 命中 `probe_hits ≥ 1 && probe_last_outcome == proven`
 *                    && 有效期 ≤ `retire.cycle_days` && `last_observation == 'healthy'`）
 *   → 拍6 回写（与拍5 同源分型：wild 链 = sweep 已抬 recurrence / 刷新 last_verified_at / 正文有对质段
 *                    + `swept_hits > 0`；probe-only 链 = probe 账已由 sweep 结清（`swept_probes > 0`
 *                    且 `pending_probes == 0`），**不要求**动条目正文）
 *   六拍全绿 = 该条目「自然走完」（没人手工捏造数据就能对上）；**任一缺失即触发冻结**。
 *
 *   ⚠ **拍6 必须跟着拍5 一起改**（本次拆源最容易漏的一处）：拍6 原本依赖 `swept_hits > 0`，
 *   而它从 `pending_hits` 派生、`pending_hits` 只在 wild 命中时递增。若只把拍5 放宽到接受 probe，
 *   probe-only 的链会从「拍5 红」变成「拍6 红」，整条链照样红 —— 这次改动等于完全无效。
 *
 * ===== probe 证据的效力（与退役链同源纪律）=====
 *   probe = 人造的破坏测试（run-guard.mjs --probe，stoploss.md §4 解冻那步），**不是野外复发**。
 *   它能证明「守卫确实抓得住东西」，所以拍5 接受它作为替代路径；但它有三条硬边界，
 *   与退役链的保守纪律同源（一个自证的守卫不许退役真实条目）：
 *     - 必须**末次**探针结论为 `proven`（一次「没拦住」就把它的探针证据打回红）；
 *     - 有效期 ≤ `retire.cycle_days`（同一个尺子，不另立数字：守卫判据会随代码漂移，
 *       半年前的探针不能证明今天它还拦得住）；
 *     - `last_observation == 'healthy'`（**末次**派发判据真的跑起来了；2026-10-17 起替代原先的
 *       `observed_error_runs == 0` —— 后者是累计只增不减的，拿它当门会让守卫异常过一次就把它
 *       覆盖的条目**永久**锁死，且与 schema.md §3.1「该字段不参与退役证据」自相矛盾。
 *       旧账无该字段时回退旧判据，不追溯洗白）。
 *
 * ===== 事件 ↔ 条目的两种链接强度（报告里必须看得出区别）=====
 *   强（`entry-id`）：事件行的 `entry_id` 直接等于本条目 ID（schema.md §2 契约字段）。
 *   弱（`date-overlap`）：本条目命中日区间内出现过 `gate_block` 事件 —— **只是时间共现，不是因果**，
 *   报告按弱链接标注，不因其单独把拍1 判绿当强证据；两条都没有 → 拍1 红。
 *
 * ===== 只读保证 =====
 *   本文件全程**零写操作**：不写状态、不写审计、不改条目、不改注册表，连 fail-open 留痕都没有
 *   （对账命令把审计当数据源读，自己再往里写就等于污染证据面）。
 *
 * ===== YAML 双后端 / O(1) spawn 纪律 =====
 *   YAML 一律经 ./lib/yaml-lite.mjs 读取（与本技能其余脚本同源，判据不写第二版）；
 *   全程零 spawn（纯 fs 读取 + 配置链里常数次的 git rev-parse），不按文件起子进程。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadContext } from './inject.mjs'
import { parseYaml } from './lib/yaml-lite.mjs'
import { extractFrontmatter, NON_ENTRY_BASENAMES } from './validate.mjs'
import { entryIdFromName, retireCycleDays } from './verify.mjs'
import { DEFAULT_SHADOW_RUNS, guardStatePath, registryPath } from './run-guard.mjs'

/** 夹具特征目录段（小写比对）—— 命中即视为「不是真实运行数据」。 */
const FIXTURE_DIR_SEGMENTS = new Set(['fixtures', 'fixture', '__fixtures__', 'tests', '__tests__', 'test-data', 'testdata'])
/** 夹具特征文件名（技能自带的模板 / 示例 —— 它们是契约样例，不是某仓的运行事实）。 */
const FIXTURE_BASENAME_RE = /(^example[-_.])|(\.example\.[a-z0-9]+$)/i

/**
 * 判断一个「相对某根目录的路径」是否带夹具特征。
 * **刻意只看根目录以下的路段**：项目本身可能装在含 `tests` 的父路径下（临时目录尤其如此），
 * 把仓库外的祖先目录算进来会把真实数据全部误杀。
 * @param {string} relPath 相对路径（`/` 分隔）
 * @returns {string|null} 排除理由；非夹具返回 null
 */
export function fixtureReason(relPath) {
  const segs = String(relPath).replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  for (const s of segs) {
    const low = s.toLowerCase()
    if (FIXTURE_DIR_SEGMENTS.has(low)) return `路径段含夹具目录名「${s}」`
    if (low === 'node_modules') return '路径落在依赖目录内'
  }
  const base = segs[segs.length - 1] ?? ''
  if (FIXTURE_BASENAME_RE.test(base)) return `文件名呈示例/模板形态（${base}）`
  return null
}

/** 把绝对路径转成相对某根的 posix 相对路径（根之外时返回绝对形态本身，便于报出）。 */
const relOf = (root, abs) => {
  const r = path.relative(root, abs)
  return (r === '' ? path.basename(abs) : r).replace(/\\/g, '/')
}

/** 读文件并保留行数组（行级引用的唯一来源）。 */
function readLines(abs) {
  return readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
}

/** 在行数组里找首个命中正则的行号（1 起）；找不到返回 null。 */
export function lineOf(lines, re) {
  const i = lines.findIndex((l) => re.test(l))
  return i === -1 ? null : i + 1
}

/** 一条行级引用：`文件:行号`；无行号时只给文件并说明「该文件内无匹配行」。 */
function ref(file, line, note) {
  return { file, line: line ?? null, at: line == null ? file : `${file}:${line}`, note: note ?? null }
}

/** ===== 数据源装载 ===== */

function readEvents(eventsDir, root) {
  const out = { lines: [], records: [], missing: true }
  if (!existsSync(eventsDir)) return out
  out.missing = false
  const files = []
  walkJsonl(eventsDir, eventsDir, 0, files)
  for (const abs of files.sort()) {
    const rel = relOf(eventsDir, abs)
    const why = fixtureReason(rel)
    if (why) {
      out.lines.push({ rel, abs, lines: [], excluded: why })
      continue
    }
    const lines = readLines(abs)
    out.lines.push({ rel, abs, lines, excluded: null })
    lines.forEach((text, i) => {
      if (text.trim() === '') return
      let rec
      try {
        rec = JSON.parse(text)
      } catch {
        return // 坏行不猜：报告里以「解析失败」计数，不参与任何判定
      }
      if (rec && typeof rec === 'object') out.records.push({ rec, ref: ref(relOf(root, abs), i + 1, null) })
    })
  }
  return out
}

/** 递归收集 JSONL 分片（深度封顶 3 层）。
 *  **刻意递归**：事件分片契约是平铺，但若有人把夹具目录塞进真实事件目录，
 *  递归扫到它才谈得上「显式排除并列出」—— 看不见的排除等于没有排除。 */
function walkJsonl(dir, root, depth, acc) {
  if (depth > 3) return
  let items = []
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) walkJsonl(abs, root, depth + 1, acc)
    else if (item.name.endsWith('.jsonl')) acc.push(abs)
  }
}

function readJsonl(auditPath) {
  const out = { lines: [], records: [], missing: true }
  if (!existsSync(auditPath)) return out
  out.missing = false
  const abs = auditPath
  const rel = path.basename(auditPath)
  const lines = readLines(abs)
  out.lines.push({ rel, abs, lines, excluded: null })
  lines.forEach((text, i) => {
    if (text.trim() === '') return
    try {
      const rec = JSON.parse(text)
      if (rec && typeof rec === 'object') out.records.push({ rec, ref: ref(rel, i + 1, null) })
    } catch {
      /* 审计坏行不影响判定（审计是佐证不是判据） */
    }
  })
  return out
}

/**
 * 装载全部数据源。`config` 里声明的路径若本身落在夹具目录 → 直接抛（CLI 转 exit 2），
 * 因为「数据源是夹具」的报告没有任何事实价值。
 */
export function loadSources(config, baseDir) {
  const absOf = (rel) => path.resolve(baseDir, rel)
  const declared = [
    ['entries', config.storage.entries_dir],
    ['events', config.storage.events_dir],
    ['registry', config.storage.registry],
    ['guard-state', null], // 运行时字段走派发器的落位口径（配置项优先，缺省 events_dir 同级）
    ['audit', config.storage.audit_log],
  ]
  const rejected = []
  for (const [role, rel] of declared) {
    if (typeof rel !== 'string' || rel === '') continue
    const why = fixtureReason(relOf(baseDir, absOf(rel)))
    if (why) rejected.push({ role, path: rel, reason: why })
  }
  if (rejected.length > 0) {
    const err = new Error(`数据源指向夹具/示例路径，拒绝出报告：${rejected.map((r) => `${r.role}=${r.path}（${r.reason}）`).join('；')}`)
    err.sourceRejected = true
    throw err
  }

  const entriesDir = absOf(config.storage.entries_dir)
  const eventsDir = absOf(config.storage.events_dir)
  const regPath = registryPath(config, baseDir)
  const statePath = guardStatePath(config, baseDir)
  const auditPath = typeof config.storage.audit_log === 'string' ? absOf(config.storage.audit_log) : null

  // --- 条目区（根层不递归：archive/ 退役区天然不在扫描面内，与 validate --all 同口径）---
  // 根层下的**子目录**一律不参与判定；但夹具特征的子目录要在报告里点名列出 ——
  // 「因为是子目录所以没看见」不是排除理由，报告必须说清看见了什么、为什么不用。
  const entries = []
  const entryFiles = []
  if (existsSync(entriesDir)) {
    for (const item of readdirSync(entriesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.isDirectory()) {
        const why = fixtureReason(item.name)
        entryFiles.push({ rel: item.name, abs: path.join(entriesDir, item.name), excluded: why ?? '条目区子目录不在扫描面内（与 validate --all 同口径：退役区等）' })
        continue
      }
      const name = item.name
      if (!name.endsWith('.md') || NON_ENTRY_BASENAMES.has(name)) continue
      const abs = path.join(entriesDir, name)
      const rel = relOf(entriesDir, abs)
      const why = fixtureReason(rel)
      if (why) {
        entryFiles.push({ rel, abs, excluded: why })
        continue
      }
      const lines = readLines(abs)
      const id = entryIdFromName(name)
      if (!id) continue // 不符合 ID 命名的不是条目（命名门禁的管辖面，不在本命令重复判红）
      const fm = extractFrontmatter(lines.join('\n'))
      entryFiles.push({ rel, abs, excluded: null })
      entries.push({ id, name, rel, abs, lines, fm: fm.fm ?? null, fmError: fm.error ?? null })
    }
  }

  const events = readEvents(eventsDir, baseDir)
  const audit = auditPath ? readJsonl(auditPath) : { lines: [], records: [], missing: true }

  // --- 注册表：结构非法必须显性失败（入仓数据坏了不能静默放行成「冻结」以外的任何结论）---
  // 「文件不存在」与「文件损坏」必须分开：前者 = 还没有数据（判冻结），后者 = 事实坏了（exit 2）。
  const registry = { path: relOf(baseDir, regPath), abs: regPath, lines: [], guards: [], error: null, excluded: null }
  if (!existsSync(regPath)) registry.error = `注册表尚不存在（视为零守卫注册）: ${registry.path}`
  else {
    const rel = relOf(baseDir, regPath)
    const why = fixtureReason(rel)
    registry.excluded = why
    if (!why) {
      registry.lines = readLines(regPath)
      try {
        const parsed = parseYaml(registry.lines.join('\n'))
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.guards)) {
          registry.error = `注册表结构非法: ${registry.path}（须含 guards 数组）`
          registry.fatal = true
        } else {
          registry.guards = parsed.guards.filter((g) => g && typeof g.key === 'string')
        }
      } catch (e) {
        registry.error = `注册表解析失败: ${registry.path}（${e.reason || e.message}）`
        registry.fatal = true
      }
    }
  }

  // --- 守卫运行时状态：对账命令比派发器严 —— 状态坏了是 exit 2 不是 exit 1（事实损坏 ≠ 没跑起来）---
  const state = { path: relOf(baseDir, statePath), abs: statePath, lines: [], data: null, error: null, fatal: false, excluded: null }
  if (!existsSync(statePath)) state.error = `守卫状态文件尚不存在（视为零运行记录）: ${state.path}`
  else {
    const rel = relOf(baseDir, statePath)
    const why = fixtureReason(rel)
    state.excluded = why
    if (!why) {
      state.lines = readLines(statePath)
      try {
        const parsed = JSON.parse(state.lines.join('\n'))
        state.data = parsed && typeof parsed === 'object' ? parsed : null
        if (state.data === null) {
          state.error = `守卫状态文件结构非法: ${state.path}`
          state.fatal = true
        }
      } catch (e) {
        state.error = `守卫状态文件损坏: ${state.path}（${e.message}）`
        state.fatal = true
      }
    }
  }

  return { baseDir, entries, entryFiles, events, audit, registry, state }
}

/** ===== 六拍判定 ===== */

const intOf = (v) => (Number.isInteger(v) ? v : 0)

/** 某个 ISO 时刻距今多少天；无法解析返回 null（判据据此判红，不猜）。 */
function daysSince(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 86_400_000
}

/** 条目 frontmatter 取值（缺失键 = null，不兜底造默认 —— 缺失本身就是判定依据）。 */
const fmVal = (e, key) => (e.fm && Object.prototype.hasOwnProperty.call(e.fm, key) ? e.fm[key] : null)

/** 该条目的观测账（守卫状态文件的 `entries` 段；缺失 = 从未被覆盖派发 = 没有证据）。 */
function ledgerOf(src, id) {
  const entries = src.state.data && typeof src.state.data.entries === 'object' ? src.state.data.entries : null
  const rec = entries && entries[id] && typeof entries[id] === 'object' ? entries[id] : null
  const line = rec ? lineOf(src.state.lines, new RegExp(`^\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)) : null
  return { rec, ref: ref(src.state.path, line, rec ? null : '该状态文件内无此条目键（从未被守卫覆盖派发）') }
}

/**
 * 事件 ↔ 条目链接，按可信度分三档（拍1 判据）：
 *   强 `entry-ids`   = 条目 frontmatter `event_ids` 点名的事件（草案蒸馏时记下的因果来源）；
 *   强 `entry-id`    = 事件自带 `entry_id` 命中（兼容外部写入，判据不依赖它）；
 *   弱 `date-overlap`= 命中日区间内的 gate_block（时间共现，**非因果**，证据标注必须显出弱）。
 *
 * 事件侧 `entry_id` 恒 null（事件是只增不改的证据账，stoploss.md §2，不回写），所以真正的强链接
 * 只能来自条目侧 `event_ids` —— 这条链由 approve.mjs 落盘时接上，此前不存在导致拍1 恒 ✗。
 */
function linkedEvents(src, id, ledgerRec, declaredIds = null) {
  const declared = new Set(Array.isArray(declaredIds) ? declaredIds.filter((s) => typeof s === 'string') : [])
  const strong = []
  const weak = []
  for (const { rec, ref: r } of src.events.records) {
    if (typeof rec.id === 'string' && declared.has(rec.id)) {
      strong.push({ rec, ref: r, link: 'entry-ids' })
      continue
    }
    if (rec.entry_id === id) {
      strong.push({ rec, ref: r, link: 'entry-id' })
      continue
    }
    const day = typeof rec.ts === 'string' ? rec.ts.slice(0, 10) : ''
    const inWindow =
      day !== '' &&
      ledgerRec &&
      typeof ledgerRec.first_hit === 'string' &&
      typeof ledgerRec.last_hit === 'string' &&
      day >= ledgerRec.first_hit &&
      day <= ledgerRec.last_hit &&
      rec.kind === 'gate_block'
    if (inWindow) weak.push({ rec, ref: r, link: 'date-overlap' })
  }
  // 点名的来源事件若已不在事件库里（事件库被清过），也要留一条显式记录 —— 静默丢弃会让拍1 的红绿
  // 看起来像「本来就没有来源事实」，比明着说「声明过但查无此事」更危险。
  const missing = [...declared].filter((x) => !src.events.records.some((e) => e.rec && e.rec.id === x)).sort()
  return { strong, weak, missing, all: [...strong, ...weak] }
}

/** 判一条条目的六拍；返回逐拍结论 + 全部证据引用 + 时间线。
 *  @param {number} cycleDays 探针证据有效期（= `config.retire.cycle_days`，来自 verify.mjs 的单一出处） */
export function traceEntry(src, entry, { cycleDays = 90 } = {}) {
  const { id } = entry
  const guardRef = typeof fmVal(entry, 'guard_ref') === 'string' ? fmVal(entry, 'guard_ref') : null
  const declaredEventIds = fmVal(entry, 'event_ids')
  const { rec: ledgerRec, ref: ledgerRef } = ledgerOf(src, id)
  const events = linkedEvents(src, id, ledgerRec, declaredEventIds)
  const beats = []
  const push = (n, name, ok, evidence) => beats.push({ beat: n, name, ok, evidence })

  // 拍1 事件：失效形态被捕获过（强/弱链接分别标注，弱链接不冒充实证）
  const ev1 = events.all.map((e) => ref(e.ref.file, e.ref.line, `事件 ${e.rec.id ?? '?'} · ${e.link} · ${e.rec.kind ?? '?'} · ${e.rec.fingerprint ?? '?'}`))
  for (const m of events.missing) ev1.push(ref(src.events.lines[0]?.rel ?? 'events', null, `条目声明来源事件 ${m}，但事件库内查无此记录（事件库可能被清过）`))
  push(1, '事件', events.all.length > 0, ev1.length > 0 ? ev1 : [ref(src.events.lines[0]?.rel ?? 'events', null, '事件库内无与本条目关联的记录，且本条目未声明 event_ids')])

  // 拍2 条目：正式条目存在、frontmatter 可解、且已绑定守卫
  const skillRef = typeof fmVal(entry, 'skill_ref') === 'string' ? fmVal(entry, 'skill_ref') : null
  const ev2 = [
    ref(src.entryFiles.find((f) => f.abs === entry.abs)?.rel ?? entry.name, lineOf(entry.lines, /^type:/), `type=${fmVal(entry, 'type')}`),
    ref(entry.name, lineOf(entry.lines, /^status:/), `status=${fmVal(entry, 'status')}`),
    ref(entry.name, lineOf(entry.lines, /^guard_ref:/), `guard_ref=${guardRef ?? 'null'}`),
  ]
  // **规程型条目**（guard_ref=null 且 skill_ref 非空）：判红是**正确**行为，不是坏了。
  // 拍2 的判据就是「已绑定守卫」，规程型条目没有机器判据，于是拍2-6 预期全红 —— 这属于
  // schema.md §1.4 明确的「规程型条目不参与六拍达成率统计」。这里显式说明，是为了防止读的人
  // 把它当成链路故障去「修」（而唯一能把它修绿的办法是伪造一个假守卫 —— 那是 §3.3 退役链
  // 明令拒绝的证伪武器化）。拍3-6 的判据因此**不动**：它们照常判红，事实照常说。
  if (guardRef === null && skillRef !== null) {
    ev2.push(
      ref(entry.name, lineOf(entry.lines, /^skill_ref:/), `skill_ref=${skillRef}`),
      ref(entry.name, null, '规程型条目：真实现位是一个 skill 章节（人读的规程、无派发），按契约不派发守卫 —— 拍2-6 预期为红，且本条不计入六拍达成率统计（schema.md §1.4）。要它变绿只能绑定真守卫，不得为凑指标伪造空壳守卫。'),
    )
  }
  if (entry.fmError) ev2.unshift(ref(entry.name, null, `frontmatter 解析失败: ${entry.fmError}`))
  push(2, '条目', Boolean(entry.fm) && guardRef !== null, ev2)

  // 拍3 守卫登记：registry 里有这个 key，且它声明覆盖本条目
  const guard = guardRef ? src.registry.guards.find((g) => g.key === guardRef) : null
  const covered = guard && Array.isArray(guard.covered_entries) ? guard.covered_entries : null
  const covers = covered ? covered.includes(id) : false
  const ev3 = [
    ref(src.registry.path, guard ? lineOf(src.registry.lines, new RegExp(`^\\s*-?\\s*key:\\s*${guardRef}\\s*$`)) : null, guard ? `守卫 key=${guardRef} 已登记 · mode=${guard.mode ?? 'shadow'}` : `注册表内无 key=${guardRef ?? 'null'} 的守卫`),
    ref(src.registry.path, guard && covers ? lineOf(src.registry.lines, new RegExp(`^\\s*covered_entries:`)) : null, covered ? `covered_entries 含 ${id}：${covers}` : `守卫未声明 covered_entries 或不含 ${id}（无可追溯的覆盖声明）`),
  ]
  push(3, '守卫登记', Boolean(guard) && covers, ev3)

  // 拍4 守卫运行：真跑过 + shadow 已挣到 blocking（拦截权是挣的不是注册的）
  //
  // `injected === true` 的账**一律不算数**（--inject-state 是夹具注入口，mode=blocking 是造出来的）：
  // 拍4 是「这条经验真被守卫持续兜住」的判据，拿注入出来的假拦截权冒充它 = 伪造证据。
  const gs = src.state.data && src.state.data.guards && typeof src.state.data.guards === 'object' ? src.state.data.guards[guardRef] : null
  const required = guard && Number.isInteger(guard.shadow_required) && guard.shadow_required >= 0 ? guard.shadow_required : DEFAULT_SHADOW_RUNS
  const guardInjected = Boolean(gs) && gs.injected === true
  const runsOk = Boolean(gs) && typeof gs.last_run === 'string' && gs.mode === 'blocking' && intOf(gs.shadow_runs) >= required && !guardInjected
  const ev4 = [
    ref(src.state.path, gs ? lineOf(src.state.lines, new RegExp(`^\\s*"${String(guardRef).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)) : null, gs ? `last_run=${gs.last_run ?? '无'} · shadow ${intOf(gs.shadow_green)}/${intOf(gs.shadow_runs)}（需 ${required} 绿）· mode=${gs.mode ?? '无'}` : `状态文件内无守卫 ${guardRef ?? 'null'} 的运行记录`),
  ]
  if (guardInjected) {
    ev4.push(ref(src.state.path, null, `⚠ injected=true（--inject-state 夹具注入于 ${gs.injected_at ?? '未知时间'}${Array.isArray(gs.injected_fields) && gs.injected_fields.length > 0 ? `：${gs.injected_fields.join(', ')}` : ''}）—— 拦截权是注入出来的，拍4 一律判红：自证状态不得冒充「真挣到拦截权」`))
  }
  const auditHits = src.audit.records.filter((a) => a.rec && a.rec.tool === 'run-guard' && a.rec.guard === guardRef)
  for (const a of auditHits.slice(-3)) ev4.push(ref(a.ref.file, a.ref.line, `审计派发记录 · action=${a.rec.action ?? '?'}`))
  push(4, '守卫运行', runsOk, ev4)

  // 拍5 拦截命中：**两型判据** —— 优先 wild（野外真出事，最强证据）；没有 wild 才看 probe。
  // 存量的 `hits`（分型前的历史命中）属 legacy-unknown：既不记 wild，也不满足 probe 分支
  // —— 账上无法区分它当年是野外复发还是我们自己造的破坏测试，就不许它判绿。
  const wildHits = intOf(ledgerRec?.wild_hits)
  const probeHits = intOf(ledgerRec?.probe_hits)
  const legacyHits = intOf(ledgerRec?.legacy_hits)
  const probeOutcome = ledgerRec?.probe_last_outcome ?? '无'
  const probeAt = ledgerRec?.probe_last_outcome_at
  const probeDays = typeof probeAt === 'string' ? daysSince(probeAt) : null
  const probeFresh = probeDays !== null && probeDays <= cycleDays
  // 证据门判「**末次**观测是否健康」，不判「历史上是否零异常」（evt-20261017-033 补洞）。
  // 原实现用累计计数 observed_error_runs === 0，与 schema.md §3.1「该字段不参与退役证据」
  // 自相矛盾，且累计只增不减 ⇒ 守卫异常过一次就把它覆盖的条目**永久**锁死，六拍再也无法走完。
  // 账上还没有 last_observation 的（本次改动前的旧账）回退到旧判据，**不追溯洗白**。
  const lastObs = ledgerRec?.last_observation
  const probeNoErr =
    typeof lastObs === 'string'
      ? lastObs === 'healthy'
      : intOf(ledgerRec?.observed_error_runs) === 0
  const probeOk = probeHits >= 1 && probeOutcome === 'proven' && probeFresh && probeNoErr
  const wildOk = wildHits >= 1 && typeof ledgerRec?.first_wild_hit === 'string'
  const beat5 = wildHits >= 1 ? wildOk : probeOk
  const ev5 = [
    ledgerRef,
    ref(src.state.path, wildHits > 0 ? lineOf(src.state.lines, new RegExp(`^\\s*"wild_hits":\\s*${wildHits}\\s*,?$`)) : probeHits > 0 ? lineOf(src.state.lines, new RegExp(`^\\s*"probe_hits":\\s*${probeHits}\\s*,?$`)) : null,
      ledgerRec
        ? `observed_runs=${intOf(ledgerRec.observed_runs)} · wild_hits=${wildHits} · first_wild_hit=${ledgerRec.first_wild_hit ?? '无'} · probe_hits=${probeHits} · probe_last_outcome=${probeOutcome} · probe 证据龄=${probeDays === null ? '无' : `${probeDays.toFixed(1)} 天（有效期 ${cycleDays} 天）`} · observed_error_runs=${intOf(ledgerRec.observed_error_runs)} · pending_hits=${intOf(ledgerRec.pending_hits)}${legacyHits > 0 ? ` · legacy_hits=${legacyHits}（分型前历史命中，来源不可知，不作任一型证据）` : ''}`
        : '观测账缺失（从未被覆盖派发 = 没有证据，不是「无人命中」）'),
    ref(src.state.path, null, wildHits >= 1
      ? (wildOk ? '走 wild 路径：野外捕获过违规（最强证据）' : 'wild_hits ≥ 1 但缺 first_wild_hit —— 账不自洽，判红')
      : (probeOk
        ? `走 probe 路径：破坏测试拦住了（末次 proven · ${probeDays.toFixed(1)} 天 ≤ ${cycleDays} 天 · 末次观测=${typeof lastObs === 'string' ? lastObs : 'healthy（旧账回退判据）'}）—— 自证，不作退役证据`
        : `probe 路径不成立（probe_hits=${probeHits} · 末次=${probeOutcome} · 龄=${probeDays === null ? '无' : probeDays.toFixed(1)} 天 · 末次观测=${lastObs ?? '无（旧账）'} · 历史判据异常 ${intOf(ledgerRec?.observed_error_runs)} 次）—— 无任何拦截证据`)),
  ]
  push(5, '拦截命中', beat5, ev5)

  // 拍6 回写：**与拍5 同源分型**。wild 链要求 sweep 已把 recurrence 抬上去、last_verified_at 刷新、
  // 正文末尾有对质段且 `swept_hits > 0`；probe-only 链不要求动条目正文（probe 就不写正文），
  // 但要求 probe 账已被 `--sweep` 结清（`swept_probes > 0 && pending_probes === 0`）——
  // 否则「拍了探针就算闭环」等于让证据没有落点，拍5 的放宽就没有后果。
  const recurrence = Number.isInteger(fmVal(entry, 'recurrence')) ? fmVal(entry, 'recurrence') : -1
  const lastVerified = typeof fmVal(entry, 'last_verified_at') === 'string' ? fmVal(entry, 'last_verified_at') : null
  const confrontLine = lineOf(entry.lines, /^### 复发 \d+ · \d{4}-\d{2}-\d{2}$/)
  const swept = intOf(ledgerRec?.swept_hits)
  const sweptProbes = intOf(ledgerRec?.swept_probes)
  const pendingProbes = intOf(ledgerRec?.pending_probes)
  const ev6 = [
    ref(entry.name, lineOf(entry.lines, /^recurrence:/), `recurrence=${recurrence}`),
    ref(entry.name, lineOf(entry.lines, /^last_verified_at:/), `last_verified_at=${lastVerified ?? 'null'}`),
    ref(entry.name, confrontLine, confrontLine ? '正文末尾有对质段（复发证据行）' : '正文无 `### 复发 N · 日期` 对质段'),
    ref(src.state.path, swept > 0 ? lineOf(src.state.lines, /^\s*"swept_hits":/) : null, `swept_hits=${swept} · last_swept_at=${ledgerRec?.last_swept_at ?? '无'} · pending_hits=${intOf(ledgerRec?.pending_hits)}`),
    ref(src.state.path, sweptProbes > 0 ? lineOf(src.state.lines, /^\s*"swept_probes":/) : null, `swept_probes=${sweptProbes} · pending_probes=${pendingProbes} · last_probe_swept_at=${ledgerRec?.last_probe_swept_at ?? '无'}`),
  ]
  const beat6 = wildHits >= 1
    ? recurrence >= 1 && lastVerified !== null && confrontLine !== null && swept > 0
    : probeOk && sweptProbes > 0 && pendingProbes === 0
  ev6.push(ref(src.state.path, null, wildHits >= 1
    ? '走 wild 回写路径：只认 sweep 回写的 recurrence / last_verified_at / 正文对质段'
    : `走 probe 结账路径：recurrence / 对质段不要求（probe 不写条目正文），要求 probe 账已由 --sweep 结清${probeOk ? '' : '（拍5 的 probe 证据已失效，拍6 一并判红）'}`))
  push(6, '回写', beat6, ev6)

  // 时间线：事件库的首末时刻 + 观测/命中/回写时刻 + frontmatter 现状，按时间排序
  const timeline = []
  if (events.all.length > 0) {
    const first = events.all.map((e) => e.rec.first_ts || e.rec.ts).filter(Boolean).sort()[0]
    const last = events.all.map((e) => e.rec.last_ts || e.rec.ts).filter(Boolean).sort().slice(-1)[0]
    if (first) timeline.push({ ts: first, label: '首条事件', ref: events.all[0].ref })
    if (last && last !== first) timeline.push({ ts: last, label: '末条事件', ref: events.all[events.all.length - 1].ref })
  }
  if (ledgerRec) {
    if (ledgerRec.last_observed) timeline.push({ ts: ledgerRec.last_observed, label: '最近一次被守卫覆盖派发', ref: ledgerRef })
    if (ledgerRec.first_wild_hit) timeline.push({ ts: `${ledgerRec.first_wild_hit}T00:00:00.000Z`, label: '首次野外命中判据（wild）', ref: ledgerRef })
    if (ledgerRec.last_wild_hit) timeline.push({ ts: `${ledgerRec.last_wild_hit}T00:00:00.000Z`, label: '末次野外命中判据（wild）', ref: ledgerRef })
    // 分型前的历史命中（`first_hit`）只在它存在时留着 —— 拍1 的 date-overlap 弱链接仍读它，
    // 拍1 判据不动（本次只拆命中证据的类型，不动「事件是否被捕获」这一拍）。
    if (ledgerRec.first_hit) timeline.push({ ts: `${ledgerRec.first_hit}T00:00:00.000Z`, label: '首次命中判据（含 legacy-unknown 历史账）', ref: ledgerRef })
    if (ledgerRec.last_hit) timeline.push({ ts: `${ledgerRec.last_hit}T00:00:00.000Z`, label: '末次命中判据（含 legacy-unknown 历史账）', ref: ledgerRef })
    if (ledgerRec.last_probe_at) timeline.push({ ts: ledgerRec.last_probe_at, label: `最近一次探针（--probe 人造验证）· 末次结论 ${ledgerRec.probe_last_outcome ?? '无'}`, ref: ledgerRef })
    if (ledgerRec.last_swept_at) timeline.push({ ts: ledgerRec.last_swept_at, label: 'sweep 回写完成（wild）', ref: ref(src.state.path, lineOf(src.state.lines, /^\s*"last_swept_at":/), null) })
    if (ledgerRec.last_probe_swept_at) timeline.push({ ts: ledgerRec.last_probe_swept_at, label: 'sweep 结清 probe 账（未改条目正文）', ref: ref(src.state.path, lineOf(src.state.lines, /^\s*"last_probe_swept_at":/), null) })
  }
  if (lastVerified) timeline.push({ ts: `${lastVerified}T00:00:00.000Z`, label: `条目 frontmatter last_verified_at（recurrence=${recurrence}）`, ref: ref(entry.name, lineOf(entry.lines, /^last_verified_at:/), null) })
  timeline.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  return {
    id,
    entry: entry.rel,
    guard_ref: guardRef,
    ok: beats.every((b) => b.ok),
    beats,
    timeline,
  }
}

/** 跑完整对账：装载 → 逐条目六拍 → 二值判定。 */
export function trace({ config, baseDir, onlyId = null }) {
  const src = loadSources(config, baseDir)
  const target = onlyId ? src.entries.filter((e) => e.id === onlyId) : src.entries
  // 探针有效期与退役周期同源（verify.mjs 的 retireCycleDays）——两处各写一个 90 迟早漂成两个数。
  const cycleDays = retireCycleDays(config)
  const traces = target.map((e) => traceEntry(src, e, { cycleDays }))
  const excluded = [
    ...src.entryFiles.filter((f) => f.excluded).map((f) => ({ file: f.rel, reason: f.excluded, kind: fixtureReason(f.rel) ? 'fixture' : 'out-of-scope' })),
    ...src.events.lines.filter((l) => l.excluded).map((l) => ({ file: l.rel, reason: l.excluded, kind: 'fixture' })),
    ...src.audit.lines.filter((l) => l.excluded).map((l) => ({ file: l.rel, reason: l.excluded, kind: 'fixture' })),
  ]
  return {
    sources: {
      entries: relOf(baseDir, path.resolve(baseDir, config.storage.entries_dir)),
      events: relOf(baseDir, path.resolve(baseDir, config.storage.events_dir)),
      registry: src.registry.path,
      guard_state: src.state.path,
      audit_log: src.audit.lines[0]?.rel ?? (config.storage.audit_log ?? '(未配置)'),
    },
    integrity: { registry: src.registry.fatal ? src.registry.error : null, guard_state: src.state.fatal ? src.state.error : null },
    warnings: [!src.registry.fatal ? src.registry.error : null, !src.state.fatal ? src.state.error : null].filter(Boolean),
    excluded,
    counts: { entries: target.length, events: src.events.records.length, guards: src.registry.guards.length, audits: src.audit.records.length },
    traces,
    verdict: traces.some((t) => t.ok) ? 'pass' : 'freeze',
  }
}

/** ===== 报告渲染（人读形态；每个结论后面就是它的行级引用） ===== */

function renderReport(r) {
  const out = []
  out.push(`[trace] 判定 = ${r.verdict === 'pass' ? '通过（≥1 条真实条目自然走完六拍）' : '触发冻结（无任何条目走完六拍）'}`)
  out.push(
    `[trace] 数据源（只读五处）: entries=${r.sources.entries} · events=${r.sources.events} · ` +
      `registry=${r.sources.registry} · guard_state=${r.sources.guard_state} · audit_log=${r.sources.audit_log}`,
  )
  out.push(`[trace] 规模: 条目 ${r.counts.entries} · 事件记录 ${r.counts.events} · 守卫 ${r.counts.guards} · 审计行 ${r.counts.audits}`)
  for (const [k, v] of Object.entries(r.integrity)) if (v) out.push(`[trace] 事实损坏: ${k}: ${v}`)
  for (const w of r.warnings) out.push(`[trace] 数据源为空提示: ${w}`)
  const fixtureExcluded = r.excluded.filter((e) => e.kind === 'fixture')
  out.push(`[trace] 排除的夹具路径 ${fixtureExcluded.length} 条（夹具数据不得冒充真实运行数据）:`)
  for (const e of fixtureExcluded) out.push(`[trace]   ✗ ${e.file} —— ${e.reason}`)
  if (fixtureExcluded.length === 0) out.push('[trace]   （本次数据源内无夹具特征路径）')
  const outOfScope = r.excluded.filter((e) => e.kind !== 'fixture')
  if (outOfScope.length > 0) {
    out.push(`[trace] 扫描面外（同样不参与判定）${outOfScope.length} 条:`)
    for (const e of outOfScope) out.push(`[trace]   · ${e.file} —— ${e.reason}`)
  }
  for (const t of r.traces) {
    out.push('')
    out.push(`[trace] ── ${t.id} · guard_ref=${t.guard_ref ?? 'null'} · 六拍判定 ${t.ok ? '全绿' : '未走完'} · 文件=${t.entry}`)
    for (const b of t.beats) {
      out.push(`[trace]   拍${b.beat} ${b.name}：${b.ok ? '✓' : '✗'}`)
      for (const e of b.evidence) out.push(`[trace]      · ${e.at}${e.note ? ` —— ${e.note}` : ''}`)
    }
    if (t.timeline.length > 0) {
      out.push('[trace]   时间线（recurrence / last_verified_at 溯源）:')
      for (const n of t.timeline) out.push(`[trace]      · ${n.ts} · ${n.label} · ${n.ref.at}`)
    }
  }
  if (r.verdict !== 'pass') {
    out.push('')
    out.push('[trace] 止损建议：按 references/stoploss.md 执行冻结（停注入与一切新功能，只保留事件捕获），恢复须用户显式解冻。')
  }
  return out.join('\n')
}

/**
 * provenance 只读视图：回答「**这些知识从哪来、怎么学来的**」。
 *
 * **为什么要有这个查询面**：provenance 字段写进事件/审计只是「记了」，记了不读等于没有。
 * 三段学习路径各留在一处数据里，本视图把它们接成一条链：
 *   采集口（hook / CLI / 门禁）→ 事件（fingerprint / 会话 / 工具）→ 草案（learned_via=distill）
 *   → 条目 → 注入（learned_via=recall，命中了哪些关键词）
 * 存量数据里 provenance 缺的（字段是后加的）如实显示为「无 provenance」，不猜、不补。
 *
 * @returns {{collected_by: object, learned_via: object, entry_recalls: object[], gaps: string[]}}
 */
export function provenance(config, baseDir) {
  const absOf = (rel) => path.resolve(baseDir, rel)
  const events = readEvents(absOf(config.storage.events_dir), baseDir)
  const auditPath = config.storage.audit_log
    ? absOf(config.storage.audit_log)
    : path.join(os.tmpdir(), 'self-improving-injection-audit.jsonl')
  const audit = readJsonl(auditPath)

  const collectedBy = {}
  const learnedVia = {}
  const gaps = []
  let eventsWithout = 0
  for (const { rec } of events.records) {
    const key = (rec.provenance && rec.provenance.collected_by) || '（无 provenance）'
    collectedBy[key] = (collectedBy[key] || 0) + 1
    if (!rec.provenance) eventsWithout++
  }
  if (eventsWithout > 0) gaps.push(`${eventsWithout} 条事件无 provenance（字段后加，存量未回填）`)

  const recalls = []
  for (const { rec } of audit.records) {
    if (typeof rec.learned_via === 'string') {
      learnedVia[rec.learned_via] = (learnedVia[rec.learned_via] || 0) + 1
    }
    if (rec.action === 'entry-recalled' && Array.isArray(rec.entries)) {
      for (const e of rec.entries) {
        recalls.push({
          entry: e && typeof e.entry === 'string' ? e.entry : '?',
          scope: e && typeof e.scope === 'string' ? e.scope : null,
          keyword_hits: e && typeof e.keyword_hits === 'number' ? e.keyword_hits : null,
          via: 'recall',
        })
      }
    }
    if (rec.action === 'proposal-written' && Array.isArray(rec.source_events)) {
      for (const id of rec.source_events) {
        recalls.push({ entry: id, scope: null, keyword_hits: null, via: 'distill-source-event' })
      }
    }
  }
  return {
    collected_by: collectedBy,
    learned_via: learnedVia,
    entry_recalls: recalls,
    gaps,
  }
}

function renderProvenance(p) {
  const kv = (o) => (Object.keys(o).length === 0 ? '    （无）' : Object.entries(o).map(([k, v]) => `    ${k}: ${v}`).join('\n'))
  return [
    '## provenance · 知识来源与学习路径',
    '',
    '采集口（事件从哪来）:',
    kv(p.collected_by),
    '',
    '学习方式（learned_via 计数）:',
    kv(p.learned_via),
    '',
    `条目级回忆链: ${p.entry_recalls.length} 条`,
    ...(p.entry_recalls.length > 0
      ? p.entry_recalls.slice(0, 20).map((r) => `    ${r.entry} · ${r.via}${r.scope ? ` · scope=${r.scope}` : ''}${r.keyword_hits !== null ? ` · 关键词命中 ${r.keyword_hits}` : ''}`)
      : ['    （无）']),
    '',
    '已知缺口:',
    kv(Object.fromEntries(p.gaps.map((g) => [g, '⚠']))),
    '',
  ].join('\n')
}

export function main(argv) {
  let cliConfig = null
  let projectDir = process.cwd()
  let onlyId = null
  let wantJson = false
  let wantProvenance = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') {
      wantJson = true
      continue
    }
    if (a === '--provenance') {
      wantProvenance = true
      continue
    }
    if (!['--id', '--config', '--project-dir'].includes(a)) return usage(`未知参数 ${a}`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) return usage(`${a} 后须跟值`)
    i++
    if (a === '--id') onlyId = next
    else if (a === '--config') cliConfig = path.resolve(next)
    else projectDir = path.resolve(next)
  }
  if (onlyId !== null && !/^(?:LRN|ERR|FEAT)-\d{8}-\d{3}$/.test(onlyId)) return usage(`--id 形态非法: ${onlyId}`)

  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    console.error(`[trace] 配置链失败（无法判事实，不出报告）: ${e.message}`)
    return 2
  }

  try {
    if (wantProvenance) {
      const p = provenance(config, baseDir)
      if (wantJson) process.stdout.write(`${JSON.stringify(p, null, 2)}\n`)
      else console.error(renderProvenance(p))
      return 0 // 只读视图：查得到查不到都不代表体系坏了，故恒 0（冻结判定仍归 --id 默认视图）
    }
    const r = trace({ config, baseDir, onlyId })
    for (const [k, v] of Object.entries(r.integrity)) {
      if (v) {
        console.error(`[trace] 事实损坏: ${k}: ${v}（对账命令不把「读不到」当成「没跑起来」）`)
        return 2
      }
    }
    if (wantJson) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    else console.error(renderReport(r))
    return r.verdict === 'pass' ? 0 : 1
  } catch (e) {
    if (e && e.sourceRejected) {
      console.error(`[trace] ${e.message}`)
      return 2
    }
    console.error(`[trace] 对账失败: ${e.message}`)
    return 2
  }
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node trace.mjs [--id <ID>] [--json] [--provenance] [--config <p>] [--project-dir <d>]
  --provenance = 只读出「知识来源与学习路径」视图（恒 exit 0；冻结判定归默认视图）
  退出码：0=通过（六拍全链可追溯） / 1=触发冻结 / 2=用法错误或数据源非法（事实损坏、配置指向夹具）`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
