#!/usr/bin/env node
/**
 * run-guard.mjs —— 守卫派发器（通用技能，零项目耦合，宿主可跑）
 *
 * 角色：registry 里登记的每个守卫由本文件派发。**它存在的原因只有一个：拦截权要挣，不是注册即得。**
 *   registry 的 `args` 指向本文件（直调 node，不经包管理器 run 层），本文件按条目的 `command`
 *   直调真守卫，然后按 §3 的 shadow 契约裁决退出码：
 *     - 新守卫前 `shadow_required` 次（默认 3，可由条目 `shadow_required` 覆盖）= **warn-only**：
 *       命中判据只警告、不阻断（exit 0）；
 *     - `shadow_runs ≥ shadow_required && shadow_green === shadow_runs` → 自动升 **blocking**，此后命中即阻断；
 *     - 守卫进程返回 **2 = 命中判据（阻断）/ 0 = 放行 / 其他码或起不来 = 守卫自身异常 → fail-open**：
 *       记审计 + `last_result: error` + exit 0，绝不因为守卫自己坏了而卡住提交。
 *
 * 用法：node run-guard.mjs --key <key> [--text <s>|--stdin] [--probe] [--all] [--dry-run] [--config <p>] [--project-dir <d>] [--inject-state <json>] [--json]
 *   --key   派发单个已登记守卫（key 不存在 → exit 2）
 *   --all   派发全部守卫（debt-stub 桩跳过；任一 blocking 守卫命中 → 整体 exit 2）
 *   --text/--stdin  把一段文本喂给守卫（守卫 argv 追加 `--input-stdin`）；不给则守卫自取判据输入
 *   --probe **本次派发是人造的验证（破坏测试），不是野外捕获**：照常派发守卫、照常按 exit 2 阻断，
 *           唯一区别是命中记到 **probe 账**（`probe_hits`），**永不置 `ever_hit`**（schema.md §3.1）。
 *           理由见「两型命中记账」段 —— 两者走同一个 CLI 入口，账上不拆开就等于让人造违规
 *           换到「用这份守卫退役真实经验条目」的资格。
 *   --dry-run  零 spawn 零写盘，只读 registry + 状态文件，逐条报 `evidence=strong/weak/debt/no-evidence`
 *              （人审闸门：恒 exit 0 的空守卫在旧报表里与真守卫长得一样）
 *   --inject-state '<json>' **仅供测试/夹具**：把 `{"<守卫key>": {…守卫级字段}}` 直接并进守卫级状态账，
 *              让夹具一步造出「已挣到 blocking 的守卫」，不必靠反复派发碰巧攒够绿运行
 *              （晋升条件是 `shadow_green === shadow_runs`，只要其中一次真命中就永远攒不满 ——
 *               这正是间歇性红测试的根因）。作用域**只有 `state.guards` 守卫级账段**，
 *              条目观测账 `state.entries` 不可注入 —— 那根柱子直通退役证据（wild_hits），
 *              能注入就等于自己给自己签发退役资格。与 `--all` / `--dry-run` 互斥；
 *              注入后该守卫账上打 `injected: true`，**读侧一律不认**（见「注入状态不可当证据」段）。
 *
 * 退出码：0 = 放行（含 warn-only 命中与 fail-open）/ 1 = 内部错误（仅 runner 自身挂掉）/ 2 = 命中判据阻断 或 用法错误。
 *
 * ===== 状态落位（schema.md §3「运行时字段落位」的收口结论）=====
 *   静态字段（key/args/when/kind/path/command/covered_entries/shadow_required）随 registry 入仓；
 *   运行时字段（last_run / last_result / last_run_ms / shadow_runs / shadow_green / mode / promoted_at）
 *   落**本地 gitignored 状态文件** —— 每次 commit 都变的字段写进仓内 registry 会造成无意义 churn。
 *   路径 = `config.storage.guard_state`，缺省取 `dirname(config.storage.events_dir)/guard-state.json`
 *   （与事件/提案同一被排除目录，仓内零 diff）。
 *
 * ===== 命中记账也在这层（票 11 裁决，票 10 行为已随之下沉）=====
 *   票 10 的 blocking 命中会直接改写仓内条目的 `recurrence` / `last_verified_at`；票 11 起改为：
 *   命中只往状态文件的 `entries` 段追加**观测账 + 待回写明细**（`pending_records`），
 *   仓内条目由 `verify.mjs --sweep` 显式回写（一条 commit 粒度的可审计写入）。
 *   理由：命中是高频事件（每次拦截都发生），每命中一次就弄脏一次仓内文件是纯 churn；
 *   而「证伪」要留痕的地方是条目正文末尾的对质段，不是每次拦截都改一次 frontmatter。
 *
 * ===== 两型命中记账：wild（野外）vs probe（探针）=====
 *   命中有两种来源，证据强度差一个数量级：
 *     wild  = 真实路由上捕获的失效（`run-guard.mjs --key k --text s`，不带 `--probe`）；
 *     probe = 我们自己造一条违规输入、去验证守卫「真能拦」的破坏测试（`--probe`，stoploss.md §4 解冻那步）。
 *   两者走**同一个 CLI 入口**，不拆账就等于「人造违规」与「野外真复发」不可分：
 *   一次破坏测试就能换来 90 天后用这份守卫**退役真实经验条目**的资格（`verify.mjs` 退役链读
 *   守卫级 `ever_hit`）。故本文件的硬纪律：
 *     - `ever_hit` **只由 wild 置位**，probe 永远不置（这是本改动的核心）；
 *     - `shadow_warn` 算 **wild**（它仍是真实路由上的 warn-only 捕获，只是还没挣到阻断权）；
 *     - probe 命中**只进 probe 账**（`probe_hits` / `pending_probes`），不回写条目正文对质段
 *       （见 verify.mjs --sweep 的分型回写）；
 *     - 存量状态文件里的历史 `hits` / `ever_hit` 属 **legacy-unknown**（无法区分是野外还是探针），
 *       **不回填成 wild**，且既有 `ever_hit` 不再充当 wild 证据（老守卫不因历史命中被追溯追认退役资格）。
 *
 * ===== 注入状态（`--inject-state`）不可当证据 =====
 *   `--inject-state` 是**测试/夹具专用**的注入口：它能让夹具一步构造出「已挣到 blocking 的守卫」。
 *   它伪造的是**拦截权**，而拦截权在本系统里不是装饰 —— 它是 trace 拍4 与 verify 退役判据的门槛。
 *   所以注入必须自带「打了假章」的可见标记，并且**读侧必须能看见这个章**：
 *     - 注入只碰 `state.guards`（守卫级账），不碰 `state.entries`（条目观测账直通 wild_hits 退役证据）；
 *     - 每个被注入的守卫账上强制写 `injected: true` + `injected_at` + `injected_fields`（谁注了哪些字段）；
 *     - `evidenceStrength` 对 `injected === true` 的守卫一律返回 `injected` 档（不判 strong）；
 *     - trace.mjs 拍4「守卫运行」与 verify.mjs 的退役 blocking 门槛，凡 `injected === true` 一律不算数；
 *     - 与 `--all` / `--dry-run` 互斥，且每次注入都 flushAudit 留痕（`action: guard-inject`）。
 *   理由与本文件「probe 永不置 ever_hit」完全同源：**自证不得兑换不可逆动作的资格**，
 *   否则任何人造构造都能拿来签发退役真实经验条目的资格 —— 正是本仓反复在治的那类问题。
 *
 * ===== O(1) spawn 纪律 =====
 *   每个守卫**一次** spawn（spawnSync），全流程不按文件起子进程；registry 与状态文件都是常数次读取。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadContext, flushAudit } from './inject.mjs'
import { parseYaml } from './lib/yaml-lite.mjs'
import { atomicWrite, withFileLock } from './lib/atomic-file.mjs'
import { createLogger } from './lib/log.mjs'

/** 同步短睡（零依赖）：锁内重试读状态时用，保持临界区语义不引入异步。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 新守卫挣拦截权所需的默认 shadow 次数（条目可用 shadow_required 覆盖；schema.md §3 的「3」）。 */
export const DEFAULT_SHADOW_RUNS = 3
/** 命中账分型版本：v2 = 野外（wild）/ 探针（probe）两型账。存量文件缺此标记 → 按 legacy-unknown 回填。 */
export const HIT_LEDGER_VERSION = 2
/** 单个守卫的执行上限（ms）—— 超时按「守卫自身异常」处理（fail-open），不当作命中判据。 */
const GUARD_TIMEOUT_MS = 10_000
/** 锁内读状态账的重试次数 / 间隔：瞬时读失败（Windows rename 后他进程仍持句柄 EBUSY/EPERM）
 *  重试即可恢复；全部失败则本次记 degraded 跳过写 —— 绝不按空账写回（会覆盖并发者的计数）。 */
const STATE_READ_RETRIES = 3
const STATE_READ_RETRY_MS = 20

/** registry 条目路径（相对 baseDir）。 */
export function registryPath(config, baseDir) {
  return path.resolve(baseDir, config.storage.registry)
}

/**
 * 守卫运行时状态文件路径：配置项优先，缺省落在 events_dir 同级（本地 gitignored）。
 * @returns {string}
 */
export function guardStatePath(config, baseDir) {
  const configured = config?.storage && typeof config.storage.guard_state === 'string' ? config.storage.guard_state.trim() : ''
  if (configured !== '') return path.resolve(baseDir, configured)
  const eventsDir = config?.storage && typeof config.storage.events_dir === 'string' ? config.storage.events_dir : '.self-improving/events/'
  const parent = path.dirname(path.resolve(baseDir, eventsDir))
  return path.join(parent, 'guard-state.json')
}

/**
 * 读守卫耗时台账（`.learnings-work/timing/ledger.json`，由 scripts/guards/pre-commit.mjs 回写）。
 *
 * 路径与 guardStatePath 同惯例：落在 **配置里的** `events_dir` 同级的 `timing/` 子目录
 * （本机事实、gitignored、与事件库同生命周期）。
 * ⚠️ 必须走 config 而不是硬编码缺省值 —— 本仓 `.self-improving.yaml` 把 events_dir 指向
 * `.learnings-work/events/`，硬编码 `.self-improving/events/` 会去读一个根本没人写的目录，
 * 于是视图恒为空（静默失效的另一种形态：看起来实现了，实际从没生效过）。
 *
 * **损坏一律当作「没有」**（返回 null）：台账不是证据账，坏了就当没有，绝不能因此让
 * `--dry-run` 失败 —— dry-run 的契约是「零 spawn 零写盘、只看不判」。
 *
 * @returns {{guards: Record<string, {consecutive_timeout?: number, total_timeouts?: number, p95_ms?: number}>}|null}
 */
export function readTimingLedger(config, baseDir) {
  const eventsDir = config?.storage && typeof config.storage.events_dir === 'string' ? config.storage.events_dir : '.self-improving/events/'
  const parent = path.dirname(path.resolve(baseDir, eventsDir))
  const p = path.join(parent, 'timing', 'ledger.json')
  if (!existsSync(p)) return null
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    if (!doc || typeof doc !== 'object' || !doc.guards || typeof doc.guards !== 'object') return null
    return { guards: doc.guards }
  } catch {
    return null
  }
}

/** 读状态文件（缺失 = 空状态 = 全部守卫零 shadow 运行）。损坏也按空处理（fail-safe：退回 shadow）。 */
export function readGuardState(config, baseDir) {
  const p = guardStatePath(config, baseDir)
  if (!existsSync(p)) return { path: p, state: { guards: {} }, read: 'absent' }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.guards || typeof parsed.guards !== 'object') {
      return { path: p, state: { guards: {} }, read: 'invalid' }
    }
    return { path: p, state: parsed, read: 'ok' }
  } catch (e) {
    // 读失败与「文件不存在」必须分开返回。原先这里一律回落空状态，调用方无从分辨 ——
    // 于是「瞬时读失败」（Windows 上 rename 后另一个进程仍持句柄 → EBUSY/EPERM）被当成
    // 「守卫账是空的」，从 0 重建后写回，把别人的计数整段覆盖掉。实测 10 并发饱和负载下
    // 出现 shadow_runs=7 且**无任何告警**（2026-10-17）—— 正是这条路径。
    // 判据（不静默丢）：读不到账时，宁可这次不写（记 degraded），也不把账清零。
    return { path: p, state: { guards: {} }, read: 'error', error: e.message }
  }
}

/**
 * 命中账分型回填（**存量保守**，幂等，就地改 `state`）。
 *
 * 存量状态文件里每个守卫 / 每条条目都只有一根 `hits`（守卫侧是 `ever_hit`），
 * 它把「野外真发生的违规」与「我们自己造出来验证守卫能用的破坏测试」混在**同一根柱子上**。
 * 而破坏测试是解冻前的必需动作（stoploss.md §4），于是任何人造违规都与真实复发**不可分**。
 *
 * 回填口径（两条纪律，都朝保守方向）：
 *   1. 历史 `hits` 记为 `legacy_hits`（**unknown**，不是 wild）—— 不得回填成 `wild_hits`，
 *      也不得让 legacy 命中去满足退役的「从未命中」判据（verify.mjs 的 `legacy_hits` 拦路项）；
 *   2. 既有守卫级 `ever_hit` **清零**（并留 `legacy_ever_hit` 标记）—— 历史命中可能来自探针，
 *      让它继续当 wild 证据 = 追溯追认老守卫的退役资格。老守卫要重新挣：下一次真野外出事即置位。
 *
 * 为什么必须「不追溯」而不是「尽量信」：退役是本系统唯一的不可逆动作，而这次回填是在
 * **没有任何新事实**的前提下改判历史事实的方向。把不确定性当证据用，出错方向是「删掉真知识」，
 * 与整个止损线的方向相反。宁可让老守卫重新挣一次 `ever_hit`（一次真实复发即可），也不肯
 * 让一次人造违规兑换到「清空真实经验条目」的资格。
 *
 * 幂等靠 `hit_ledger_version` 标记：回填后写上版本号，重复调用直接跳过，不叠加、不覆盖新账。
 * 纯内存 + 就地改，**零 spawn**（遍历 N 个守卫 / N 条条目不按条目起子进程）。
 *
 * @param {object} state 状态根对象（`{guards, entries}`）
 * @returns {{changed:boolean, guards:number, entries:number}} 是否改过（调用方据此决定要不要落盘）
 */
export function normalizeHitLedger(state) {
  const out = { changed: false, guards: 0, entries: 0 }
  if (!state || typeof state !== 'object') return out
  const bump = (obj) => {
    if (Number.isInteger(obj.wild_hits)) obj.wild_hits = Math.max(0, obj.wild_hits)
    else obj.wild_hits = 0
    if (Number.isInteger(obj.probe_hits)) obj.probe_hits = Math.max(0, obj.probe_hits)
    else obj.probe_hits = 0
  }
  const guards = state.guards && typeof state.guards === 'object' ? state.guards : null
  if (guards) {
    for (const key of Object.keys(guards)) {
      const rec = guards[key]
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
      if (rec.hit_ledger_version === HIT_LEDGER_VERSION) continue
      // 旧 ever_hit 的来源不可知（可能是破坏测试点的亮）→ 标记后清零，不追溯追认 wild。
      rec.legacy_ever_hit = rec.ever_hit === true ? 1 : 0
      rec.ever_hit = false
      bump(rec)
      rec.hit_ledger_version = HIT_LEDGER_VERSION
      out.guards++
      out.changed = true
    }
  }
  const entries = state.entries && typeof state.entries === 'object' ? state.entries : null
  if (entries) {
    for (const id of Object.keys(entries)) {
      const rec = entries[id]
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
      if (rec.hit_ledger_version === HIT_LEDGER_VERSION) continue
      // 历史 hits 归入 legacy_hits（unknown）：既不记 wild，也不因它清零而让条目显得「从未命中」。
      rec.legacy_hits = Number.isInteger(rec.hits) ? Math.max(0, rec.hits) : (Number.isInteger(rec.legacy_hits) ? rec.legacy_hits : 0)
      delete rec.hits // 旧字段就此退役：留着只会诱发「还有谁在读它」（契约变更的收口）
      bump(rec)
      rec.hit_ledger_version = HIT_LEDGER_VERSION
      out.entries++
      out.changed = true
    }
  }
  return out
}

/**
 * 写状态文件（旁路状态；失败只提示不抛 —— 状态丢了最多退回 shadow，不该卡提交）。
 *
 * 用**原子写**（tmp + rename）而非直接覆盖：并发写者只会看到旧版或新版完整内容，
 * 不会读到写了一半的 JSON（`readGuardState` 遇坏 JSON 会静默退回空状态 = 全员零 shadow，
 * 那比丢一次计数更糟）。注意：原子写只保证「不撕裂」，丢更新要靠 `commitGuardRun` 的锁治。
 */
export function writeGuardState(config, baseDir, state) {
  const p = guardStatePath(config, baseDir)
  try {
    mkdirSync(path.dirname(p), { recursive: true })
    atomicWrite(p, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return p
  } catch (e) {
    console.error(`[run-guard] 状态写入失败（不影响放行，守卫退回 shadow）: ${e.message}`)
    return null
  }
}

/**
 * 状态账互斥锁（记账段的对外门面，供 approve / verify 复用同一把锁）。
 *
 * 锁序纪律：**状态账锁 → 审计锁**，绝不反向；也不得在持锁期间调 `flushAudit`
 * （审计自己会拿审计锁，嵌套即死锁 —— verify / capture 的审计调用都刻意放在锁外）。
 * @param {string} statePath 状态文件路径
 * @param {() => any} fn 临界区（必须短）
 * @returns {any} 临界区返回值；拿不到锁返回 null
 */
export function withStateLock(statePath, fn) {
  return withFileLock(`${statePath}.lock`, fn)
}

/** 读 registry（结构非法抛错 —— registry 是入仓数据，坏了必须显性失败而不是静默放行）。 */
export function loadRegistry(config, baseDir) {
  const p = registryPath(config, baseDir)
  if (!existsSync(p)) throw new Error(`registry 不存在: ${p}`)
  const parsed = parseYaml(readFileSync(p, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.guards)) {
    throw new Error(`registry 结构非法: ${p}（须含 guards 数组）`)
  }
  return { path: p, guards: parsed.guards.filter((g) => g && typeof g.key === 'string') }
}

/**
 * `--inject-state` 的落地：把夹具给的守卫级字段直接并进状态账（锁内重读 → 叠加 → 原子写）。
 *
 * **作用域为什么只有 `state.guards`**（逐字裁决「守卫级状态账」）：
 *   状态账有两段，危险程度差一个量级：
 *     - `state.guards[k]` = 守卫级（拦截权 / shadow 计数 / ever_hit）—— 注入它只是让夹具能造出
 *       「已挣到 blocking 的守卫」，而读侧对 `injected: true` 有硬否决，造不出证据；
 *     - `state.entries[id]` = 条目级观测账（`wild_hits` / `last_observed` …）—— **退役判据直接读它**。
 *       能注入这一段 = 任何人写一行 `wild_hits: 3` 就能给自己签发「删掉真实经验条目」的资格，
 *       这是不可逆动作，比伪造拦截权严重得多。故本函数**只写 guards 段**，且把注入的守卫一律打上
 *       `injected: true`，让「造出来的拦截权」在任何读侧都露着假章。
 *
 * **存在性判据 = registry 登记**（不是「状态账里已存在」）：夹具最需要的正是「刚登记、还没派发过」的
 *   守卫，按状态账存在性判会让这个用例无解；而往一个没登记的 key 上写账只会凭空造出一条谁也读不到的
 *   幻影状态。故判 registry，key 不存在即 usage 错误（exit 2）。
 *
 * @param {{config:object, baseDir:string, guards:{key:string}[], patch:object, now?:Date}} o
 * @returns {{keys:string[], statePath:string, injectedFields:Record<string,string[]>}}
 * @throws 未知 key / 账不可读 / 值非对象时抛 `err.usage = true`（调用方映射为 exit 2）
 */
export function injectGuardState({ config, baseDir, guards, patch, now = new Date() }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const err = new Error('--inject-state 须为 JSON 对象：{"<守卫key>": {…守卫级字段}}')
    err.usage = true
    throw err
  }
  const known = new Set((Array.isArray(guards) ? guards : []).map((g) => g && g.key).filter((k) => typeof k === 'string'))
  const unknown = Object.keys(patch).filter((k) => !known.has(k))
  if (unknown.length > 0) {
    const err = new Error(`--inject-state 引用了 registry 未登记的守卫: ${unknown.join(', ')}（已登记: ${[...known].join(', ') || '空'}）`)
    err.usage = true
    throw err
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const err = new Error(`--inject-state 的 ${key} 值须为对象（守卫级字段的浅合并补丁）`)
      err.usage = true
      throw err
    }
  }
  const statePath = guardStatePath(config, baseDir)
  return withStateLock(statePath, () => {
    // 账损坏时**拒绝注入**，绝不按空账写回：readGuardState 对 invalid 会回落成 `{guards:{}}`，
    // 照写就等于为注入一个夹具字段而抹掉既有条目级观测账（代价远大于收益）。
    const read = readGuardState(config, baseDir)
    if (read.read !== 'ok' && read.read !== 'absent') {
      const err = new Error(`状态账不可读（${read.read}${read.error ? `: ${read.error}` : ''}）—— 拒绝注入（不按空账写回）`)
      err.usage = true
      throw err
    }
    const { state } = read
    if (!state.guards || typeof state.guards !== 'object' || Array.isArray(state.guards)) state.guards = {}
    normalizeHitLedger(state)
    const injectedFields = {}
    for (const [key, value] of Object.entries(patch)) {
      const prior = state.guards[key] && typeof state.guards[key] === 'object' ? state.guards[key] : {}
      const fields = Object.keys(value).sort()
      state.guards[key] = {
        ...prior,
        ...value,
        // 强制字段：调用方注不注都拿到同一枚「假章」，读侧只需认这一个标记。
        injected: true,
        injected_at: now.toISOString(),
        injected_fields: fields,
      }
      injectedFields[key] = fields
    }
    writeGuardState(config, baseDir, state)
    flushAudit(config, baseDir, [{
      tool: 'run-guard',
      action: 'guard-inject',
      state: statePath,
      guards: Object.keys(injectedFields),
      injected_fields: injectedFields,
      note: '夹具注入的守卫级状态（injected=true）—— 读侧一律不作拦截权/退役证据',
    }])
    return { keys: Object.keys(injectedFields), statePath, injectedFields }
  })
}

/** 单条守卫的 shadow 裁决 + 一次直调（导出供测试注入式复用）。
 * @returns {{outcome:'pass'|'block'|'shadow-warn'|'error', code:number|null, elapsedMs:number, detail?:string}}
 */
export function runOnce(entry, { text = null, cwd, shadow } = {}) {
  const argv = Array.isArray(entry.command) && entry.command.length > 0 ? [...entry.command] : null
  if (!argv) return { outcome: 'error', code: null, elapsedMs: 0, detail: 'registry 条目缺 command（真守卫直调 argv）' }
  if (text !== null) argv.push('--input-stdin')
  const startedAt = Date.now()
  let res
  try {
    res = spawnSync(argv[0], argv.slice(1), {
      cwd,
      input: text === null ? '' : text,
      encoding: 'utf8',
      timeout: GUARD_TIMEOUT_MS,
      env: { ...process.env, SELF_IMPROVING_GUARD_KEY: String(entry.key ?? '') },
    })
  } catch (e) {
    return { outcome: 'error', code: null, elapsedMs: Date.now() - startedAt, detail: `spawn 异常: ${e.message}` }
  }
  const elapsedMs = Date.now() - startedAt
  if (res.error) return { outcome: 'error', code: null, elapsedMs, detail: `spawn 失败: ${res.error.message}` }
  const code = typeof res.status === 'number' ? res.status : null
  if (code === 0) return { outcome: 'pass', code, elapsedMs, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  if (code === 2) {
    // 命中判据：blocking 期才真阻断，shadow 期只警告 —— 拦截权是挣来的。
    const outcome = shadow.mode === 'blocking' ? 'block' : 'shadow-warn'
    return { outcome, code, elapsedMs, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }
  // 守卫自身异常（内部抛错 / 超时 / 未知码）：fail-open，只留痕不阻塞。
  return { outcome: 'error', code, elapsedMs, detail: `守卫返回非约定退出码 ${code}（约定 0=放行 / 2=阻断）` }
}

/** 条目观测账：每次派发都为 `covered_entries` 留下「被观测过」的证据；命中时再记一笔待回写明细。
 *
 *  为什么账落这里而不直接改仓内条目（票 11 裁决的分层）：命中是**高频**事件（每次拦截都发生），
 *  每命中一次就改一次仓内 frontmatter = 每次拦截都留一份脏工作区 + 无意义的 commit churn，
 *  而仓内条目的可审计性要求的是「一条 commit 粒度的写入」。于是：
 *   高频层（`state.entries`，本地 gitignored）：观测/命中计数 + `pending_records` 明细；
 *   低频层（仓内条目）：由 `verify.mjs --sweep` 显式回写 `recurrence` / `last_verified_at` + 末尾对质段。
 *   退役判定读的也是这层账（「守卫覆盖过它、一直不响」才是「无人命中」的正证据）。
 *
 *  **`observed` 与 `error` 必须分开记**（票 H1 修复 · 证伪机制被反向武器化的堵口）：
 *   守卫起不来 / 超时 / 返回非约定退出码时，**判据根本没执行**。这种派发若也计入 `observed_runs`，
 *   一个恒 `exit 0` 或恒报错的空守卫就能攒出「长期覆盖且从不命中」的假证据，
 *   再经 `verify.mjs --retire` 把它覆盖的**真实经验条目整批移出知识库**。
 *   故：`observed_runs` / `last_observed` 只由**真执行了判据**的派发（pass / block / shadow-warn）发放，
 *   守卫异常只进 `observed_error_runs` / `last_error_run`（不参与退役证据，仅供人审）。
 *
 *  **`hit` 与 `probe` 必须同时传**（命中两型记账，schema.md §3.1）：命中落到哪根柱子上，
 *   决定它将来能不能当退役证据、能不能回写条目正文对质段。见文件头「两型命中记账」段。
 *
 * @param {object} state 守卫状态根对象（就地写入 `entries` 段）
 * @param {string} guardKey
 * @param {string[]} ids covered_entries
 * @param {{hit?:boolean, probe?:boolean, observed?:boolean, error?:boolean, now?:Date, today?:string}} opts
 * @returns {string[]} 记账到的条目 ID
 */
export function recordEntryObservations(state, guardKey, ids, { hit = false, probe = false, observed = true, error = false, now = new Date(), today = now.toISOString().slice(0, 10) } = {}) {
  if (!state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) state.entries = {}
  const touched = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    const rec = state.entries[id] && typeof state.entries[id] === 'object' ? state.entries[id] : {}
    const keys = Array.isArray(rec.guard_keys) ? rec.guard_keys.slice() : []
    if (!keys.includes(guardKey)) keys.push(guardKey)
    const next = {
      ...rec,
      hit_ledger_version: HIT_LEDGER_VERSION,
      guard_keys: keys,
      observed_runs: (Number.isInteger(rec.observed_runs) ? rec.observed_runs : 0) + (observed ? 1 : 0),
      wild_hits: (Number.isInteger(rec.wild_hits) ? rec.wild_hits : 0) + (hit && !probe ? 1 : 0),
      probe_hits: (Number.isInteger(rec.probe_hits) ? rec.probe_hits : 0) + (hit && probe ? 1 : 0),
    }
    // 时间戳同样分流：last_observed = 「判据真的跑过它」，守卫异常另记 last_error_run
    if (observed) next.last_observed = now.toISOString()
    // 末次观测健康度（2026-10-17 补 · evt-20261017-033）：与 probe_last_outcome 同款末次语义。
    // 为什么必须有：`observed_error_runs` 是**累计**计数且只增不减，若拿它当证据门，
    // 守卫只要异常过一次，它覆盖的条目就**永远**攒不到证据 —— 不可恢复的死状态。
    // 实测即此形态：D13 违规退出码 1 与守卫协议 0/2 错配，probe 第一次返回 exit=1 error，
    // 此后该守卫的 ERR-20261017-032 拍5 永久判红。异常历史留在累计计数里供人审
    // （schema.md §3.1 本就写它「不参与退役证据」），门只问「现在还健康吗」。
    next.last_observation = error ? 'error' : observed ? 'healthy' : 'unknown'
    next.last_observation_at = now.toISOString()
    if (error) {
      next.observed_error_runs = (Number.isInteger(rec.observed_error_runs) ? rec.observed_error_runs : 0) + 1
      next.last_error_run = now.toISOString()
    }
    if (probe) {
      // 探针派发（不论拦住没拦住）都刷新「最近一次探针结论」—— 拍5 的 probe 判据读它，
      // 一次「没拦住」就该把这份守卫的探针证据打回红，而不是让上一次 proven 一直有效。
      next.probe_last_outcome = hit ? 'proven' : 'missed'
      next.probe_last_outcome_at = now.toISOString()
    }
    if (hit) {
      if (probe) {
        // probe 命中只进 probe 账：**不进 pending_hits / pending_records**（那两条队列是 wild 专用，
        // sweep 靠它们抬 recurrence 并写正文对质段 —— 人造违规不许改写知识库正文）。
        next.pending_probes = (Number.isInteger(rec.pending_probes) ? rec.pending_probes : 0) + 1
        next.pending_probe_records = [
          ...(Array.isArray(rec.pending_probe_records) ? rec.pending_probe_records : []),
          { guard: guardKey, date: today, at: now.toISOString() },
        ]
      } else {
        if (typeof rec.first_hit !== 'string') next.first_hit = today
        next.last_hit = today
        if (typeof rec.first_wild_hit !== 'string') next.first_wild_hit = today
        next.last_wild_hit = today
        next.pending_hits = (Number.isInteger(rec.pending_hits) ? rec.pending_hits : 0) + 1
        next.pending_records = [
          ...(Array.isArray(rec.pending_records) ? rec.pending_records : []),
          { guard: guardKey, date: today, at: now.toISOString() },
        ]
      }
    }
    state.entries[id] = next
    touched.push(id)
  }
  return touched
}

/**
 * 守卫级证据强度（人审用；`--all --dry-run` 输出与退役判定共用同一份口径）。
 *
 * 五档，判据从弱到强：
 *   `no-evidence` —— 从未派发（`shadow_runs === 0`）：它覆盖的条目与「无人命中」无关；
 *   `debt`        —— 派发过但守卫自身在报错（`error_runs > 0` 或末次 `last_result === error`）：
 *                    判据没跑起来，它的「不响」是噪声不是证据；
 *   `injected`    —— 状态里有 `--inject-state` 注入的字段（`injected === true`）：拦截权是**造出来的**，
 *                    不是跑出来的。它排在 debt 之后、weak 之前 —— 因为无论账上还写着什么，
 *                    一个夹具注入出来的 blocking 都不可能构成「真挣到拦截权」的证据
 *                    （与 probe 永不置 ever_hit 同源：自证不兑换不可逆动作的资格）；
 *   `weak`        —— 绿灯攒满升了 blocking，但**判据从未在野外命中过任何东西**（`ever_hit !== true`）：
 *                    「一直放行」和「判据根本是空的」在状态上不可分，故沉默不作为退役依据（schema.md §3.3）；
 *                    ⚠ 探针命中（`--probe`，我们自己造的违规）**不置** `ever_hit`，故也不改这一档 ——
 *                    人造违规不得把守卫的证据强度抬高。
 *   `strong`      —— blocking + 曾**野外出事** + 无错误运行：它响过，所以它现在的沉默是信号。
 */
export function evidenceStrength(g) {
  const rec = g && typeof g === 'object' ? g : {}
  const runs = Number.isInteger(rec.shadow_runs) ? rec.shadow_runs : 0
  const errs = Number.isInteger(rec.error_runs) ? rec.error_runs : 0
  if (runs <= 0) return 'no-evidence'
  if (errs > 0 || rec.last_result === 'error') return 'debt'
  if (rec.injected === true) return 'injected'
  if (rec.mode !== 'blocking' || rec.ever_hit !== true) return 'weak'
  return 'strong'
}

/**
 * 派发一个 key 的完整流程（含 shadow 计数、升 blocking、fail-open 审计、recurrence 记账）。
 *
 * **并发纪律（票 H2）**：本系统的设计目标就是「多会话同时写同一个经验库」，而记账原先是
 * 无锁的「读状态 → spawn 守卫 → 改状态 → 整体覆盖」，实测 10 个并发派发 `shadow_runs` 只从
 * 0 涨到 1（丢 9 次），条目观测账同比例丢失 —— 账失真直接污染退役证据。现拆成两段：
 *   ① **派发段不加锁**：只取一份状态快照判断 mode（blocking/shadow），然后跑守卫。
 *      临界区里绝不放 spawn（10s 级超时 × N 会把并发派发退化成串行）。
 *   ② **记账段加锁**（`commitGuardRun`）：锁内**重读**最新状态再叠加本次增量并原子写。
 *      增量（+1 次运行 / +1 绿 / +1 观测 / +1 命中）全是可交换的，叠加顺序不影响终值 ——
 *      这正是「锁内重读 + 增量叠加」能杜绝丢更新的前提。
 *   残留竞态（已知且刻意接受）：mode 快照早于记账重读，故**刚升 blocking 的那一跑**可能
 *   仍按 shadow 只警告不阻断（下次派发即生效）。方向是 fail-open（少拦一次），与本系统纪律一致。
 * @returns {{ exitCode:number, record:object }}
 */
export function dispatch({ config, baseDir, key, text = null, cwd = null, now = new Date(), probe = false }) {
  const { guards } = loadRegistry(config, baseDir)
  const entry = guards.find((g) => g.key === key)
  if (!entry) {
    const err = new Error(`registry 中无此守卫: ${key}（已登记: ${guards.map((g) => g.key).join(', ') || '空'}）`)
    err.usage = true
    throw err
  }
  const required = Number.isInteger(entry.shadow_required) && entry.shadow_required >= 0 ? entry.shadow_required : DEFAULT_SHADOW_RUNS
  // 快照只用于「这一次派发按 shadow 还是 blocking 语义裁决退出码」，不参与计数（计数在锁内重读后叠加）
  const snapshot = readGuardState(config, baseDir).state
  const prior0 = snapshot.guards[key] && typeof snapshot.guards[key] === 'object' ? snapshot.guards[key] : {}
  const shadow = {
    mode: prior0.mode === 'blocking' ? 'blocking' : 'shadow',
    shadow_runs: Number.isInteger(prior0.shadow_runs) ? prior0.shadow_runs : 0,
    shadow_green: Number.isInteger(prior0.shadow_green) ? prior0.shadow_green : 0,
    required,
  }
  // 债务桩（mode: debt-stub）不派发：它指向的是绑定门禁自身，不是任何针对条目内容的判据。
  if (entry.mode === 'debt-stub') {
    const record = commitGuardRun({ config, baseDir, key, entry, run: null, now, required, skipped: 'debt-stub（债务桩不派发）', probe })
    console.error(`[run-guard] ${key} skipped（debt-stub 债务桩，不参与派发）`)
    return { exitCode: 0, record }
  }

  const run = runOnce(entry, { text, cwd: cwd || baseDir, shadow })
  const record = commitGuardRun({ config, baseDir, key, entry, run, now, required, probe })
  printReport(entry, run, shadow, record, record.promoted, record.observed_entries)
  // 诊断轨迹：守卫派发是六拍里最需要事后追溯的一步（「这条守卫到底跑了没有、跑多久、
  // 记了多少」），故结构化落一条。guard_key 同时是 log-query --cycle 的业务键 ——
  // 一次 grep 就能把这把守卫历次派发连同它覆盖的条目一起捞出来。
  const logger = createLogger({ module: 'run-guard', baseDir, config })
  logger.span('guard.dispatch', {
    guard_key: key,
    outcome: run.outcome,
    exit: run.code,
    duration_ms: run.elapsedMs,
    hit_kind: record.hit_kind ?? 'none',
    mode: record.mode_after ?? shadow.mode,
    shadow_runs: record.shadow_runs,
    shadow_green: record.shadow_green,
    degraded: record.degraded === true,
    reason: record.degraded ? record.detail : null,
    entries: record.observed_entries || [],
    promoted: record.promoted === true,
  })
  // 心跳行：每次派发都留一条 info，`log-query --stats` 才能回答「现在是不是在工作」。
  // 没有它，健康状态下 si.log 会一直是空的 —— 而「空日志」无法区分「没跑」与「没出事」。
  logger.info(`派发 ${key} · ${run.outcome} · ${run.elapsedMs}ms${probe ? ' · probe' : ''}`, {
    outcome: run.outcome,
    hit_kind: record.hit_kind ?? 'none',
    degraded: record.degraded === true,
    shadow: `${record.shadow_green}/${record.shadow_runs}`,
  })
  return { exitCode: run.outcome === 'block' ? 2 : 0, record }
}

/**
 * 记账段：锁内重读最新状态 → 叠加本次增量 → 原子写 → 返回本次运行记录（导出供测试复用）。
 *
 * 锁粒度 = 状态文件本身（`<guard-state.json>.lock`），故 verify.mjs 的 sweep 回写与
 * approve.mjs 的 shadow 计数归零也必须走同一把锁（见 writeStrictState / approve 的调用点）。
 *
 * @param {object} o
 * @param {string} o.skipped 非空 = 跳过派发（债务桩），只落一条 skipped 记录
 * @param {boolean} o.probe true = 本次是人造验证（破坏测试），命中记 probe 账、**不置 ever_hit**
 * @returns {object} 本次运行记录（`shadow_*` 字段是**落盘后**的值）
 */
export function commitGuardRun({ config, baseDir, key, entry, run = null, now = new Date(), required = DEFAULT_SHADOW_RUNS, skipped = null, probe = false }) {
  const statePath = guardStatePath(config, baseDir)
  const lockPath = `${statePath}.lock`
  const commit = () => {
    // 锁内重读 = 叠加在最新账上（丢更新的根治点）。
    // 读不到账 ≠ 账是空的：瞬时读失败若按空账写回，会把并发者的计数整段覆盖，且毫无告警。
    // 故先重试若干次，仍读不到就把本次记为 degraded（跳过写 + 逐次告警 + 审计留痕）。
    let read = null
    for (let a = 0; a < STATE_READ_RETRIES; a++) {
      read = readGuardState(config, baseDir)
      if (read.read === 'ok' || read.read === 'absent') break
      sleepSync(STATE_READ_RETRY_MS)
    }
    if (read.read !== 'ok' && read.read !== 'absent') {
      return { __unreadable: true, read: read.read, error: read.error ?? null }
    }
    const { state } = read
    // 存量保守回填（幂等）：历史 hits / ever_hit 属 legacy-unknown，不追溯追认 wild。
    // 放在锁内、叠加增量之前 —— 否则本进程会把新账写在未归型的旧账上（两个口径混在一根柱子上）。
    normalizeHitLedger(state)
    const prior = state.guards[key] && typeof state.guards[key] === 'object' ? state.guards[key] : {}
    const mode = prior.mode === 'blocking' ? 'blocking' : 'shadow'

    if (skipped !== null) {
      const record = { key, outcome: 'skipped', reason: skipped, last_result: 'skipped', mode_after: mode }
      saveAndAudit(config, baseDir, state, statePath, key, record)
      return record
    }

    // 判据是否**真执行了**：`error` = 守卫起不来 / 超时 / 非约定退出码 —— 这类派发只记 error，
    // 不发放 `observed_runs`（否则空守卫能攒出假的「长期覆盖」证据，见 recordEntryObservations 注释）。
    const guardErrored = run.outcome === 'error'
    // hit = 判据命中的**证据面**事件，与是否真拦截（mode 裁决）分开：shadow 期命中同样是
    // 「失效形态在野复发」的实证 —— 不记账 = 攒 blocking 的窗口期恰好成为复发数据黑洞，
    // 六拍的拍5/拍6 在整个 shadow 期饿着（2026-10-17 首绑 ERR-20261011-006 实测发现，
    // 守卫级 ever_hit 当时已计 shadow 命中而条目级没计，同次派发两本账对不上）。
    const hit = run.outcome === 'block' || run.outcome === 'shadow-warn'
    // **两型分账的唯一分界**：wild = 真实路由上的捕获（含 shadow 期 shadow-warn —— 它仍是野外复发实证，
    // 只是还没挣到阻断权）；probe = 我们自己造违规做的破坏测试。probe 命中**永不置 ever_hit**：
    // 退役链读的就是 ever_hit，让一次人造违规置位 = 用一次自证换到「清空真实经验条目」的资格。
    const isProbe = probe === true
    const wildHit = hit && !isProbe
    const today = now.toISOString().slice(0, 10)
    const shadow_runs = (Number.isInteger(prior.shadow_runs) ? prior.shadow_runs : 0) + 1
    const shadow_green = (Number.isInteger(prior.shadow_green) ? prior.shadow_green : 0) + (run.outcome === 'pass' ? 1 : 0)
    const next = {
      ...prior,
      hit_ledger_version: HIT_LEDGER_VERSION,
      shadow_runs,
      shadow_green,
      error_runs: (Number.isInteger(prior.error_runs) ? prior.error_runs : 0) + (guardErrored ? 1 : 0),
      // error_streak：从上次成功起连续 error 几次（成功清零）。`--dry-run` 的静默失效视图读它
      // （累计 error_runs 分不出「连挂」与「间断」，而连挂才是判据根本没在跑的信号）。
      error_streak: guardErrored ? (Number.isInteger(prior.error_streak) ? prior.error_streak : 0) + 1 : 0,
      last_run: now.toISOString(),
      last_run_ms: run.elapsedMs,
      last_result: run.outcome === 'pass' ? 'pass' : run.outcome === 'error' ? 'error' : 'fail',
      mode,
    }
    // ===== 命中两型分账（本文件的核心纪律）=====
    if (isProbe) {
      // 探针账：只记「验证过一次」与「这一次拦住了没」，与 ever_hit 完全隔离。
      next.probe_hits = (Number.isInteger(prior.probe_hits) ? prior.probe_hits : 0) + (hit ? 1 : 0)
      next.last_probe_at = now.toISOString()
      next.probe_last_outcome = hit ? 'proven' : 'missed'
      next.probe_last_outcome_at = next.last_probe_at
    }
    if (wildHit) {
      next.wild_hits = (Number.isInteger(prior.wild_hits) ? prior.wild_hits : 0) + 1
      if (typeof prior.first_wild_hit !== 'string') next.first_wild_hit = today
      next.last_wild_hit = today
      // ever_hit = 这条守卫的判据**曾经真的在野外出事**。它是退役证据的门槛之一（schema.md §3.3）：
      // 从未命中过的守卫（恒 exit 0 / 判据为空）它的沉默不含任何信息量，不许拿去退役真实条目。
      // 命中包括 shadow 期的 shadow-warn；**不包括 probe**（人造违规不算「它响过」）。
      next.ever_hit = true
    }
    let promoted = false
    if (next.mode === 'shadow' && next.shadow_runs >= required && next.shadow_green === next.shadow_runs) {
      next.mode = 'blocking'
      next.promoted_at = now.toISOString()
      promoted = true
    }
    // 高频记账只落运行时状态文件（state.entries），**不碰仓内条目** —— 回写由 verify.mjs --sweep 显式做。
    const hitEntries = recordEntryObservations(state, key, entry.covered_entries, {
      hit,
      probe: isProbe,
      observed: !guardErrored,
      error: guardErrored,
      now,
      today,
    })

    const record = {
      key,
      outcome: run.outcome,
      exit: run.code,
      elapsed_ms: run.elapsedMs,
      // hit_kind 把这次命中的来源摆在报表第一行 —— 判红之后人第一眼要能分清
      // 「野外真复发」与「我们自己造的破坏测试」。
      hit_kind: hit ? (isProbe ? 'probe' : 'wild') : 'none',
      probe: isProbe,
      last_result: next.last_result,
      // last_run / last_run_ms 必须落盘：trace 的拍4「守卫运行」以 last_run 判据，
      // 漏了它六拍永远走不完第 4 拍 → verdict 恒为 freeze → 按止损程序注入必须永远关着。
      // 实测：no-bare-vitest 真跑 7 次全绿，状态里却没有 last_run，trace 拍4 判 ✗（2026-10-17）。
      last_run: next.last_run,
      last_run_ms: next.last_run_ms,
      mode_after: next.mode,
      shadow_runs: next.shadow_runs,
      shadow_green: next.shadow_green,
      shadow_required: required,
      error_runs: next.error_runs,
      error_streak: next.error_streak,
      wild_hits: Number.isInteger(next.wild_hits) ? next.wild_hits : 0,
      probe_hits: Number.isInteger(next.probe_hits) ? next.probe_hits : 0,
      probe_last_outcome: next.probe_last_outcome ?? null,
      // ever_hit 恒等于「野外出过事」：probe 命中这一行永远是 false（除非此前就野外出过事）。
      ever_hit: next.ever_hit === true,
      promoted,
      observed_entries: hitEntries,
      pending_hits: wildHit ? hitEntries.length : 0,
      pending_probes: isProbe && hit ? hitEntries.length : 0,
      detail: run.detail ?? null,
    }
    saveAndAudit(config, baseDir, state, statePath, key, record, next)
    return record
  }

  // 锁内重读使重试安全（每次 commit 都叠加在最新账上）；有界重试 = 3 × 5s。
  // 为什么不一把锁死等到底：全量测试并行 / 多会话同时提交时机器可能被榨干，
  // 单轮 5s 在饱和负载下真实超时过（2026-10-17 全量套件实测并发账 4/10）。
  let committed = null
  let unreadable = null
  for (let attempt = 0; attempt < 3 && (committed === null || (committed && committed.__unreadable)); attempt++) {
    committed = withFileLock(lockPath, commit)
    if (committed && committed.__unreadable) {
      unreadable = committed
      committed = null // 读不到账不算提交成功 —— 继续重试，仍失败则走下面的降级出口
    }
  }
  if (committed !== null) return committed
  // 拿不到锁（重试 3 轮耗尽）：**跳过状态写**，审计留痕 + 显式告警。
  // 旧降级是「无锁写」—— 两个超时者在读-写窗口里互相覆盖，把「丢一次」放大成「丢一批」
  // 且完全静默（2026-10-17 饱和负载实测 3/10 后定位）。跳过写的契约 = **不静默丢**：
  // 状态账宁可少这一次计数（fail-open 纪律不变，不卡提交），但审计是 append-only 追加、
  // 不参与读写竞争 —— 每一次丢失都逐行留痕，可从审计日志对账补齐。
  const degradedRecord = {
    key,
    outcome: run ? run.outcome : 'skipped',
    exit: run ? run.code : null,
    elapsed_ms: run ? run.elapsedMs : 0,
    last_result: run ? (run.outcome === 'pass' ? 'pass' : run.outcome === 'error' ? 'error' : 'fail') : 'skipped',
    mode_after: mode,
    shadow_runs: shadow.shadow_runs,
    shadow_green: shadow.shadow_green,
    shadow_required: required,
    ever_hit: false,
    probe: probe === true,
    hit_kind: 'none',
    promoted: false,
    observed_entries: [],
    pending_hits: 0,
    pending_probes: 0,
    degraded: true,
    detail: unreadable !== null
      ? `state-unreadable（锁内读状态账 ${STATE_READ_RETRIES} 轮仍失败：${unreadable.read} ${unreadable.error ?? ''}；本次计数未落状态账，审计已留痕）`
      : 'lock-timeout（重试 3 轮耗尽，本次计数未落状态账，审计已留痕）',
  }
  flushAudit(config, baseDir, [
    {
      tool: 'run-guard',
      action: `guard-${degradedRecord.outcome}`,
      guard: key,
      state: statePath,
      degraded: true,
      reason: unreadable !== null ? 'state-unreadable' : 'lock-timeout',
    },
  ])
  if (unreadable !== null) {
    console.error(`[run-guard] 状态账读取失败（锁内重试 ${STATE_READ_RETRIES} 轮仍不可读：${unreadable.read} ${unreadable.error ?? ''}）→ 本次计数不落状态账、审计已留痕: ${statePath}`)
  } else {
    console.error(`[run-guard] 状态锁获取失败（重试 3 轮耗尽）→ 本次计数不落状态账、审计已留痕: ${lockPath}`)
  }
  return degradedRecord
}

/**
 * 落盘 + 审计留痕。
 *
 * ⚠ 落盘的是 `{...既有账, ...next, ...record}`：**`next` 必须一起落**。
 * `record` 只是「本次运行的可读摘要」，不是守卫账的全集 —— 只落 `record` 会把 `next` 独有的字段
 * （`first_wild_hit` / `last_wild_hit` / `last_probe_at` / `probe_last_outcome_at` / `promoted_at` …）
 * 静默丢掉：`state.guards[key]` 此前只由 `record` 覆盖过，从没落过 `next`。
 * 丢 `promoted_at` 只是报表少一行，丢命中分型字段则是「拍5 判据读不到证据」——
 * 两型记账把 `first_wild_hit` 挂在 `next` 上，所以这里必须落全。
 */
function saveAndAudit(config, baseDir, state, statePath, key, record, next = null) {
  state.guards[key] = {
    ...(state.guards[key] ?? {}),
    ...(next ?? {}),
    ...record,
    mode: record.mode_after ?? record.mode ?? state.guards[key]?.mode ?? 'shadow',
  }
  writeGuardState(config, baseDir, state)
  flushAudit(config, baseDir, [{ tool: 'run-guard', action: `guard-${record.outcome}`, guard: key, state: statePath, ...record }])
}

function printReport(entry, run, shadow, record, promoted, hitEntries) {
  const out = (run.output ?? '').trim()
  const kind = record.hit_kind === 'probe' ? ' · hit=probe（人造验证，不构成退役证据）' : record.hit_kind === 'wild' ? ' · hit=wild（野外捕获）' : ''
  const head = `[run-guard] ${entry.key} · ${run.outcome} · exit=${run.code} · ${run.elapsedMs}ms · ${shadow.mode} ${record.shadow_green}/${record.shadow_runs}（需 ${record.shadow_required} 绿）${kind}`
  if (out !== '') console.error(out)
  if (run.detail) console.error(`${head} · ${run.detail}（fail-open：守卫自身异常不阻塞提交）`)
  else if (run.outcome === 'shadow-warn') console.error(`${head} · 命中判据但尚在 shadow：只警告不阻断（exit 0），阻断权须攒满绿运行${hitEntries.length > 0 ? ` · 命中已记账（${record.hit_kind === 'probe' ? 'probe 账，不回写条目正文' : 'shadow 期同样算野外复发实证，待 sweep 回写'}）: ${hitEntries.join(', ')}` : ''}`)
  else if (run.outcome === 'block') console.error(`${head} · 命中判据 → 阻断（exit 2）${hitEntries.length > 0 ? ` · 记账入运行时状态（${record.hit_kind === 'probe' ? 'probe 账' : 'wild，待 sweep 回写'}）: ${hitEntries.join(', ')}` : ''}`)
  else if (record.degraded) console.error(`${head} · 锁竞争重试 3 轮耗尽：本次计数未落状态账（审计已留痕，fail-open 不阻塞提交）`)
  else if (run.outcome === 'pass') console.error(head)
  if (promoted) console.error(`[run-guard] ${entry.key} 升 blocking（shadow ${record.shadow_green}/${record.shadow_runs} 全绿）—— 自此命中判据即阻断`)
}

export function main(argv) {
  let cliConfig = null
  let projectDir = process.cwd()
  let key = null
  let text = null
  let all = false
  let wantJson = false
  let dryRun = false
  let probe = false
  let injectRaw = null
  const STDIN = Symbol('stdin')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') { all = true; continue }
    if (a === '--json') { wantJson = true; continue }
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--probe') { probe = true; continue }
    if (!['--key', '--text', '--stdin', '--config', '--project-dir', '--inject-state'].includes(a)) return usage(`未知参数 ${a}`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) return usage(`${a} 后须跟值`)
    i++
    if (a === '--key') key = next
    else if (a === '--text') text = next
    else if (a === '--stdin') text = STDIN
    else if (a === '--config') cliConfig = path.resolve(next)
    else if (a === '--inject-state') injectRaw = next
    else projectDir = path.resolve(next)
  }
  // 注入口的边界校验放在 loadContext 之前：组合非法就别去碰配置链，更别碰状态账。
  if (injectRaw !== null) {
    if (all) return usage('--inject-state 不可与 --all 同用（注入是夹具手段，不是全量派发的能力；--all 派发不得顺带改别人的账）')
    if (dryRun) return usage('--inject-state 不可与 --dry-run 同用（--dry-run 的契约是零 spawn 零写盘）')
  }
  if (text === STDIN) {
    try {
      text = readFileSync(0, 'utf8')
    } catch (e) {
      return usage(`--stdin 读 stdin 失败: ${e.message}`)
    }
  }
  if (!all && !key) return usage('须给 --key <key> 或 --all')

  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    // runner 自己挂掉 = fail-open：放行 + 审计（与守卫内部异常同一纪律）。
    console.error(`[run-guard] fail-open: 配置链失败 ${e.message}（放行，不阻塞提交）`)
    flushAudit(config, baseDir, [{ tool: 'run-guard', action: 'fail-open', error: e.message }])
    return 0
  }

  try {
    // --inject-state：先把夹具要的守卫级状态并进账，再照常派发（本次派发即可按 blocking 语义裁决）。
    // 放在 try 内：injectGuardState 的用法错误（未知 key / 账不可读）经下面统一的 usage 分支映射为 exit 2。
    if (injectRaw !== null) {
      let patch = null
      try {
        patch = JSON.parse(injectRaw)
      } catch (e) {
        return usage(`--inject-state JSON 解析失败: ${e.message}`)
      }
      const { guards } = loadRegistry(config, baseDir)
      const injected = injectGuardState({ config, baseDir, guards, patch })
      console.error(`[run-guard] ⚠ --inject-state 已注入守卫级状态: ${injected.keys.join(', ')}（仅供测试/夹具；读侧一律不认 injected=true 的拦截权 —— trace 拍4 判红、verify 不退役）`)
    }
    // --dry-run：只读状态文件，**零 spawn、零写盘**，逐条报证据强度 —— 人审「这条守卫的账够不够」
    // 时看的就是这一行；缺了它，恒 exit 0 的空守卫与真守卫在报表上长得一模一样。
    if (dryRun) return dryRunReport({ config, baseDir, key, all, wantJson })
    if (all) {
      const { guards } = loadRegistry(config, baseDir)
      const results = []
      let rc = 0
      for (const g of guards) {
        const r = dispatch({ config, baseDir, key: g.key, text, cwd: baseDir, probe })
        results.push(r.record)
        if (r.exitCode === 2 && rc === 0) rc = 2
      }
      if (wantJson) process.stdout.write(`${JSON.stringify({ dispatched: results.length, results }, null, 2)}\n`)
      return rc
    }
    const r = dispatch({ config, baseDir, key, text, cwd: baseDir, probe })
    if (wantJson) process.stdout.write(`${JSON.stringify(r.record, null, 2)}\n`)
    return r.exitCode
  } catch (e) {
    if (e && e.usage) {
      console.error(`用法错误：${e.message}`)
      return 2
    }
    console.error(`[run-guard] fail-open: ${e.message}（放行，不阻塞提交）`)
    flushAudit(config, baseDir, [{ tool: 'run-guard', action: 'fail-open', error: e.message }])
    return 0
  }
}

/**
 * 守卫「连续 error」告警阈值（票 H2 · 架构审计 F9）。
 *
 * 背景：守卫自身异常（起不来 / 超时 / 返回非约定退出码）按设计 **fail-open**（exit 0，不阻塞提交），
 * 且 error 不计 `shadow_green` —— 这条纪律本身是对的（不该因为守卫自己坏了就卡住提交）。
 * 但缺了观测它就退化成「静默失效」：一个恒报错的守卫会永远停在 shadow、永远 fail-open，
 * 而账面上「它在跑」，没有任何路径把这件事抬到人眼前。本常量只服务于**可见性**，不改 fail-open 纪律。
 *
 * 取值理由：**3** —— 与 `DEFAULT_SHADOW_RUNS` 同数，含义对称（同一量级的「值得人看一眼」的偏差）；
 * 不取 1（单次 error 多为环境抖动，如首次拉依赖/时序），也不取 5+（shadow 期总共才 3 次运行，
 * 阈值 5 会让「整段 shadow 期都在报错」这种最该看的场景反而看不见）。
 */
export const ERROR_STREAK_THRESHOLD = 3

/**
 * `--dry-run` 报表：读 registry + 状态文件（两处只读），逐条给证据强度 + 连续 error 视图。
 *
 * **为什么要有这一份**：判红之后人第一件事是「看一眼这些守卫到底有没有在干活」。
 * 只有 shadow 绿/总 的旧报表里，一个恒 `exit 0` 的空守卫和一个真在抓东西的守卫长得一样，
 * 于是「看着都绿」就等于「证据充分」—— 证伪机制被反向武器化就是这么发生的。
 * `weak` 档专治这一类：绿灯攒满但判据从未命中过东西，它的沉默不构成退役依据（schema.md §3.3）。
 * **连续 error 视图**（票 H2 · F9）专治另一类：error 档只说「现在在报错」，不告诉你「已经连着报了几次」，
 * 于是「偶发一次」与「从来没成功过」在报表上不可分 —— 后者才是最该被人看见的那种静默失效。
 */
export function dryRunReport({ config, baseDir, key = null, all = false, wantJson = false }) {
  const { guards } = loadRegistry(config, baseDir)
  const { state } = readGuardState(config, baseDir)
  const picked = key ? guards.filter((g) => g.key === key) : guards
  if (key && picked.length === 0) {
    console.error(`用法错误：registry 中无此守卫: ${key}`)
    return 2
  }
  const rows = picked.map((g) => {
    const gs = state.guards[g.key] && typeof state.guards[g.key] === 'object' ? state.guards[g.key] : {}
    const errorRuns = Number.isInteger(gs.error_runs) ? gs.error_runs : 0
    const runs = Number.isInteger(gs.shadow_runs) ? gs.shadow_runs : 0
    return {
      key: g.key,
      mode: gs.mode ?? 'shadow',
      shadow_green: Number.isInteger(gs.shadow_green) ? gs.shadow_green : 0,
      shadow_runs: runs,
      error_runs: errorRuns,
      // error_streak = **从上次成功起连续 error 几次**（派发器每次派发维护：成功清零、error +1）。
      // 为什么必须单独有这个字段：`error_runs` 是历史累计，「3 次 error 中间断着 2 次成功」与
      // 「连挂 3 次」在累计口径上不可分，而后者才是「判据根本没在跑」那种静默失效。
      // 旧账（升级前写的状态文件）没有该字段，此时退化为「末次为 error 则取累计 error_runs」——
      // 明确是**保守近似**（可能高估、不会漏报），宁可多看一眼。
      error_streak: Number.isInteger(gs.error_streak)
        ? gs.error_streak
        : gs.last_result === 'error' ? Math.min(runs, errorRuns) : 0,
      ever_hit: gs.ever_hit === true,
      // 两型命中分列（人审一眼看出「它是在野外响过」还是「只有我们自己造的探针响过」）：
      // wild 是退役证据，probe 不是 —— 报表里混成一根柱子 = 人审自己也会读错。
      wild_hits: Number.isInteger(gs.wild_hits) ? gs.wild_hits : 0,
      probe_hits: Number.isInteger(gs.probe_hits) ? gs.probe_hits : 0,
      probe_last_outcome: gs.probe_last_outcome ?? null,
      last_probe_at: gs.last_probe_at ?? null,
      // legacy_ever_hit = 存量账里那条来源不可知的 ever_hit（已被回填清零，不作 wild 证据）。
      legacy_ever_hit: Number.isInteger(gs.legacy_ever_hit) ? gs.legacy_ever_hit : 0,
      // injected = 该守卫的账里有 --inject-state 注入的字段（夹具构造，拦截权是假的）。
      // 必须出现在人审报表里：一份 evidence=injected 的账若不标出来，人只会看到 mode=blocking。
      injected: gs.injected === true,
      injected_at: typeof gs.injected_at === 'string' ? gs.injected_at : null,
      injected_fields: Array.isArray(gs.injected_fields) ? gs.injected_fields : [],
      // when 是**声明性注解、派发器不求值**（schema.md §3）：原样带出并标注，免得注解冒充已接线的假象
      when: typeof g.when === 'string' ? g.when : null,
      when_evaluated: false,
      covered_entries: Array.isArray(g.covered_entries) ? g.covered_entries : [],
      evidence: evidenceStrength(gs),
    }
  })
  for (const r of rows) {
    console.error(`[run-guard --dry-run] ${r.key} · evidence=${r.evidence} · mode=${r.mode} · shadow ${r.shadow_green}/${r.shadow_runs} · error_runs=${r.error_runs} · wild_hits=${r.wild_hits} · probe_hits=${r.probe_hits}（probe_last_outcome=${r.probe_last_outcome ?? '无'}）· ever_hit=${r.ever_hit}${r.legacy_ever_hit === 1 ? '（存量 ever_hit 已按 legacy-unknown 清零，不追溯追认）' : ''}${r.injected ? ` · ⚠ injected=true（--inject-state 夹具注入于 ${r.injected_at}：${r.injected_fields.join(', ')} —— mode=blocking 是假的，不作拦截权证据）` : ''} · 覆盖 ${r.covered_entries.length} 条 · when=${r.when ?? '未声明'}（声明性注解，派发器不求值）`)
  }
  // ===== 连续 error 视图（F9）：把「已连续 error ≥ 阈值」的守卫单列出来 = 静默失效抬到人眼前 =====
  // 纪律不变：这些守卫依旧 fail-open 放行（守卫自己坏了不该卡提交），这里只负责**看得见**。
  const silent = rows.filter((r) => r.error_streak >= ERROR_STREAK_THRESHOLD)
  if (silent.length > 0) {
    console.error(`[run-guard --dry-run] ⚠ 连续 error 守卫 ${silent.length} 条（连续 ≥ ${ERROR_STREAK_THRESHOLD} 次未成功 = 判据很可能根本没在跑）：`)
    for (const r of silent) {
      console.error(`[run-guard --dry-run]   ⚠ ${r.key} · 连续 error ${r.error_streak} 次 · 累计 error ${r.error_runs}/${r.shadow_runs} 次运行 · 仍 fail-open 放行（纪律不变），但它的判据已长期没跑起来`)
    }
  } else {
    console.error(`[run-guard --dry-run] 无连续 error ≥ ${ERROR_STREAK_THRESHOLD} 次的守卫（fail-open 纪律不变：本视图只提升可见性，不改变放行行为）`)
  }
  console.error('[run-guard --dry-run] evidence 口径：strong=blocking 且判据曾**野外出事**且无错误运行 / weak=绿灯攒满但判据从未野外出事（沉默无信息量，不产生退役证据；probe 命中不算「出事」）/ injected=拦截权来自 --inject-state 夹具注入（造出来的，不作证据）/ debt=守卫自身在报错 / no-evidence=从未派发')
  console.error('[run-guard --dry-run] 两型命中口径：wild_hits = 真实路由捕获（唯一能作退役证据的一型）/ probe_hits = `--probe` 人造验证（自证，不构成退役证据）')
  // ===== 连续超时视图：把「已连续被看门狗强杀」的守卫单列出来 =====
  // 与上面「连续 error」同一纪律：这些守卫依旧 fail-open 放行（超时不是判红），这里只**看得见**。
  // 为什么必须有这个视图：看门狗超时是 fail-open，若没有聚合视图，某个守卫可以连续几十次跑飞
  // 而没人知道 —— 那正是「静默失效」的定义。consecutive_timeout 是**单调后缀状态**
  // （成功一次即归零），不是调用计数，因此不违反零计数原则（指那种可被「把 N 次调用合并
  // 成一次」绕过的累计计数判据）。
  //
  // 读法：直接 JSON.parse 台账，不 import 门禁侧的模块 —— 跨 skill 边界 import 会让本 skill
  // 的零依赖性依赖上 scripts/guards/ 的内部结构。台账不存在/损坏一律当作「没有」。
  const timing = readTimingLedger(config, baseDir)
  const timedOutKeys = timing
    ? Object.keys(timing.guards).filter((k) => (timing.guards[k]?.consecutive_timeout ?? 0) > 0)
    : []
  if (timedOutKeys.length > 0) {
    console.error(`[run-guard --dry-run] ⏱ 连续超时守卫 ${timedOutKeys.length} 条（连续被看门狗强杀 = 跑飞了，不是判红了；仍 fail-open 放行）：`)
    for (const k of timedOutKeys) {
      const rec = timing.guards[k] ?? {}
      console.error(
        `[run-guard --dry-run]   ⏱ ${k} · 连续超时 ${rec.consecutive_timeout} 次 · 累计 ${rec.total_timeouts ?? 0} 次 · p95=${rec.p95_ms ?? 0}ms · 先查它在等什么（外部 IO / 锁 / 并发踩踏），不要直接 --no-verify`,
      )
    }
  } else {
    console.error('[run-guard --dry-run] 无连续超时守卫（fail-open 纪律不变：本视图只提升可见性，不改变放行行为）')
  }
  if (wantJson) process.stdout.write(`${JSON.stringify({ dry_run: true, dispatched: 0, error_streak_threshold: ERROR_STREAK_THRESHOLD, silently_failing: silent.map((r) => r.key), timing_timeout_streaks: timedOutKeys, guards: rows }, null, 2)}\n`)
  return 0
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node run-guard.mjs (--key <key> | --all) [--text <s>|--stdin] [--probe] [--config <p>] [--project-dir <d>] [--inject-state <json>] [--json] [--dry-run]
  --probe 本次是人造的破坏测试验证（照常派发、照常按 exit 2 阻断），命中只记 probe 账、**永不置 ever_hit**（不作退役证据）
  --dry-run 只读状态并逐条报 evidence=strong/weak/debt/no-evidence/injected，零 spawn 零写盘
  --inject-state '<json>' 仅供测试/夹具：{"<守卫key>":{…守卫级字段}} 并进 state.guards（key 须在 registry 登记，否则 exit 2）；
    被注入的守卫打 injected=true 标记，trace 拍4 判红 / verify 不退役 / evidence 降为 injected 档；不可与 --all / --dry-run 同用
  退出码：0=放行（含 shadow warn-only 与 fail-open） / 1=runner 内部错误 / 2=命中判据阻断或用法错误`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
