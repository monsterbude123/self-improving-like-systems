#!/usr/bin/env node
/**
 * inject.mjs —— 经验注入引擎 · 读路径 CLI（通用技能，零项目耦合）
 *
 * 用法（用法登记同步在 SKILL.md）：
 *   node inject.mjs --scope <域>[,<域>...] [--keywords <词>[,<词>...]] [--config <p>]
 *   --scope      本次任务域，必填；取值必须 ∈ config.scope.values，且不得点名
 *                config.scope.default 桶（该桶永不注入的 fail-safe）
 *   --keywords   关键词，可选；命中数 = 词在条目全文出现次数（不区分大小写）。
 *                给了词则 0 命中不入选；不给词（SessionStart 无 prompt）则按 status 权重 + recurrence 兜底排序
 *   --config     配置链同 validate.mjs：--config > env SELF_IMPROVING_CONFIG > repo 根 > 内置默认
 *
 * 输出（stdout 单块，给 SessionStart/hook 拼进 prompt）：
 *   scope 过滤 + config.injection.top_k 封顶的条目摘要块，每条含出处（条目 ID + 文件路径）
 *   与命中计数；总长超 config.injection.budget_chars → 降级为标题行列表（预算取自配置）；
 *   无入选条目 → 空输出（零噪音）。
 *
 * 退出码：0 = 一切正常（含 kill-switch off 与所有 fail-open）；2 = 用法错误。
 * **任何内部异常 fail-open**：stdout 空 + 审计一条 + exit 0，绝不阻塞调用方（读路径纪律）。
 *
 * 行为契约（AC 全部 fixture 化 = tests/inject.test.mjs）：
 *   - 正向：命中条目出现在输出，含出处与命中计数
 *   - 反向：跨 scope / default 桶条目不出现在输出，且拒绝动作落审计
 *     （审计 = config.storage.audit_log，本地 gitignored 不入库；缺键回退 os tmpdir 兜底）
 *   - 超预算 → 降级标题行（同时落 budget-degraded 审计）
 *   - 配置损坏 / 条目不可读 → fail-open：空块 + 审计 + exit 0
 *   - kill_switch.injection=false → 零输出且零副作用（不写任何审计）
 *   - 排序键全平 → 降级零注入 + rank-degraded 审计（票 H1：排序退化成字典序时不许注噪）
 *
 * O(1) spawn 纪律：目录枚举 readdirSync、判定全进程内完成；子进程仅 resolveRepoRoot 的
 *   常数一次 git rev-parse（找不到时上溯 .git 兜底）。禁止按文件起子进程。
 * YAML 统一经 ./lib/yaml-lite.mjs 双后端读取（宿主钩子零外部依赖可跑）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseYaml } from './lib/yaml-lite.mjs'
import { withFileLock } from './lib/atomic-file.mjs'
import { createLogger } from './lib/log.mjs'
import {
  extractFrontmatter,
  validateConfig,
  resolveRepoRoot,
  resolveConfigPath,
  BUILTIN_DEFAULT_CONFIG,
  NON_ENTRY_BASENAMES,
} from './validate.mjs'

const FALLBACK_AUDIT = path.join(os.tmpdir(), 'self-improving-injection-audit.jsonl')

function usage(msg) {
  console.error(`用法错误：${msg}
  node inject.mjs --scope <域>[,<域>...] [--keywords <词>[,<词>...] [--config <p>]
  --scope 取值须 ∈ config.scope.values，且不得点名 config.scope.default 桶
  退出码：0=正常（含 fail-open 与 kill-switch off） / 2=用法错误`)
  return 2
}

/**
 * 审计落盘（JSONL 追加）。写失败也只提示不抛 —— 审计是旁路，不是主链路。
 *
 * **加锁的原因**（票 H2）：多会话同时触发注入时，各进程的 chunk 交错会写出半行 JSON，
 * 而审计日志是事后对账的事实源，半行 = 读不出记录。故与状态账/事件账同走目录锁。
 * 锁序：调用方不得在持有另一把锁时调本函数（capture 的注入段刻意在 events 锁之外）。
 */
export function flushAudit(config, baseDir, records) {
  if (records.length === 0) return null
  const configured = config && config.storage && typeof config.storage.audit_log === 'string' && config.storage.audit_log.trim() !== ''
  const file = configured ? path.resolve(baseDir || process.cwd(), config.storage.audit_log) : FALLBACK_AUDIT
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const ts = new Date().toISOString()
    const chunk = records.map((r) => `${JSON.stringify({ ts, tool: 'inject', ...r })}\n`).join('')
    const append = () => appendFileSync(file, chunk, 'utf8')
    // 锁拿不到就退化为裸追加（可能交错，但不阻塞调用方）；审计是旁路，不值得为它挂起
    if (withFileLock(`${file}.lock`, append) === null) append()
    console.error(`[inject] 审计 ${records.length} 条 → ${file}`)
    return file
  } catch (e) {
    console.error(`[inject] 审计写入失败（fail-open 不阻塞）: ${e.message}`)
    return null
  }
}

/** fail-open：stdout 保持空，审计一条，exit 0（绝不阻塞调用方）。 */
export function failOpen(err, config, baseDir, module = 'inject') {
  const reason = (err && err.message) || String(err)
  console.error(`[inject] fail-open: ${reason}（输出空块，绝不阻塞调用方）`)
  // 异常独立成文件：inject / distill / verify / approve / hook 共用本出口，
  // 故在这里记一次就覆盖全部五个模块的 fail-open（否则「今天哪个模块出的事」要翻五个 stderr）。
  createLogger({ module, baseDir: baseDir || process.cwd(), config })
    .error(`fail-open: ${reason}`, err instanceof Error ? err : null)
  flushAudit(config, baseDir, [{ action: 'fail-open', error: reason }])
  return 0
}

/** 首个 Markdown 标题（降级标题行的文案源）；无则空串。 */
function firstTitle(lines) {
  const h = lines.find((l) => l.startsWith('# '))
  return h ? h.replace(/^#\s*/, '').trim() : ''
}

/**
 * status 加权（schema.md §1.2 并集）。
 *
 * 为什么它是排序键：SessionStart 没有 prompt → 关键词命中数恒 0，若只靠「命中数 + recurrence」，
 * 两级键在本仓语料上**全平**（83/83 条 `recurrence: 0`），排序退化成 ID 字典序 —— 同一 scope
 * 恒返回同一组条目，相关性恒等于 0。status 是本仓语料上**当前唯一非全平**的结构化信号
 * （实测 42 resolved / 43 未闭环），且语义正确：「还没闭环的教训」比「已闭环的教训」更该进上下文。
 */
const STATUS_WEIGHT = {
  open: 4,
  investigating: 4,
  active: 3,
  pending: 3,
  proposed: 2,
  approved: 2,
  shipped: 1,
  resolved: 0,
}
const statusWeight = (fm) => {
  const s = fm && typeof fm.status === 'string' ? fm.status : ''
  return Number.isInteger(STATUS_WEIGHT[s]) ? STATUS_WEIGHT[s] : 0
}

/**
 * 召回排序 = **加权打分**（业界记忆检索的标准三因子：Mem0 / AWS AgentCore Memory /
 * LangGraph 的长期记忆召回都用同一组维度，只是权重与衰减常数不同）。
 *
 * `score = w_relevance·relevance + w_importance·importance + w_recency·recency`，各因子归一到 [0,1]。
 *
 * 为什么必须换成打分而不是词典序：词典序里「命中 1 次」永远压过「命中 0 次但重要得多」，
 * 且 `last_verified_at` 只能当末位 tiebreak。经验条目不是聊天记录 —— **相关性**决定「是不是
 * 在说这件事」，**重要度**决定「这条教训值不值得占一屏」，**新近度**只做同分时的破平。
 *
 * 三个因子各取什么信号：
 *   relevance  关键词命中数，按 `relevance_saturation` 饱和。**没有查询时（SessionStart
 *               尚无 prompt）整个因子恒 0**，让位给另两个 —— 而不是拿 0 去和别人的非 0 比。
 *   importance `0.6·recurrence 归一 + 0.4·status 归一`：recurrence 是「被现实攻击过」的次数
 *               （唯一与内容无关的硬证据，故占大头），status 归一让未闭环条目先于已闭环。
 *   recency    `0.5 ** (ageDays / halfLife)`，指数半衰。日期取 `last_verified_at` ?? `date`；
 *               **两者皆无时取 0.5 中位值**，不是 0 —— 「不知道多老」不等于「最老」，
 *               取 0 会让存量条目永远沉底且再无回升可能。
 *
 * 同分一律按 id 升序收口，保证同一 scope 每次输出确定（不留随机性给上下文）。
 *
 * @param {object} e 候选条目（须带 count / recurrence / statusWeight / ageDays）
 * @param {object} w 权重与常数（来自 config.injection.ranking）
 * @returns {{score:number, relevance:number, importance:number, recency:number}}
 */
export function scoreEntry(e, w) {
  const relSat = Math.max(1, w.relevance_saturation)
  const relevance = Math.min(1, e.count / relSat)
  // recurrence 用对数压缩：0→1→2→3 的信息增量远大于 30→31，硬截断会让老条目全挤在同一档。
  const impSat = Math.max(1, w.importance_saturation)
  const recNorm = Math.min(1, Math.log1p(Math.max(0, e.recurrence)) / Math.log1p(impSat))
  const statusNorm = Math.max(0, Math.min(1, e.statusWeight / 4))
  const importance = 0.6 * recNorm + 0.4 * statusNorm
  const halfLife = Math.max(1, w.recency_half_life_days)
  const recency = e.ageDays === null ? 0.5 : 0.5 ** (Math.max(0, e.ageDays) / halfLife)
  const score = w.weights.relevance * relevance + w.weights.importance * importance + w.weights.recency * recency
  return { score, relevance, importance, recency }
}

/** 打分权重与常数：优先读实例配置 `injection.ranking`，缺项/非法回落到内置默认（fail-open）。 */
export const DEFAULT_RANKING = {
  weights: { relevance: 0.55, importance: 0.3, recency: 0.15 },
  relevance_saturation: 3,
  importance_saturation: 8,
  recency_half_life_days: 30,
}

export function resolveRanking(config) {
  const r = (config && config.injection && config.injection.ranking) || {}
  const w = r.weights && typeof r.weights === 'object' ? r.weights : {}
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d)
  return {
    weights: {
      relevance: num(w.relevance, DEFAULT_RANKING.weights.relevance),
      importance: num(w.importance, DEFAULT_RANKING.weights.importance),
      recency: num(w.recency, DEFAULT_RANKING.weights.recency),
    },
    relevance_saturation: Number.isFinite(r.relevance_saturation) && r.relevance_saturation > 0 ? r.relevance_saturation : DEFAULT_RANKING.relevance_saturation,
    importance_saturation: Number.isFinite(r.importance_saturation) && r.importance_saturation > 0 ? r.importance_saturation : DEFAULT_RANKING.importance_saturation,
    recency_half_life_days: Number.isFinite(r.recency_half_life_days) && r.recency_half_life_days > 0 ? r.recency_half_life_days : DEFAULT_RANKING.recency_half_life_days,
  }
}

/**
 * 最近验证过的优先（`last_verified_at` 新 → 旧，`null` 当最旧）。
 *
 * 为什么是排序键：**当前语料上恒平**（83/83 条 `null`，未绑定守卫故从未被 sweep 回写），
 * 保留它是因为它一旦非平就是强信号（刚被现实证伪过的经验最该被想起），排在 status 之后作次级键。
 */
const verifiedRank = (fm) => {
  const v = fm && typeof fm.last_verified_at === 'string' ? fm.last_verified_at : null
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '0000-00-00'
}

/** 主流程：scope 过滤 → 关键词命中 → top_k 封顶 → 预算渲染。异常一律上抛给 fail-open。 */
export function runInject(config, requested, keywords, baseDir, auditRecords) {
  const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
  if (!existsSync(entriesDir)) throw new Error(`entries_dir 不存在: ${entriesDir}`)
  const rawDir = String(config.storage.entries_dir)
  const relDir = /[\\/]$/.test(rawDir) ? rawDir : `${rawDir}/`
  const names = readdirSync(entriesDir)
    .filter((f) => f.endsWith('.md') && !NON_ENTRY_BASENAMES.has(f))
    .sort()

  const candidates = []
  for (const name of names) {
    // 不可读（目录占位 / 权限 / 截断）→ 抛错 → fail-open；带上文件名让审计能定位
    let text
    try {
      text = readFileSync(path.join(entriesDir, name), 'utf8')
    } catch (e) {
      throw new Error(`${name} 不可读（${e.message}）`)
    }
    const id = name.replace(/\.md$/, '')
    const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
    let fm = null
    if (lines[0] === '---') {
      const r = extractFrontmatter(text)
      if (r.error) throw new Error(`${name} frontmatter 不可读（${r.error}）`)
      fm = r.fm
    }
    // scope 过滤：无 frontmatter 回落 default 桶（config.scope.default，fail-safe 永不注入）
    const scope = (fm && typeof fm.scope === 'string' && fm.scope) || config.scope.default
    if (scope === config.scope.default || !requested.includes(scope)) {
      auditRecords.push({
        action: 'scope-rejected',
        reason: scope === config.scope.default ? 'default-bucket' : 'cross-scope',
        entry: id,
        scope,
        requested: [...requested],
      })
      continue
    }
    const hay = text.toLowerCase()
    let count = 0
    for (const k of keywords) count += hay.split(k).length - 1
    if (keywords.length > 0 && count === 0) continue // 无命中 ≠ 拒绝：不入选即可，无须审计
    const claim = (fm && typeof fm.claim === 'string' && fm.claim.trim()) || ''
    const title = firstTitle(lines) || claim || id
    candidates.push({
      id,
      file: name,
      scope,
      count,
      claim: claim || title,
      title,
      fm,
      recurrence: fm && Number.isInteger(fm.recurrence) ? fm.recurrence : 0,
      statusWeight: statusWeight(fm),
      verified: verifiedRank(fm),
    })
  }

  // ===== 排序：加权打分（relevance / importance / recency 衰减）desc → id asc 收口 =====
  // 因子定义与取值理由见 scoreEntry 的注释；权重来自实例配置 injection.ranking（缺项回落内置默认）。
  const ranking = resolveRanking(config)
  const nowMs = Date.now()
  for (const c of candidates) {
    // ageDays 取 last_verified_at ?? date；两者皆无 = null（recency 记 0.5 中位，不当最旧）
    const d = verifiedRank(c.fm) !== '0000-00-00' ? verifiedRank(c.fm) : (typeof c.fm?.date === 'string' ? c.fm.date : null)
    let ageDays = null
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const t = Date.parse(`${d}T00:00:00Z`)
      if (Number.isFinite(t)) ageDays = (nowMs - t) / 86_400_000
    }
    c.ageDays = ageDays
    const s = scoreEntry(c, ranking)
    c.score = s.score
    c.factors = s
  }
  // 确定性收口：同分必须有稳定序，否则同一 scope 每次输出抖动。
  candidates.sort((a, b) => (b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  // ===== 全部分数相同 → 降级为零注入（宁可零注入，也不注入一份常量噪音）=====
  // 判据：候选集里每一条 **score 完全相同** —— 那排序实际是由 ID 字典序决定的，输出与本次
  // 会话上下文毫无关系（同一 scope 恒返回同一组），相关性恒等于 0。这种「看起来在挑、其实在
  // 数 ID」的注入比不注入更坏：它用一屏上下文换零信息，还会让「已注入过经验」看起来成立。
  // 故显式降级为 0 条并落审计（人可查为什么没注入）。
  // 给了 keywords 时不可能触发：0 命中的条目已在上面被过滤掉，relevance 天然非全平。
  if (candidates.length > 1) {
    const first = candidates[0].score
    const flat = candidates.every((c) => c.score === first)
    if (flat) {
      auditRecords.push({
        action: 'rank-degenerate',
        reason: '全部候选加权分完全相同 —— 排序退化为 ID 字典序',
        scope: requested.join(','),
        keywords: [...keywords],
        candidates: candidates.length,
        score: first,
        deferred_to: '注入零条（宁可零注入，也不注入常量噪音）',
      })
      return ''
    }
  }

  const topK = Number.isInteger(config.injection.top_k) && config.injection.top_k > 0 ? config.injection.top_k : 5
  const budget = Number.isInteger(config.injection.budget_chars) && config.injection.budget_chars > 0 ? config.injection.budget_chars : 2000
  const selected = candidates.slice(0, topK)
  if (selected.length === 0) return '' // 无入选 = 零输出（不印空标题噪音）

  const scopeStr = requested.join(',')
  // 诊断轨迹：这次召回把哪几条放进来了、各自多少分。审计账是证据不滚动，这里是诊断会滚动，
  // 两者都要 —— 审计回答「发生过什么」，轨迹回答「这次为什么是这个结果、耗时多少」。
  const rankLogger = createLogger({ module: 'inject', baseDir, config })
  rankLogger.span('inject.rank', {
    scope: scopeStr,
    keywords: keywords.join('|'),
    candidates: candidates.length,
    selected: selected.length,
    top_score: selected.length > 0 ? Number(selected[0].score.toFixed(6)) : null,
    top_entry: selected.length > 0 ? selected[0].id : null,
  })
  rankLogger.info(`召回 ${selected.length} 条 · scope=${scopeStr}`, {
    scope: scopeStr,
    keywords: keywords.join('|'),
    candidates: candidates.length,
    selected: selected.length,
  })
  // ===== provenance 审计：成功注入的条目 ID 逐条落账 =====
  // 缺口背景：此前只在 `scope-rejected` 分支记 `entry`，成功路径一条不记 —— 于是
  // 「这一屏上下文里的经验是哪几条、凭什么被选中」无法回答，注入侧是**写盲区**。
  // `learned_via: recall` 与 distill 侧的 `learned_via: distill` 同名不同义，
  // 二者合起来才能区分「这条知识是**回忆**来的还是**蒸馏**来的」。
  auditRecords.push({
    action: 'entry-recalled',
    learned_via: 'recall',
    scope: scopeStr,
    keywords: [...keywords],
    ranking: { weights: ranking.weights, recency_half_life_days: ranking.recency_half_life_days },
    entries: selected.map((e) => ({
      entry: e.id,
      file: e.file,
      scope: e.scope,
      keyword_hits: e.count,
      recurrence: e.recurrence,
      // 打分与三因子全量落审计：被召回的每一条都能回答「凭什么是它」（对账用，不参与判定）
      score: Number(e.score.toFixed(6)),
      relevance: Number(e.factors.relevance.toFixed(4)),
      importance: Number(e.factors.importance.toFixed(4)),
      recency: Number(e.factors.recency.toFixed(4)),
      age_days: e.ageDays === null ? null : Number(e.ageDays.toFixed(1)),
    })),
  })

  const header = `## 经验注入（${selected.length} 条 · scope=${scopeStr} · 预算 ${budget} 字符）`
  const body = selected
    .map((e) => `- [${e.id}] ${e.claim}\n  出处: ${relDir}${e.file} · scope=${e.scope} · 命中 ${e.count} 次`)
    .join('\n')
  const full = `${header}\n${body}\n`
  if (full.length <= budget) {
    auditRecords[auditRecords.length - 1].render = 'full'
    return full
  }

  // ===== 超预算降级：标题行列表（预算取自配置；逐行裁到预算内，宁少一条不越界）=====
  // 标题行必须**先裁后写标题**：反过来的话标题会报入选数（实测 top_k=20 / 预算 600 时标题写
  // 「20 条」而正文只剩 5 行）—— 注入块谎报自己的体量，与本系统「如实、不静默」的纪律相悖。
  // 标题只报**实际保留数**，丢弃数留给审计的 `dropped` 字段：往标题里加「已丢弃 N 条」这类
  // 说明会吃掉预算本身，实测把 120 字符的小预算压到连一条都放不下（hook 套降级用例变红）。
  const titles = selected.map((e) => `- [${e.id}] ${e.title}`)
  const dheader = (n) => `## 经验注入（${n} 条 · scope=${scopeStr} · 超预算(${full.length}>${budget})降级为标题行）`
  while (titles.length > 0 && `${dheader(titles.length)}\n${titles.join('\n')}\n`.length > budget) titles.pop()
  auditRecords[auditRecords.length - 1].render = 'titles-degraded'
  auditRecords[auditRecords.length - 1].kept_ids = titles.map((t) => t.match(/\[([^\]]+)\]/)?.[1]).filter(Boolean)
  auditRecords.push({
    action: 'budget-degraded',
    budget,
    full_chars: full.length,
    kept: titles.length,
    dropped: selected.length - titles.length,
  })
  if (titles.length === 0) return `${dheader(0).slice(0, Math.max(1, budget - 1))}\n`
  return `${dheader(titles.length)}\n${titles.join('\n')}\n`
}

/**
 * 配置链解析（`--config` > env `SELF_IMPROVING_CONFIG` > 仓根 > 内置默认）+ 结构校验。
 *
 * 为什么抽出：SessionStart 接线与事件捕获两个消费方必须与本 CLI **逐字同一份**配置链，
 * 各自复制一遍解析逻辑必然漂移（配置链改一处、三个调用方三种行为）。抽出后由
 * hook-session-start.mjs / capture.mjs import 复用。
 *
 * 异常一律上抛给调用方的 fail-open（stdout 空 + 审计 + exit 0，读路径纪律）。
 * **已解析出的部分配置挂在异常上**（`err.config` / `err.baseDir`）：结构违规时 fail-open 仍要
 * 按实例配置里的 audit_log 落审计，丢了它就会退到 <os tmpdir> 兜底路径（可观测性降级）。
 * @returns {{config: object, baseDir: string, repoRoot: string|null, configPath: string|null}}
 */
export function loadContext({ cliConfig = null, env = process.env, cwd = process.cwd() } = {}) {
  const repoRoot = resolveRepoRoot(cwd)
  const { path: cfgPath, source } = resolveConfigPath({ cliConfig, env, repoRoot })
  let config = null
  let baseDir = null
  try {
    if (cfgPath) {
      if (!existsSync(cfgPath)) throw new Error(`配置不存在 ${cfgPath}（${source}）`)
      config = parseYaml(readFileSync(cfgPath, 'utf8'))
      // storage.* 的基准 = **配置文件所在目录**（`baseDir = dirname(cfgPath)`），不是仓库根。
      // 这条曾被误写成「相对仓库根目录」，害我照着文档改代码、把 inject/concurrency 两套打红 ——
      // 夹具刻意用「cwd=真实仓库根 + --config 指向夹具」来钉这条语义：改成仓库根基准后，
      // 夹具的 `entries_dir: entries/` 会解析到真实仓根下不存在的位置，注入静默返空。
      // 语义选它的理由：一份配置 + 它描述的数据构成**可移植自包含包**（测试夹具、临时实验
      // 都靠这一点），且与 cwd 解耦 —— 同一配置在任何 cwd 下解析结果一致。
      baseDir = path.dirname(cfgPath)
    } else {
      config = BUILTIN_DEFAULT_CONFIG
      baseDir = repoRoot || cwd
    }
    const viol = validateConfig(config)
    if (viol.length > 0) throw new Error(`config 结构违规（${viol[0]}）`)
  } catch (e) {
    if (e && typeof e === 'object') {
      if (e.config === undefined) e.config = config
      if (e.baseDir === undefined) e.baseDir = baseDir
    }
    throw e
  }
  return { config, baseDir, repoRoot, configPath: cfgPath }
}

export function main(argv) {
  // ===== 1. 参数语法（纯调用方错误 → exit 2，先于任何 fail-open 判定）=====
  let cliConfig = null
  let scopeArg = null
  let keywordsArg = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config' || a === '--scope' || a === '--keywords') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return usage(`${a} 后须跟值`)
      i++
      if (a === '--config') cliConfig = path.resolve(next)
      else if (a === '--scope') scopeArg = next
      else keywordsArg = next
    } else {
      return usage(`未知参数 ${a}`)
    }
  }
  if (scopeArg === null || scopeArg.trim() === '') return usage('--scope 必填（任务域，如 --scope infra,testing）')

  // ===== 2. 配置链（解析/结构失败 → fail-open，此时审计走可得的路径）=====
  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: process.cwd() })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    // 部分配置（已解析但结构违规）挂在异常上：fail-open 据此按实例 audit_log 落审计
    return failOpen(e, (e && e.config) || null, (e && e.baseDir) || null)
  }

  // ===== 3. scope 取值校验（需 config.scope.values，属调用方错误 → exit 2）=====
  const requested = scopeArg.split(',').map((s) => s.trim()).filter(Boolean)
  if (requested.length === 0) return usage('--scope 为空')
  const bad = requested.filter((s) => !config.scope.values.includes(s))
  if (bad.length > 0) return usage(`--scope 取值非法: ${bad.join(', ')}（合法值: ${config.scope.values.join(', ')}）`)
  if (requested.includes(config.scope.default)) {
    return usage(`--scope 不得点名默认桶 ${config.scope.default}（fail-safe：该桶永不注入）`)
  }

  // ===== 4. kill-switch off：零输出且零副作用（先于一切会写盘的路径）=====
  // 必须排在 scope 校验之后：用法错与开关态正交。若开关在前，非法 --scope 会被
  // off 态吞成 exit 0，票 07 接线后钩子就把「调用方写错了」静默当成「开关关着」。
  if (config.kill_switch.injection !== true) {
    console.error('[inject] kill_switch.injection=false，跳过注入（零输出、零副作用）')
    return 0
  }
  const keywords = keywordsArg ? keywordsArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []

  // ===== 5. 主流程（内部异常 fail-open：空块 + 审计 + exit 0）=====
  try {
    const auditRecords = []
    const block = runInject(config, requested, keywords, baseDir, auditRecords)
    flushAudit(config, baseDir, auditRecords)
    if (block !== '') process.stdout.write(block)
    return 0
  } catch (e) {
    return failOpen(e, config, baseDir)
  }
}

// 仅当被直接执行时运行 CLI（导出供测试复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
