#!/usr/bin/env node
/**
 * verify.mjs —— 生命周期收口 CLI：证伪拍（--sweep）/ 退役（--retire）/ 恢复（--restore）（通用技能，零项目耦合）
 *
 * 角色：把「守卫命中」这件事从**高频运行时**翻译成**低频可审计写入**。三件事各管一段：
 *   1. 判定最高频的那段归运行时：守卫命中只往 `storage.guard_state` 的 `entries` 账本追加观测/命中，
 *      **一个字节都不碰仓内条目**（每命中一次就改一次仓内文件 = 无意义的 churn 与脏工作区）。
 *   2. `--sweep` 是唯一的回写口：按账本把 `recurrence` / `last_verified_at` 写回 frontmatter，
 *      并在条目**末尾**追加对质段（`### 复发 N · YYYY-MM-DD` + 证据行）。历史段落零改动 ——
 *      这是账本，只追加，不改写既有行。一次 sweep = 一条 commit 粒度的可审计写入。
 *   3. `--retire` / `--restore` 治理「只进不出」：守卫长期不响且证据充分 → 整文件移入 archive
 *      （append-only，不改内容不删正文），`--restore <ID>` 原样搬回（可逆，字节级还原）。
 *
 * 用法：
 *   node verify.mjs --sweep  [--dry-run] [--json] [--config <p>] [--project-dir <d>]
 *   node verify.mjs --retire [--dry-run] [--json] [--config <p>] [--project-dir <d>]
 *   node verify.mjs --restore <ID> [--dry-run] [--json] [--config <p>] [--project-dir <d>]
 *   退出码：0=完成 / 1=证据不足或事实损坏（显性失败，不静默）/ 2=用法错误
 *
 * ===== 退役为什么必须保守 =====
 *   「长期不响」有两种：① 守卫在跑、判据真的执行过、覆盖着它、就是不响 —— 这是真证据；
 *   ② 从来没人管过它（守卫没登记 / 条目从未被覆盖派发过），或者**管它的那个守卫本身是空的**
 *   （恒 `exit 0` / 起不来 / 判据从未命中过任何东西）—— 这些是**没有证据**，不是「无人命中」。
 *   后者与前者混同，就是「证伪机制被反向武器化」：一个空守卫攒够绿灯升 blocking，
 *   再用它覆盖的真实条目被当成「长期不响」整批清出知识库。
 *   故退役须同时满足（判据单一归宿 = `retireSkipReason`）：
 *     - `entries[id]` 观测账存在且 `observed_runs > 0`（`observed_runs` 只由**真执行了判据**的
 *       派发发放：守卫异常只进 `observed_error_runs`，不参与退役证据）；
 *     - 观测账登记了覆盖守卫（`guard_keys` 非空 —— `covered_entries` 为空的守卫不产生观测账）；
 *     - 其中至少一条已升 `blocking`（shadow-only 守卫没挣到拦截权，其沉默不是证据）；
 *     - 其中至少一条 `ever_hit`（判据**在野外**真的命中过东西 —— 空守卫的沉默不含信息量；
 *       ⚠ `ever_hit` **只由 wild 命中置位**：`--probe` 人造的破坏测试命中永不置位，
 *       否则「一次人造违规」= 「90 天后用这份守卫退役真实条目」的资格）；
 *     - `last_observed` 距今超过 `retire.cycle_days`；
 *     - `wild_hits === 0`（从未野外出事）、`pending_hits === 0`（没有没算清的账）；
 *     - `legacy_hits === 0`（分型前的历史命中属 legacy-unknown：来源不可知，不许当成「从未命中」）。
 *   任一条不满足 → 如实跳过并说明理由，**不退役**。状态文件缺失或损坏 → 直接 exit 1
 *   （比 run-guard 的「损坏按空状态」更严：派发丢的只是 shadow 计数，退役丢的是条目可见性）。
 *
 * ===== probe 命中不回写条目 =====
 *   `--sweep` 按两型分账回写：**只计 wild**（`pending_hits` → `recurrence` + 正文末尾对质段）；
 *   probe 命中只把 `pending_probes` 清账成 `swept_probes`（闭环 + 可核查），**一个字都不写条目**——
 *   我们自己造的违规是「守卫能用」的证明，不是「这条经验在野外复发了」的证据，写进正文就是污染知识库。
 *
 * ===== O(1) spawn 纪律 =====
 *   全程零 spawn（纯 fs 读写 + 配置链里常数次的 git rev-parse），不按条目起子进程（前科 48 条目 98s）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadContext, flushAudit } from './inject.mjs'
import { createLogger } from './lib/log.mjs'
import { guardStatePath, evidenceStrength, normalizeHitLedger, withStateLock as withStateFileLock } from './run-guard.mjs'
import { extractFrontmatter, NON_ENTRY_BASENAMES } from './validate.mjs'
import { atomicWrite } from './lib/atomic-file.mjs'

/**
 * 退役区的**跨副本**可共享性体检（架构审计 F7/B4 · 2026-10-16）。
 *
 * 问题形态：退役区落在 git 排除路径下（常见做法，例如本仓 `.learnings/archive/`
 * 由 `.git/info/exclude` 排除）。此时「移动文件」在**提交层面**不是移动，而是
 * 「活动区一条删除」—— 归档副本不入库 ⇒ 别人拉取后条目从活动区消失、**且没有归档副本**
 * （只剩 git 历史），而发起者的 `--restore` 只恢复他自己本机。跨副本语义上是不可逆删除。
 *
 * 为什么在这里**硬失败**而不是只写文档：退役是本系统唯一的破坏性动作，判据是「证据充分」，
 * 但证据充分**不等于**搬过去是安全的 —— 前者管「该不该删」，后者管「删了别人还能不能看见」。
 * 两者是正交维度，把后者留给「看一眼文档」承担，等于把不可逆动作的安全性寄托在人的记忆上。
 *
 * 判据用 `git check-ignore`（O(1) 一次 spawn）：退役区或其父目录被任一 exclude 机制命中
 * ⇒ 归档副本不入库 ⇒ 拒绝退役，并给出三条可选出路。非 git 仓库 / 无 git = 无法判定，
 * 按「不误伤」放行（本仓外的普通目录用法不受影响）。
 *
 * @returns {{checked: boolean, ignored: boolean, via: string|null}}
 */
export function archiveIsShareable(archiveDir, baseDir) {
  let isRepo = true
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: baseDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    isRepo = false // 非 git 仓库：无从谈起 git 跟踪，放行
  }
  if (!isRepo) return { checked: false, ignored: false, via: null }
  // ⚠ 必须探测**目录内的文件**，不能探测目录本身（2026-10-16 实测）：
  //   排除项形如 `.learnings/archive/`（尾部斜杠）时，`git check-ignore <目录>` 返回**未被忽略**
  //   （退出码 1），而 `<目录>/x.md` 才返回命中（退出码 0）。
  //   探目录 ⇒ 恒判「可共享」⇒ 本条守卫形同虚设（正是「守卫写法坏了 ⇒ 恒绿」）。
  //   故探一个哨兵文件路径；文件不必存在（check-ignore 只做路径匹配，不读盘）。
  const probe = `${archiveDir.replace(/[\\/]+$/, '')}/.gitignore-probe.md`
  let out = ''
  try {
    out = execFileSync('git', ['check-ignore', '-v', probe], {
      cwd: baseDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return { checked: true, ignored: false, via: null } // 退出码 1 = 未被忽略
  }
  const via = out.split('\t')[0] ?? null
  return { checked: true, ignored: true, via }
}

/** 生命周期动作的显性失败（区别于用法错误）：证据不足 / 事实损坏，一律 exit 1 不静默。 */
export class LifecycleError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'LifecycleError'
    this.lifecycle = true
  }
}

/** 条目 ID 从文件名取：`LRN-20261016-003-slug.md` → `LRN-20261016-003`（不符合命名的一律不识别）。 */
export function entryIdFromName(name) {
  const m = /^((?:LRN|ERR|FEAT)-\d{8}-\d{3})(?:-|\.md$)/.exec(name)
  return m ? m[1] : null
}

/** 退役区路径：`storage.archive_dir` 优先，缺省落在 `entries_dir` 下的 `archive/`（条目区根层不递归，天然隔离）。 */
export function archiveDirPath(config, baseDir) {
  const configured = config?.storage && typeof config.storage.archive_dir === 'string' ? config.storage.archive_dir.trim() : ''
  if (configured !== '') return path.resolve(baseDir, configured)
  const entriesDir = config?.storage && typeof config.storage.entries_dir === 'string' ? config.storage.entries_dir : '.self-improving/entries/'
  return path.resolve(baseDir, entriesDir, 'archive')
}

/**
 * 严格读状态文件。**与 run-guard 的宽松读法刻意不同**：
 *   run-guard 损坏按空状态处理（退回 shadow，丢的只是计数）；这里损坏/缺结构一律抛 —— 退役拿空账当
 *   「没人命中」会把 83 条存量一次性误清，属于不可逆动作，不许 fail-open。
 * @param {{required?:boolean}} opts required=true 时文件缺失也抛（退役用：没有账就没有证据）
 */
export function readStrictState(config, baseDir, { required = false } = {}) {
  const p = guardStatePath(config, baseDir)
  if (!existsSync(p)) {
    if (required) throw new LifecycleError(`状态文件不存在: ${p}（没有观测账 = 没有「无人命中」证据，拒绝退役）`)
    return { path: p, state: { guards: {}, entries: {} }, exists: false }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new LifecycleError(`状态文件损坏（JSON 解析失败）: ${p} — ${e.message}（拒绝在坏账上做退役判定）`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LifecycleError(`状态文件损坏（根不是对象）: ${p}`)
  }
  for (const seg of ['guards', 'entries']) {
    if (parsed[seg] !== undefined && (parsed[seg] === null || typeof parsed[seg] !== 'object' || Array.isArray(parsed[seg]))) {
      throw new LifecycleError(`状态文件损坏（${seg} 段结构非法）: ${p}`)
    }
  }
  if (!parsed.entries) parsed.entries = {}
  if (!parsed.guards) parsed.guards = {}
  return { path: p, state: parsed, exists: true }
}

/**
 * 写状态文件（严格：写不动就抛 —— sweep 的账丢了 = 命中被永久吞掉，不能只提示）。
 *
 * 走**原子写**：与派发器（run-guard）并发时，读方不会读到写了一半的 JSON
 * （读坏会退回空状态 = 全员零 shadow，比丢一次计数更糟）。
 * 注意：原子写只防「撕裂」，丢更新由 `withStateLock` 治 —— 本文件所有状态写入都必须在锁内。
 */
export function writeStrictState(p, state) {
  try {
    mkdirSync(path.dirname(p), { recursive: true })
    atomicWrite(p, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return p
  } catch (e) {
    throw new LifecycleError(`状态写入失败: ${p} — ${e.message}`)
  }
}

/**
 * 状态账互斥锁（与 run-guard 的记账段同一把锁，锁序：状态账锁 → 审计锁，绝不反向）。
 *
 * 本文件三个生命周期动作都是「读状态 → 改条目/搬文件 → 写状态」的读-改-写，
 * 与派发器并发时会把对方刚记的命中账整段覆盖掉（票 H2）。故动作全程持锁，并在**锁内重读**状态。
 * 拿不到锁 = 硬失败（LifecycleError）：本文件刻意**不** fail-open —— 退役/回写失败必须显性返回。
 */
export function withStateLock(statePath, fn) {
  const locked = withStateFileLock(statePath, fn)
  if (locked === null) throw new LifecycleError(`状态锁获取失败（另一进程正在改账，未做任何改动）: ${statePath}.lock`)
  return locked
}

/**
 * 在目录里列出匹配某 ID 的**全部**条目文件名（`<ID>-<slug>.md` 或 `<ID>.md`），已排序。
 *
 * 为什么要有「复数」形态（架构审计 F2/B2 · 2026-10-16）：同一 ID 被多条教训占用是**存量事实**
 * （本仓 85 条里 7 组撞号、覆盖 15 个文件）。按 ID 定位文件时若取「第一个匹配」，撞号即静默取错：
 * 观测账记到 A 的命中会被 sweep 回写进 B 的正文，退役证据张冠李戴，`--restore` 张冠李戴搬回。
 * 故定位一律先拿全集，命中 >1 即判定**歧义**并显式拒绝（见 findEntryFile）。
 */
export function findEntryFiles(dir, id) {
  if (!existsSync(dir)) return []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.endsWith('.md') && (n === `${id}.md` || n.startsWith(`${id}-`))).sort()
}

/**
 * 在目录里定位**唯一**条目文件（`<ID>-<slug>.md` 或 `<ID>.md`）。
 *
 * 返回 `null` 有两种含义，由调用方按自身语义区分（都属「拿不准就不动」）：
 *   - 不存在（0 个匹配）；
 *   - **歧义**（≥2 个匹配，即撞号 ID）—— 绝不静默取第一个。
 * 需要区分二者的调用方用 findEntryFiles 自己判。
 */
export function findEntryFile(dir, id) {
  const hits = findEntryFiles(dir, id)
  return hits.length === 1 ? hits[0] : null
}

/** 撞号 ID 的统一报错文案（sweep / restore / retire 共用，避免三处措辞漂移）。 */
export function ambiguousIdError(id, dir, names) {
  return `编号 ${id} 在 ${dir} 下命中 ${names.length} 个条目（撞号，ID 不再能唯一定位）：${names.join('、')}。`
    + '撞号 ID 上的观测账无法判定属于哪一条（记账会互相污染、退役证据张冠李戴），'
    + '本次一律不按该 ID 动作 —— 请改用完整文件名定位，或先消除撞号（判据 = D6 编号唯一性）。'
}

function replaceOnce(src, re, to) {
  return re.test(src) ? src.replace(re, to) : src
}

/**
 * 按 frontmatter **源码行**改写 `recurrence` 与 `last_verified_at`（不重排全文、不重序列化 YAML）。
 * 判据只此一份（此前在 run-guard.mjs 内，票 11 按「高频记账下沉运行时」把它迁到这里）。
 * `to` 供崩溃恢复重放用：目标值取自账上记录的本次 sweep 起点，不取文件当前值（否则重放会二次累加）。
 * @returns {{text:string, ok:boolean, reason?:string, prev?:number, next?:number}}
 */
export function bumpFrontmatter(text, { delta, today, to = null }) {
  const src = /^recurrence: (\d+)\r?$/m.exec(text)
  if (!src) {
    return { text, ok: false, reason: 'frontmatter 缺 recurrence 行（契约要求必填，见 schema.md §1.1）' }
  }
  const prev = Number(src[1])
  const next = to === null ? prev + delta : to
  let out = replaceOnce(text, /^recurrence: (\d+)\r?$/m, `recurrence: ${next}`)
  // last_verified_at 必须带引号写：裸日期两条 YAML 后端解法相反（schema.md §1.4 同款理由）。
  out = replaceOnce(out, /^last_verified_at: null\r?$/m, `last_verified_at: "${today}"`)
  out = replaceOnce(out, /^last_verified_at: "\d{4}-\d{2}-\d{2}"\r?$/m, `last_verified_at: "${today}"`)
  return { text: out, ok: true, prev, next }
}

/** 对质段：每次命中一段，历史段落一字不动（append-only 的形状，追加在正文末尾）。 */
export function confrontationBlock(records, { from }) {
  const lines = []
  records.forEach((rec, i) => {
    const n = from + i + 1
    lines.push('')
    lines.push(`### 复发 ${n} · ${rec.date}`)
    lines.push('')
    lines.push(`- 证据：守卫 \`${rec.guard}\` 于 ${rec.date} 命中判据被拦截（blocking · exit 2）。`)
    lines.push(`- 回写：本次 sweep 记 \`recurrence\` ${n - 1} → ${n}、\`last_verified_at\` "${rec.date}"（verify.mjs --sweep）。`)
  })
  lines.push('')
  lines.push('> 历史段落零改动：以上各段按命中顺序追加在正文末尾，既有内容按字节原样保留。')
  return `${lines.join('\n')}\n`
}

// ===== --sweep：账本 → 仓内条目（唯一的回写口）=====

/**
 * 回写按「两阶段记账」做，保证崩溃后重跑既不双记也不吞账：
 *   ① 先把本次 sweep 的起点（`sweep_inflight` = 本次要写的起始 recurrence + 命中明细）**落盘**；
 *   ② 再改条目；③ 最后清 `sweep_inflight` 与 pending。
 *   重跑时若账上还有 inflight：以**账上记录的起点**重放（不取文件当前值，避免二次累加）；
 *   若文件已经是目标值（上次崩在 ② 之后），只做 ③ 收尾（报告 already-applied）。
 * 为什么必须记账而不是看正文找标记：同一守卫同一天的两次命中证据行完全相同，靠正文判重会误吞新账。
 */
export function sweep({ config, baseDir, state, statePath, dryRun = false }) {
  const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
  const ledger = state.entries && typeof state.entries === 'object' ? state.entries : {}
  const report = []
  const audit = []
  // probe 账先清（独立一遍）：它不碰条目、不碰 recurrence，判据也不依赖条目文件是否存在
  // —— 人造违规不该在「条目被删/被退役」时把整个 sweep 打成硬失败。
  for (const r of sweepProbes({ ledger, state, statePath, dryRun })) {
    report.push(r)
    audit.push({ action: 'sweep-probe', entry: r.id, probes: r.probes })
  }
  for (const id of Object.keys(ledger).sort()) {
    const rec = ledger[id]
    const inflight = rec.sweep_inflight && typeof rec.sweep_inflight === 'object' ? rec.sweep_inflight : null
    const records = (Array.isArray(inflight?.records) ? inflight.records : Array.isArray(rec.pending_records) ? rec.pending_records : []).filter(
      (r) => r && typeof r.date === 'string',
    )
    if (records.length === 0) continue
    const hits = findEntryFiles(entriesDir, id)
    // 撞号 ID（≥2 个匹配）：账上的 pending_records 无法判定属于哪一条，回写进任意一条都是**污染**
    // （把别的条目的命中数写进这条正文）。显式硬失败，不猜。
    if (hits.length > 1) throw new LifecycleError(ambiguousIdError(id, entriesDir, hits))
    const name = hits[0] ?? null
    // 账上有待回写命中、活动区却找不到文件 = 事实损坏（条目被删/被退役）。静默跳过等于吞掉命中 → 硬失败。
    if (!name) {
      throw new LifecycleError(`待回写条目在活动区不存在: ${id}（${entriesDir} 下无 ${id}-*.md；先 restore 或人工清账）`)
    }
    const abs = path.join(entriesDir, name)
    const text = readFileSync(abs, 'utf8')
    const today = records[records.length - 1].date
    const prev = inflight && Number.isInteger(inflight.prev_recurrence) ? inflight.prev_recurrence : null
    const target = prev === null ? null : prev + records.length
    const bumped = bumpFrontmatter(text, { delta: records.length, today, to: target })
    if (!bumped.ok) throw new LifecycleError(`回写失败 ${name}: ${bumped.reason}`)
    if (inflight && bumped.prev === target && text.includes(`last_verified_at: "${today}"`)) {
      // 上次崩在「条目已写、账未清」之后 → 只收尾，不二次回写。
      report.push({ id, name, status: 'already-applied', hits: records.length, recurrence: `${target}（上次已回写）` })
      if (!dryRun) {
        clearPending(ledger, id, rec)
        writeStrictState(statePath, state)
      }
      continue
    }
    // 对质段编号接在本次 sweep 起点之后（from = 回写前的值），否则段落编号会从 1 重来。
    const block = confrontationBlock(records, { from: bumped.prev })
    const nextText = `${bumped.text.trimEnd()}\n${block}`
    report.push({ id, name, status: dryRun ? 'would-sweep' : 'swept', hits: records.length, recurrence: `${bumped.prev} → ${bumped.next}`, last_verified_at: today })
    audit.push({ action: 'sweep', entry: id, file: name, hits: records.length, recurrence_before: bumped.prev, recurrence_after: bumped.next, last_verified_at: today })
    if (dryRun) continue
    if (!inflight) {
      ledger[id] = { ...ledger[id], sweep_inflight: { prev_recurrence: bumped.prev, records } }
      writeStrictState(statePath, state) // ① 先记账：崩了也知道这次该写什么
    }
    atomicWrite(abs, nextText, 'utf8') // ② 改条目（原子写：并发读条目的一方不会读到半截 frontmatter）
    clearPending(ledger, id, rec) // ③ 清账
    writeStrictState(statePath, state)
  }
  return { swept: report.filter((r) => r.status === 'swept').length, probes_closed: report.filter((r) => r.status === 'probes-closed').length, report, audit }
}

/**
 * probe 账清账（`pending_probes` → `swept_probes`）：**只清账，不碰条目**。
 *
 * 为什么 sweep 要管它（这是拍5 拆源后最容易漏的一处）：拍5 现在接受 probe 证据判绿，
 * 而拍6 依赖 `swept_hits > 0`（它从 `pending_hits` 派生、而 `pending_hits` 只在 wild 命中时递增）。
 * 若拍6 不跟着改，probe-only 的链会从「拍5 红」变成「拍6 红」，这次改动等于完全无效。
 * 所以 probe 命中也必须有一条**闭环动作**：跑一次 `--sweep` 把这份探针证据结账，
 * 于是「探针证明了守卫能用」这条事实有了可核查的落点（账上 `swept_probes`），
 * 而条目正文（recurrence / last_verified_at / 对质段）保持只有 wild 才能改写。
 *
 * 幂等与崩溃恢复：probe 清账不动任何外部文件，一次原子写就是全部 —— 不需要 `sweep_inflight`
 * 那种两阶段记账（那是为了「条目已写、账未清」的重放；这里根本没有条目写入这一腿）。
 */
function sweepProbes({ ledger, state, statePath, dryRun }) {
  const out = []
  for (const id of Object.keys(ledger).sort()) {
    const rec = ledger[id]
    if (!rec || typeof rec !== 'object') continue
    const probes = (Array.isArray(rec.pending_probe_records) ? rec.pending_probe_records : []).filter((r) => r && typeof r.date === 'string')
    if (probes.length === 0) continue
    out.push({
      id,
      name: null,
      status: dryRun ? 'would-close-probes' : 'probes-closed',
      probes: probes.length,
      recurrence: '不变（probe 命中不写回条目：recurrence / last_verified_at / 对质段只认 wild）',
    })
    if (dryRun) continue
    const pending = Number.isInteger(rec.pending_probes) ? rec.pending_probes : probes.length
    ledger[id] = {
      ...rec,
      pending_probes: 0,
      pending_probe_records: [],
      swept_probes: (Number.isInteger(rec.swept_probes) ? rec.swept_probes : 0) + pending,
      last_probe_swept_at: new Date().toISOString(),
    }
    writeStrictState(statePath, state)
  }
  return out
}

/** wild 命中清账（`pending_hits` → `swept_hits`）。**只服务 wild**：probe 命中走 sweepProbes，
 *  绝不允许在这里被抬进 `recurrence` / 正文对质段（那会把人造违规写成「野外复发」）。 */
function clearPending(ledger, id, rec) {
  const pending = Number.isInteger(rec.pending_hits) ? rec.pending_hits : 0
  const { sweep_inflight, ...rest } = rec
  ledger[id] = {
    ...rest,
    pending_hits: 0,
    pending_records: [],
    swept_hits: (Number.isInteger(rec.swept_hits) ? rec.swept_hits : 0) + pending,
    last_swept_at: new Date().toISOString(),
  }
}

// ===== --retire：长期不响 → 移入 archive（只移动，不改内容）=====

const daysBetween = (fromIso, now) => {
  const t = Date.parse(fromIso)
  if (Number.isNaN(t)) return null
  return (now.getTime() - t) / 86_400_000
}

/**
 * 退役周期天数（`config.retire.cycle_days`，缺省 90）。**唯一一份**。
 *
 * trace.mjs 拍5 的 probe 有效期也用这个数（「探针证据多久算数」与「守卫多久算长期不响」
 * 是同一个尺子：两个地方各写一个 90，迟早漂成两个数）。故它从本模块导出，
 * trace 消费它，而不是自己再定义一个常量。
 */
export function retireCycleDays(config) {
  const n = Number(config?.retire?.cycle_days)
  return Number.isFinite(n) && n > 0 ? n : 90
}

/**
 * 退役判据（逐条返回跳过理由；返回 null = 满足退役条件）。判据是单一归宿，测试与文档都消费它。
 *
 * 收紧到**六条**（票 H1 · 证伪机制被反向武器化的堵口）：前两条是「账够不够」，
 * 后四条是「守卫本身配不配拿它的沉默当证据」。没有后四条，一个恒 `exit 0` 或恒报错的空守卫
 * 攒够 3 次绿灯就能升 blocking，再用它「长期覆盖且从不命中」的假证据把它 `covered_entries`
 * 里的**真实经验条目整批移出知识库** —— 这正是「无人命中」与「没人在看」被混同的形状。
 *
 * @param {object} fm 条目 frontmatter（`last_verified_at` 门禁用）
 * @param {object} rec 状态账 `state.entries[id]`（观测账）
 * @param {{cycleDays:number, now:Date, guards?:object}} opts `guards` = `state.guards`（守卫级账）
 */
export function retireSkipReason(fm, rec, { cycleDays, now, guards = {} }) {
  if (!rec || !Number.isInteger(rec.observed_runs) || rec.observed_runs <= 0) {
    const errored = rec && Number.isInteger(rec.observed_error_runs) && rec.observed_error_runs > 0
      ? `（另有 ${rec.observed_error_runs} 次守卫异常派发 —— 判据没跑起来，不算观测）`
      : ''
    return `状态账无观测记录（守卫从未覆盖派发过它）—— 不是「无人命中」，是没证据${errored}`
  }
  if (Number.isInteger(rec.pending_hits) && rec.pending_hits > 0) return `有 ${rec.pending_hits} 笔命中未回写（先跑 --sweep）`
  // 分型前的历史命中属 legacy-unknown：它**既不算 wild 也不能当「从未命中」** ——
  // 来源不可知的一根柱子，退役（不可逆、删真知识）不拿它当任何一侧的证据。
  if (Number.isInteger(rec.legacy_hits) && rec.legacy_hits > 0) {
    return `历史命中 ${rec.legacy_hits} 次属 legacy-unknown（分型前野外与探针同账，来源不可知）—— 未归型不构成「从未命中」，不退役`
  }
  if (Number.isInteger(rec.wild_hits) && rec.wild_hits > 0) return `曾野外出事 ${rec.wild_hits} 次 —— 守卫在野外响过，不是长期不响`

  // ===== 以下三条是「守卫的沉默配不配当证据」，缺一即退役不得 =====
  const keys = Array.isArray(rec.guard_keys) ? rec.guard_keys.filter((k) => typeof k === 'string' && k !== '') : []
  if (keys.length === 0) return '观测账未登记覆盖守卫（covered_entries 为空的守卫不产生观测账）—— 没有覆盖者就没有退役证据'
  // `injected === true` 的守卫账**不计入 blocking 门槛**：`--inject-state` 是夹具注入口，
  // 它的 mode=blocking 是写进去的、不是跑出来的。退役是本系统唯一的不可逆动作，
  // 拿注入状态冒充「真挣到拦截权」= 伪造证据（与 probe 不置 ever_hit 同源：自证不兑换不可逆动作的资格）。
  const injected = keys.filter((k) => guards[k] && guards[k].injected === true)
  const blocking = keys.filter((k) => guards[k] && guards[k].mode === 'blocking' && guards[k].injected !== true)
  if (blocking.length === 0) {
    return injected.length === keys.length
      ? `覆盖它的守卫拦截权全部来自 --inject-state 注入状态（injected=true: ${injected.join(', ')}）—— 注入出来的 blocking 是假的，不产生退役证据`
      : `覆盖它的守卫都还在 shadow（${keys.join(', ')}）—— 未挣到拦截权的守卫不产生退役证据`
        + (injected.length > 0 ? `（其中 ${injected.join(', ')} 为注入状态，不计作拦截权）` : '')
  }
  // ever_hit 只由 **wild** 命中置位（run-guard.mjs --probe 的人造违规永不置位）：
  // 「守卫响过」必须是野外事实，自证不算 —— 否则一次破坏测试就换到清空真实条目的资格。
  const fired = blocking.filter((k) => guards[k].ever_hit === true)
  if (fired.length === 0) {
    const legacy = blocking.filter((k) => Number.isInteger(guards[k]?.legacy_ever_hit) && guards[k].legacy_ever_hit === 1)
    return `覆盖它的守卫判据从未在野外命中过任何东西（${blocking.join(', ')}）—— 沉默不含信息量，不产生退役证据`
      + (legacy.length > 0 ? `（其中 ${legacy.join(', ')} 存在 legacy-unknown 的历史命中：来源不可知，一律不作 wild 证据，不追溯追认退役资格）` : '')
  }
  const idleDays = daysBetween(String(rec.last_observed ?? ''), now)
  if (idleDays === null) return '观测账无 last_observed 时间戳 —— 无法判定是否长期不响'
  if (idleDays < cycleDays) return `守卫近期仍在派发（${idleDays.toFixed(1)} 天 < ${cycleDays} 天）`
  const verified = fm && typeof fm.last_verified_at === 'string' ? fm.last_verified_at : null
  if (verified !== null) {
    const vDays = daysBetween(`${verified}T00:00:00Z`, now)
    if (vDays !== null && vDays < cycleDays) return `last_verified_at 距今 ${vDays.toFixed(1)} 天 < ${cycleDays} 天`
  }
  return null
}

export function retire({ config, baseDir, state, statePath, dryRun = false, now = new Date() }) {
  const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
  const archiveDir = archiveDirPath(config, baseDir)
  const cycleDays = retireCycleDays(config)
  const ledger = state.entries && typeof state.entries === 'object' ? state.entries : {}
  const guards = state.guards && typeof state.guards === 'object' ? state.guards : {}
  if (!existsSync(entriesDir)) throw new LifecycleError(`活动区不存在: ${entriesDir}`)
  // 跨副本语义前置校验：退役区若不入库，移动就不是「移动」而是「对别人不可逆的删除」。
  // dry-run 也照样校验 —— dry-run 的用途正是让人在动手前看到这类拦路条件。
  const share = archiveIsShareable(archiveDir, baseDir)
  if (share.ignored) {
    throw new LifecycleError(
      `退役区被 git 排除，退役将不可跨副本共享（拒绝执行）: ${archiveDir}${share.via ? `（命中 ${share.via}）` : ''}\n`
      + '  后果：归档副本不入库 ⇒ 提交后别人拉取到的只是「活动区一条删除」，条目正文在他们那边**没有任何副本**；\n'
      + '  而 --restore 只恢复本机。证据充分 ≠ 搬过去对别人安全 —— 这是两个正交维度，后者不能靠人记文档。\n'
      + '  三条出路（选一）：\n'
      + '    ① 退役区改为**入库**路径（改 config.storage.archive_dir 到受跟踪目录，推荐 —— 归档本就该共享）；\n'
      + '    ② 退役改为「只改 status 不移动文件」（正文留在活动区、共享可见，需要契约支持 status 语义）；\n'
      + '    ③ 接受「退役 = 本机私有归档」并在 schema.md 与团队约定里**显式声明**该语义（跨副本不可见、恢复不跨机）。',
    )
  }
  const names = readdirSync(entriesDir).filter((f) => f.endsWith('.md') && !NON_ENTRY_BASENAMES.has(f)).sort()
  // 撞号 ID → 观测账键共用一个 entry，两条教训的证据混在一起（2026-10-16 审计 F2/B2）。
  // 退役是**不可逆**动作：拿混合证据去退役其中任意一条，等于用别的条目的证据删掉这条。
  // 故撞号条目一律跳过并如实报出，不靠「证据够强」放行。
  const idHits = new Map()
  for (const n of names) {
    const i = entryIdFromName(n)
    if (!i) continue
    if (!idHits.has(i)) idHits.set(i, [])
    idHits.get(i).push(n)
  }
  const report = []
  const audit = []
  for (const name of names) {
    const id = entryIdFromName(name)
    if (!id) {
      report.push({ name, status: 'skipped', reason: '文件名不含可识别条目 ID（契约见 schema.md §1.3）' })
      continue
    }
    if ((idHits.get(id) ?? []).length > 1) {
      report.push({ id, name, status: 'skipped', reason: ambiguousIdError(id, entriesDir, idHits.get(id)) })
      continue
    }
    const abs = path.join(entriesDir, name)
    const { fm, error } = extractFrontmatter(readFileSync(abs, 'utf8'))
    if (error) {
      report.push({ name, status: 'skipped', reason: `${error} —— 无法判定退役` })
      continue
    }
    const reason = retireSkipReason(fm, ledger[id], { cycleDays, now, guards })
    if (reason !== null) {
      report.push({ id, name, status: 'skipped', reason })
      continue
    }
    const target = path.join(archiveDir, name)
    if (existsSync(target)) {
      throw new LifecycleError(`退役目标已存在: ${target}（重复退役 / 与历史归档同名冲突，拒绝覆盖）`)
    }
    // 证据强度随行报出（人审闸门：能退役 ≠ 证据很强，weak 档的守卫历史值得看一眼）
    const covering = (Array.isArray(ledger[id]?.guard_keys) ? ledger[id].guard_keys : [])
      .map((k) => evidenceStrength(guards[k] ?? {}))
    report.push({
      id,
      name,
      status: dryRun ? 'would-retire' : 'retired',
      archive: path.relative(baseDir, target).split(path.sep).join('/'),
      idle_days: Number(daysBetween(String(ledger[id].last_observed), now).toFixed(1)),
      guard_errors: Number.isInteger(ledger[id].observed_error_runs) ? ledger[id].observed_error_runs : 0,
      evidence: covering.includes('strong') ? 'strong' : covering.includes('weak') ? 'weak' : covering[0] ?? 'no-evidence',
    })
    audit.push({ action: 'retire', entry: id, file: name, archive: report[report.length - 1].archive, last_observed: ledger[id].last_observed, cycle_days: cycleDays })
    if (!dryRun) {
      mkdirSync(archiveDir, { recursive: true })
      try {
        renameSync(abs, target)
      } catch (e) {
        throw new LifecycleError(`移入退役区失败 ${name} → ${target}: ${e.message}`)
      }
      ledger[id] = { ...ledger[id], archived_at: new Date(now).toISOString(), archive_path: report[report.length - 1].archive }
    }
  }
  if (!dryRun && audit.length > 0) writeStrictState(statePath, state)
  return { retired: report.filter((r) => r.status === 'retired').length, skipped: report.filter((r) => r.status === 'skipped').length, report, audit }
}

// ===== --restore：archive → 活动区（字节级可逆）=====

export function restore({ config, baseDir, state, statePath, id, dryRun = false }) {
  const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
  const archiveDir = archiveDirPath(config, baseDir)
  // 退役区撞号：先判歧义再取名 —— 此前 findEntryFile 静默取第一个，
  // 「--restore <ID>」会把**别的**条目搬回活动区（2026-10-16 审计实测：撞号时取首个）。
  const archived = findEntryFiles(archiveDir, id)
  if (archived.length > 1) throw new LifecycleError(ambiguousIdError(id, archiveDir, archived))
  const name = archived[0] ?? null
  if (!name) throw new LifecycleError(`退役区无此条目: ${id}（${archiveDir} 下无 ${id}-*.md —— 先确认 ID 与退役区路径）`)
  const active = findEntryFiles(entriesDir, id)
  if (active.length > 1) throw new LifecycleError(ambiguousIdError(id, entriesDir, active))
  if (active.length === 1) {
    throw new LifecycleError(`活动区已存在 ${id} 的条目（restore 会覆盖并丢失改动，拒绝）`)
  }
  const src = path.join(archiveDir, name)
  const target = path.join(entriesDir, name)
  if (dryRun) return { restored: 0, report: [{ id, name, status: 'would-restore', target: path.relative(baseDir, target).split(path.sep).join('/') }] }
  try {
    renameSync(src, target)
  } catch (e) {
    throw new LifecycleError(`恢复失败 ${name}: ${e.message}`)
  }
  const ledger = state.entries && typeof state.entries === 'object' ? state.entries : {}
  if (ledger[id]) {
    const { archived_at, archive_path, ...rest } = ledger[id]
    ledger[id] = { ...rest, restored_at: new Date().toISOString() }
  }
  writeStrictState(statePath, state)
  return { restored: 1, report: [{ id, name, status: 'restored', target: path.relative(baseDir, target).split(path.sep).join('/') }] }
}

// ===== CLI =====

function usage(msg) {
  console.error(`用法错误：${msg}
  node verify.mjs --sweep                       账本 → 条目回写（recurrence / last_verified_at + 末尾对质段）
  node verify.mjs --retire                      长期不响且证据充分 → 整文件移入 archive（不改内容）
  node verify.mjs --restore <ID>                archive → 活动区（可逆，字节级还原）
  通用参数：--dry-run --json --config <p> --project-dir <d>
  退出码：0=完成 / 1=证据不足或事实损坏（显性失败）/ 2=用法错误`)
  return 2
}

export function main(argv) {
  let cliConfig = null
  let projectDir = process.cwd()
  let action = null
  let target = null
  let dryRun = false
  let wantJson = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sweep' || a === '--retire') {
      if (action !== null) return usage(`一次只做一个动作（已给 --${action}）`)
      action = a.slice(2)
      continue
    }
    if (a === '--restore') {
      if (action !== null) return usage(`一次只做一个动作（已给 --${action}）`)
      action = 'restore'
      target = argv[i + 1]
      if (!target || target.startsWith('--')) return usage('--restore 后须跟条目 ID')
      i++
      continue
    }
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--json') { wantJson = true; continue }
    if (a === '--config' || a === '--project-dir') {
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) return usage(`${a} 后须跟值`)
      i++
      if (a === '--config') cliConfig = path.resolve(next)
      else projectDir = path.resolve(next)
      continue
    }
    return usage(`未知参数 ${a}`)
  }
  if (action === null) return usage('须给 --sweep / --retire / --restore <ID>')

  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    return usage(`配置链失败: ${e.message}`)
  }

  try {
    // 生命周期动作全程持**状态账锁**（与 run-guard 记账段同一把），并在锁内重读状态：
    // 否则与并发派发互相整段覆盖命中账（票 H2）。flushAudit 在锁外（锁序：状态锁 → 审计锁）。
    // --dry-run 不持锁：它零写盘，而取锁本身会建出锁目录 —— 「零写盘」是本文件的契约，不能被锁破坏
    // （只读期与并发写并发是安全的：写方一律原子写，读方只会看到旧版或新版完整账）。
    const statePath = guardStatePath(config, baseDir)
    const runAction = () => {
      // --retire 必须有账才有证据（required=true：缺文件直接红）；sweep/restore 无账即无事可做。
      const { state, exists } = readStrictState(config, baseDir, { required: action === 'retire' })
      // 存量保守回填（幂等）：分型前的 `hits` / `ever_hit` 属 legacy-unknown（野外与探针同账，
      // 来源不可知），不追溯追认 wild。本次动作的判据就建立在归型后的账上，故改了就得落盘
      // （dry-run 零写盘纪律不动 —— 它只是视图，不改事实）。
      if (exists) {
        const norm = normalizeHitLedger(state)
        if (norm.changed && !dryRun) {
          writeStrictState(statePath, state)
          console.error(`[verify] 命中账已按 wild/probe 两型归型（守卫 ${norm.guards} 条 / 条目 ${norm.entries} 条历史命中归 legacy-unknown，不追溯追认 wild 证据）`)
        }
      }
      if (action === 'sweep') {
        return exists
          ? sweep({ config, baseDir, state, statePath, dryRun })
          : { swept: 0, report: [], note: '无状态文件：暂无命中账，无事可回写' }
      }
      if (action === 'retire') return retire({ config, baseDir, state, statePath, dryRun })
      return restore({ config, baseDir, state, statePath, id: target, dryRun })
    }
    const result = dryRun ? runAction() : withStateLock(statePath, runAction)
    flushAudit(config, baseDir, [{ tool: 'verify', action, dry_run: dryRun, summary: { ...result, audit: undefined } }, ...(result.audit ?? [])])
    printReport(action, target, result, dryRun)
    if (wantJson) process.stdout.write(`${JSON.stringify({ action, dry_run: dryRun, ...result }, null, 2)}\n`)
    return 0
  } catch (e) {
    // 生命周期动作一律**不** fail-open：退役/回写失败必须显性返回，不许像派发器那样吞成绿。
    console.error(`[verify] ${action} 失败: ${e.message}`)
    createLogger({ module: 'verify', baseDir, config }).error(`${action} 失败: ${e.message}`, e instanceof Error ? e : null)
    return 1
  }
}

function printReport(action, target, result, dryRun) {
  const tag = dryRun ? '（dry-run：零写盘）' : ''
  if (action === 'sweep') {
    console.error(`[verify] sweep ${tag}：回写 ${result.swept} 条条目 · 结清 probe 账 ${result.probes_closed ?? 0} 条（probe 不写条目正文）`)
    for (const r of result.report) {
      console.error(r.status === 'probes-closed' || r.status === 'would-close-probes'
        ? `  ${r.id} · ${r.status} · probe 命中 ${r.probes} 次已结账 · ${r.recurrence}`
        : `  ${r.name} · ${r.status} · 命中 ${r.hits} 次${r.recurrence ? ` · recurrence ${r.recurrence} · last_verified_at ${r.last_verified_at}` : ''}`)
    }
    if (result.note) console.error(`  ${result.note}`)
    if (result.report.length === 0) console.error('  无待回写命中（账已清或从无命中）')
    return
  }
  if (action === 'retire') {
    console.error(`[verify] retire ${tag}：退役 ${result.retired} 条 · 保守跳过 ${result.skipped} 条`)
    for (const r of result.report) console.error(`  ${r.name} · ${r.status}${r.reason ? ` · ${r.reason}` : ''}${r.archive ? ` · → ${r.archive}` : ''}`)
    return
  }
  console.error(`[verify] restore ${target} ${tag}：${result.restored === 1 ? '已移回活动区（字节级还原）' : 'dry-run 通过'}`)
  for (const r of result.report) console.error(`  ${r.name} · ${r.status} · → ${r.target}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
