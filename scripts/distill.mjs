#!/usr/bin/env node
/**
 * distill.mjs —— 蒸馏提案器（通用技能，零项目耦合，宿主可跑）
 *
 * 角色：把事件库（`config.storage.events_dir` 的按日 JSONL 分片）聚成**失效模式簇**，
 * 每簇产出一份 **Entry 草案**写到 `config.storage.proposals_dir`。
 * **只提案、不落正式区（`config.storage.entries_dir`）**：本文件全程没有任何指向 `storage.entries_dir`
 * 的写路径（可 `grep entries_dir scripts/distill.mjs` 自证），落位由人工逐条批准后决定。
 *
 * 用法：
 *   node distill.mjs [--from <事件目录>] [--to <提案目录>] [--scope <域>[,<域>]]
 *                   [--min-count <n>] [--dry-run] [--json] [--config <p>] [--project-dir <目录>]
 *   --project-dir 会话所属项目目录（钩子传 ${ZCODE_PROJECT_DIR}）；配置链以它为仓根基准解析
 *   --from        读事件的目录（缺省 = config.storage.events_dir；测试与降级手动路径用）
 *   --to          写草案的目录（缺省 = config.storage.proposals_dir）
 *   --scope       显式指定条目 scope，逗号分隔；缺省 = 事件文本命中 > 条目语料投票 > config.scope.default
 *   --min-count   recurrence 下限（缺省 1 = 全量出草案）
 *   --dry-run     只报告将要产出什么（含将要清扫的陈旧草案），不写盘（零副作用）
 *   --json        stdout 输出 JSON 数组（**默认摘要走 stderr**，stdout 留空 → 钩子 stdout 恒空）
 *   --config      配置链同 inject.mjs：--config > env SELF_IMPROVING_CONFIG > 仓根 > 内置默认
 *
 * stdout 契约：默认**恒空**，全部人类可读摘要走 stderr。这样挂到生命周期钩子时
 * 宿主把 stdout 当 JSON 解析也不会因多一个键而判失败（宿主钩子 stdout 是严格 schema）。
 *
 * 退出码：0 = 正常（含 kill-switch off、空事件库与所有 fail-open）；2 = 用法错误。
 * 任何内部异常 fail-open：不写草案 + 审计一条 + exit 0（钩子绝不能把会话搞失败）。
 *
 * 聚类策略（两级，全部确定性）：
 *   ① fingerprint 归并：事件层已按 fp 归并，跨分片再按 fp 求和 → recurrence = 该 fp 的累计次数；
 *   ② 骨架成簇：同 kind + 错误码集合相同 + token Jaccard ≥ capture.mjs 的 NEIGHBOR_THRESHOLD
 *      （复用 `similarity` 与阈值常量，**不复制第二份相似度实现**）→ 合并为一个簇。
 *   近邻合并是**簇级**的，不改事件库、不改 capture 的「近邻只登记不合并」纪律 —— 事件层留人工，
 *   草案层给候选，一个簇一份草案比一 fingerprint 一份更接近「一条失效模式 = 一条经验」。
 *
 * 幂等：**一簇一文件**，文件名 `PROP-<cluster16>-<slug>.md`（cluster16 = 簇 ID，稳定不变）。
 *   文件名**不得含事件集指纹** —— 集指纹每次新增/复发都变，带上它就等于「每次蒸馏都另起一份新文件」，
 *   同一簇的 27 份重复草案正是这么堆出来的（recurrence 从 1 散到 28）。内容不含任何「本次运行时刻」
 *   字段 → 同一事件集重复蒸馏得到逐字节相同的文件名与内容（既有同内容文件跳过写）。
 *
 * 陈旧清扫：写完本轮全部簇后读一次 proposals 目录，凡 cid 不在本轮存活簇集合内的一律删
 *   （`--dry-run` 只报不删）。**不留历史**：proposals_dir 是 gitignored 暂存区，approve.mjs 只
 *   「读单个文件 → 人工消费」，全程不写回不删不改 —— 旧副本零消费者，晋升后的权威记录在
 *   `.learnings/` 条目 + registry，历史留在这里没有意义，留着只会淹没人工评审面。
 *   旧命名 `PROP-<evtset8>-<cluster16>-<slug>.md` 同批清扫（它们就是那批重复）。
 *   两道安全阀：① 本轮一个簇都没成（空事件库 / 目录不存在）→ **不清扫**（零副作用，沿用既有契约）；
 *   ② 存活集合按**未过滤**的全量簇算 —— `--min-count` 只是降噪输出开关，不得顺手删掉低频簇的旧草案。
 *
 * 行为契约（AC 全部 fixture 化 = tests/distill.test.mjs）：
 *   - 正向：每簇一份草案，过 validateEntry 判据（7 必填 + 可选键合法）
 *   - 三要素：可证伪 claim / 守卫绑定建议（候选 guard_ref + 可执行判定思路）/ scope
 *   - git 级证明：正式区零写入（本文件不 import entries_dir 写路径，测试用目录快照守）
 *   - 幂等：同一事件集跑两次草案集合逐字节不变
 *   - 破坏：空事件库 → exit 0 + 空列表 + 连提案目录都不建（不报错、不造假）
 *   - kill_switch.distill=false → 零写盘零提案（零副作用）；开态用 env 指定临时配置断言
 *
 * O(1) spawn 纪律：目录枚举 readdirSync、判定全进程内完成；子进程仅 loadContext 的
 *   常数一次 git rev-parse。禁止按文件起子进程。YAML 统一经 ./lib/yaml-lite.mjs 双后端。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadContext, flushAudit, failOpen } from './inject.mjs'
import { similarity, NEIGHBOR_THRESHOLD } from './capture.mjs'
import { extractFrontmatter, validateEntry } from './validate.mjs'
import { atomicWrite } from './lib/atomic-file.mjs'

/** kind → 条目 type（gate_block/tool_error/hook_failure 是失效 → ERR；manual 是人工记的经验 → LRN）。 */
const KIND_TYPE = { gate_block: 'ERR', tool_error: 'ERR', hook_failure: 'ERR', manual: 'LRN' }
/** kind → 守卫建议的触发时机文案（when 的草案；registry 三键见 schema.md §3）。 */
const KIND_WHEN = {
  gate_block: 'commit 前置守卫链（宿主 commit hook GUARDS 派发）—— 同一失效在门禁处已出现过，直接拦在提交前',
  tool_error: '变更相关工具调用前 + commit 前置守卫链 —— 工具报错说明前置条件缺失，应在触发前判据就拦住',
  hook_failure: '会话生命周期钩子启动前 —— 钩子自身失败会污染整轮上下文，必须在拉起前判活',
  manual: '暂无自动时点（人工记录的事件）—— 建议先补一个 hook/tool 事件源，otherwise 只能挂在人工复核清单上',
}
/** 样本消息截断长度（草案正文引用原文的展示上限；事件库里的原文不受影响）。 */
const SAMPLE_CHARS = 220
/** 条目投票的共现门槛：条目至少同时命中本簇 2 个 token 才算一条证据。 */
const MIN_COOCCURRENCE = 2
/** 领先票的绝对下限（IDF 加权后的票重，满分 ≈ 1）。低于此值 = 证据太弱，判未归类。 */
const MIN_VOTE_SCORE = 0.8
/** 领先票相对次席的领先倍数下限（低于此值 = 两个域势均力敌，判未归类）。 */
const VOTE_MARGIN = 2

function usage(msg) {
  console.error(`用法错误：${msg}
  node distill.mjs [--from <事件目录>] [--to <提案目录>] [--scope <域>,...] [--min-count <n>]
                  [--dry-run] [--json] [--config <p>] [--project-dir <目录>]
  stdout 默认恒空（摘要走 stderr）；--json 时 stdout 输出草案清单
  退出码：0=正常（含 kill-switch off、空事件库、fail-open） / 2=用法错误`)
  return 2
}

// ===== 一、事件读取与归并 =====

/** 读一个 JSONL 分片 → 记录数组（坏行跳过并提示，单行坏掉不毁整个文件，与 capture 同纪律）。 */
function readShard(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch (e) {
      console.error(`[distill] 跳过坏行（${path.basename(file)}）: ${e.message}`)
    }
  }
  return out
}

/**
 * 读事件目录（按日分片 `events-\d{8}.jsonl`），按 fingerprint 跨分片求和归并。
 * 归并口径与事件层一致：**同一错误只留一条事实**，recurrence = 各分片 count 之和。
 * @param {string} eventsDir
 * @returns {object[]} 每个 fingerprint 一条，含 members（原始记录，按 ts/id 稳定排序）
 */
export function readEvents(eventsDir) {
  if (!existsSync(eventsDir) || !statSync(eventsDir).isDirectory()) return []
  const files = readdirSync(eventsDir)
    .filter((f) => /^events-\d{8}\.jsonl$/.test(f))
    .sort()
  const byFp = new Map()
  for (const f of files) {
    for (const rec of readShard(path.join(eventsDir, f))) {
      if (!rec || typeof rec !== 'object') continue
      const fp = typeof rec.fingerprint === 'string' && rec.fingerprint !== '' ? rec.fingerprint : null
      if (fp === null) {
        console.error(`[distill] 跳过无 fingerprint 的事件行（${f} · id=${rec.id ?? '?'}）`)
        continue
      }
      const count = Number.isInteger(rec.count) && rec.count > 0 ? rec.count : 1
      const hit = byFp.get(fp)
      if (hit) {
        hit.recurrence += count
        hit.members.push(rec)
      } else {
        byFp.set(fp, { fingerprint: fp, recurrence: count, members: [rec] })
      }
    }
  }
  // 成员按 (ts, id) 稳定排序 —— 草案引用样本行时输出必须确定性。
  for (const hit of byFp.values()) {
    hit.members.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || String(a.id || '').localeCompare(String(b.id || '')))
  }
  return [...byFp.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
}

// ===== 二、成簇 =====

/** 一条归并事件的稳定摘要字段（kind/source/codes/tokens 从最早那条成员记录取，聚类键必须稳定）。 */
function shapeOf(hit) {
  const first = hit.members[0] || {}
  return {
    fingerprint: hit.fingerprint,
    kind: typeof first.kind === 'string' ? first.kind : 'manual',
    source: typeof first.source === 'string' ? first.source : 'manual',
    codes: Array.isArray(first.codes) ? first.codes.filter((c) => typeof c === 'string') : [],
    tokens: Array.isArray(first.tokens) ? first.tokens.filter((t) => typeof t === 'string') : [],
    recurrence: hit.recurrence,
    members: hit.members,
  }
}

/** 两条事件的错误码集合是否相同（排序后逐项比；不同则绝不入同一簇 —— 错误码是首要区分维度）。 */
function sameCodes(a, b) {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((v, i) => v === y[i])
}

/**
 * 失效模式成簇：同 kind + 同错误码集合 + token 相似度 ≥ 阈值 → 同一簇。
 * 贪心、按 fingerprint 字典序遍历（输入已排序 → 输出确定性，可重复蒸馏）。
 * @param {object[]} hits readEvents 的产物
 * @returns {object[]} 每簇一个对象：{ members: shape[], recurrence, kind, source, codes, tokens }
 */
export function buildClusters(hits) {
  const shapes = hits.map(shapeOf)
  const clusters = []
  for (const s of shapes) {
    let target = null
    for (const c of clusters) {
      if (c.kind !== s.kind) continue
      if (!sameCodes(c.codes, s.codes)) continue
      if (similarity(s.tokens, c.tokens) >= NEIGHBOR_THRESHOLD) {
        target = c
        break
      }
    }
    if (target) {
      target.members.push(s)
      target.recurrence += s.recurrence
      // 簇级 token 取并集后按长度降序（更长 = 更有区分度的检索词），保证确定性。
      target.tokens = [...new Set([...target.tokens, ...s.tokens])].sort((a, b) => b.length - a.length || a.localeCompare(b))
    } else {
      clusters.push({ kind: s.kind, source: s.source, codes: [...s.codes], tokens: [...s.tokens], recurrence: s.recurrence, members: [s] })
    }
  }
  return clusters
}

// ===== 三、scope 推断（事件文本命中 > 条目语料投票 > 默认桶）=====

/** 在文本里数 scope 名（含其连字符/下划线变体）出现次数；零依赖、不硬编码任何项目主题词。 */
function scopeHitsInText(text, scopeValues) {
  const hay = ` ${String(text).toLowerCase()} `
  const out = {}
  for (const v of scopeValues) {
    const needle = v.toLowerCase()
    if (needle === '') continue
    let n = 0
    let idx = hay.indexOf(needle)
    while (idx >= 0) {
      n++
      idx = hay.indexOf(needle, idx + needle.length)
    }
    if (n > 0) out[v] = n
  }
  return out
}

/**
 * 条目语料投票：在 entries_dir 里找与本簇 salient token 有共同词的条目，按其 scope 计票。
 * 语料命中说明「这条失效与该域的历史经验同形」—— 比事件文本命中更贴近本仓真实主题分布。
 * 读只读（不写），读不到/解析失败一律忽略（fail-safe：退回默认桶而不是编造域）。
 *
 * 计票**按词的稀有度加权**（IDF 思路）：词在语料里出现得越普遍，票重越低。
 * 不加权会翻车 —— 骨架里 `after` / `pool` 这类泛用词能命中半个语料库，
 * 于是「vitest worker timeout」会被语料里恰好含这些泛用词的其他域条目投票带跑，
 * 把域判成一个与该失效毫无关系的桶。加权后区分度高的词（vitest / worker / docker）
 * 主导投票，泛用词几乎不再左右结果。
 *
 * 两条证据门槛（缺一即**不投票**，退回默认桶而不是编一个域）：
 *   - 共现门槛：条目至少要同时命中本簇 **2 个** token。命中 1 个多半是泛用词擦边；
 *   - 置信门槛：见 scopeFromVotes —— 领先票必须绝对够高且甩开第二名够远。
 * 骨架全是 `fail` / `guard` / `commit` 这类词的簇（如门禁拦截类事件）过不了门槛，
 * 于是明说「未归类」交人工，而不是把域猜成一个看着像但无关的桶。
 */
function scopeVotesFromEntries(entriesDir, config, tokens) {
  const votes = {}
  if (!existsSync(entriesDir)) return votes
  let names = []
  try {
    names = readdirSync(entriesDir).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'index.md')
  } catch {
    return votes
  }
  const docs = []
  for (const name of names.sort()) {
    let raw = ''
    try {
      raw = readFileSync(path.join(entriesDir, name), 'utf8')
    } catch {
      continue
    }
    const { fm, error } = extractFrontmatter(raw)
    if (error || !fm || typeof fm.scope !== 'string') continue
    if (!config.scope.values.includes(fm.scope)) continue
    docs.push({ scope: fm.scope, text: raw.toLowerCase() })
  }
  if (docs.length === 0) return votes
  // df（文档频率）：词出现在多少条目里 → 票重 = 1/df（出现在全部条目里的词票重趋近 0）。
  const weight = new Map()
  for (const t of tokens) {
    const df = docs.reduce((n, d) => n + (d.text.includes(t) ? 1 : 0), 0)
    if (df > 0) weight.set(t, 1 / df)
  }
  for (const d of docs) {
    const matched = [...weight.keys()].filter((t) => d.text.includes(t))
    if (matched.length < MIN_COOCCURRENCE) continue // 共现门槛：命中 1 个 = 泛用词擦边，不算证据
    let best = 0
    for (const t of matched) {
      const w = weight.get(t)
      if (w > best) best = w
    }
    if (best > 0) votes[d.scope] = (votes[d.scope] || 0) + best
  }
  return votes
}

/**
 * 投票 → scope（含**置信门槛**）。
 * 领先票权重须 ≥ MIN_VOTE_SCORE 且 ≥ 次席的 MARGIN 倍，否则判「未归类」返回 null
 * （调用方落 config.scope.default 的未归类桶，等人工归域）。
 * 宁可不判也不误判：域判错不会让断言失效，但会让草案进错栏目、后续人工评审白花时间。
 */
function scopeFromVotes(votes) {
  const ranked = Object.keys(votes).sort((a, b) => votes[b] - votes[a] || (a < b ? -1 : 1))
  if (ranked.length === 0) return null
  const top = votes[ranked[0]]
  const second = ranked.length > 1 ? votes[ranked[1]] : 0
  if (top < MIN_VOTE_SCORE) return null
  if (second > 0 && top < second * VOTE_MARGIN) return null
  return ranked[0]
}

// ===== 四、草案渲染 =====

/** slug 化：只留小写字母数字与连字符，长度封顶；空则回落 'event'（registry key 形态要求）。 */
function slugify(text, max = 40) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.slice(0, max).replace(/-+$/, '') || 'event'
}

/** 双引号标量转义：JSON 字符串是 YAML 双引号标量的合法子集（\n \" \\ \u 都对得上）。 */
function q(s) {
  return JSON.stringify(String(s))
}

/** 事件原文摘要（截断 + 单行化，供草案正文引用）。 */
function sampleOf(member) {
  const raw = member && member.payload && typeof member.payload.message === 'string' ? member.payload.message : ''
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > SAMPLE_CHARS ? `${one.slice(0, SAMPLE_CHARS)}…` : one
}

/** 簇的簇 ID（单成员 = 原 fingerprint 后 16 位；多成员 = 成员 fingerprint 集合的摘要）。 */
function clusterId(cluster) {
  const fps = cluster.members.map((m) => m.fingerprint).sort()
  if (fps.length === 1) return fps[0].replace(/^fp-/, '').slice(0, 16)
  return createHash('sha256').update(fps.join('|')).digest('hex').slice(0, 16)
}

/** 事件集指纹（全部 fingerprint + recurrence 的稳定摘要）—— 草案文件名的一部分 = 幂等键。 */
export function eventSetFingerprint(hits) {
  const body = hits.map((h) => `${h.fingerprint}:${h.recurrence}`).sort().join('\n')
  return createHash('sha256').update(body).digest('hex').slice(0, 8)
}

/**
 * 守卫绑定建议：候选 guard_ref（registry key 形态）+ 可执行判定思路。
 *
 * 「判定思路」不是文案而是**能照着写的判据**：① 触发时机 ② 判据动作与失败形态 ③ 破坏测试自检
 * ④ 登记形态。前 3 次 shadow warn-only 的升级规则来自 schema.md §3，这里只复述契约不改判据。
 */
function guardSuggestion(cluster, slug) {
  const kind = cluster.kind
  const when = KIND_WHEN[kind] || KIND_WHEN.manual
  const key = slugify(`guard-${kind}-${slug}`, 60)
  const tokens = cluster.tokens.slice(0, 5)
  const tokenHint = tokens.length > 0 ? tokens.join(' / ') : '（事件 tokens 为空：判据须退回错误码或路径形态）'
  return {
    key,
    lines: [
      `- 候选 \`guard_ref\`：**\`${key}\`**（registry key 形态；**未登记** —— 登记前 \`guard_ref: null\`，草案不代签）`,
      `- 触发时机（when 草案）：${when}`,
      `- 判据动作（args 草案）：直调 \`node <守卫脚本> --text -\`，读取 stdin 的失败输出；命中判据 → \`exit 2\` 阻断，未命中 → \`exit 0\` 放行（直调 argv，**不经包管理器 run 层**，schema.md §3）`,
      `- 命中判据的抓手（可执行化）：本簇 salient token = ${tokenHint}；判据须能在这组 token 上做**确定性匹配**（路径归一化后比对，宿主/容器双形态同判）`,
      `- 破坏测试自检（登记前必做）：① 把下方「触发样本」原样喂给守卫 → **必须变红**；② 喂一条不含该 token 的正常输出 → **必须保持绿**。变绿的守卫判据无效，禁止登记`,
      `- 登记形态：registry \`guards[]\` 的 \`key\` / \`args\` / \`when\` 三键；新守卫前 3 次 shadow warn-only（\`shadow_runs ≥ 3 && shadow_green === shadow_runs\` 才升 blocking）`,
    ],
  }
}

/**
 * 渲染一份草案（Entry 契约文本形态：frontmatter 必过 validateEntry + 正文三要素）。
 * **正文不含运行时刻**（时间只来自事件本身）→ 同一事件集渲染结果逐字节稳定。
 *
 * 文件名只由**簇 ID + slug** 决定（`setFp` 仅作为返回值信息透传，不进文件名）：
 * 簇 ID 是稳定标识，recurrence 增长走 atomicWrite 原地覆盖，不另开新文件。
 */
export function renderProposal({ cluster, scope, scopeBasis, config }) {
  const slugBase = cluster.tokens.slice(0, 3).join('-') || cluster.kind
  const slug = slugify(slugBase)
  const cid = clusterId(cluster)
  const type = KIND_TYPE[cluster.kind] || 'ERR'
  const guard = guardSuggestion(cluster, slug)
  const fileName = `PROP-${cid}-${slug}.md`

  const members = cluster.members
  // 首末时间取成员记录的首条 ts 与末条 last_ts（事件库自身的事实，不掺「本次运行时刻」）。
  const firstRec = members[0].members[0] || {}
  const lastRec = members[members.length - 1].members[members[members.length - 1].members.length - 1] || {}
  const firstTs = typeof firstRec.ts === 'string' ? firstRec.ts : ''
  const lastTs = typeof lastRec.last_ts === 'string' ? lastRec.last_ts : typeof lastRec.ts === 'string' ? lastRec.ts : ''
  const dayOf = (ts) => (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : '')
  const date = dayOf(lastTs) || dayOf(firstTs) || undefined
  const tags = [...new Set([cluster.kind, cluster.source, ...cluster.codes, ...cluster.tokens.slice(0, 4)])].slice(0, 8)

  // ===== 可证伪 claim：由簇的统计事实（次数/时间跨度/形态）+ 前置动作构成，
  //      断言形态是「若做了 X 则该失效不再出现」，可被事件库与守卫双向证伪。
  //      刻意不写成「错误码 A 出现 N 次」这类同义反复 —— 那种话永不可证伪。
  const span = firstTs && lastTs ? `${String(firstTs).slice(0, 10)} ~ ${String(lastTs).slice(0, 10)}` : '（事件时间戳缺失）'
  const claim =
    `在 ${cluster.source} 触发的 ${cluster.kind} 失效形态「${slugBase}」上，` +
    `事件库已累计 ${cluster.recurrence} 次（跨度 ${span}，错误码 ${cluster.codes.length > 0 ? cluster.codes.join('/') : '无'}）。` +
    `断言：若在触发该形态之前先跑一遍「${guard.key}」的前置判据（命中即阻断），则此后同一失效不再进入执行路径；` +
    `证伪方式：判据登记后该 fingerprint 的 recurrence 不再增长 —— 只要还在增长，本断言即被推翻，须重写判据或撤回本条。`

  const fmLines = [
    '---',
    `type: ${type}`,
    'status: proposed',
    `scope: ${scope}`,
    `claim: ${q(claim)}`,
    'guard_ref: null',
    `recurrence: ${cluster.recurrence}`,
    'last_verified_at: null',
  ]
  if (date) fmLines.push(`date: ${q(date)}`)
  if (tags.length > 0) fmLines.push(`tags: [${tags.map(q).join(', ')}]`)
  fmLines.push('category: "失效模式蒸馏草案"')
  fmLines.push('---')

  const body = [
    `# 草案 · ${slugBase}（${cluster.kind} · 累计 ${cluster.recurrence} 次）`,
    '',
    '> **这是提案，不是条目。** 本文件落在 `storage.proposals_dir`（本地 gitignored 暂存区），',
    '> 提案器全程不写正式区（`config.storage.entries_dir`）；是否晋升为正式条目、晋升为哪个 ID，由人工逐条批准。',
    '',
    '## 三要素',
    '',
    `1. **claim（可证伪断言）**：${claim}`,
    `2. **scope**：\`${scope}\` —— 归域依据：${scopeBasis}；域错了不影响断言成立与否，只影响提案落到哪一栏`,
    '3. **守卫绑定建议**：见下节（候选 guard_ref + 可执行判定思路）',
    '',
    '## 守卫绑定建议',
    '',
    ...guard.lines,
    '',
    '## 触发事实（事件聚类）',
    '',
    `- 簇成员 fingerprint：${members.map((m) => `\`${m.fingerprint}\``).join('、')}`,
    `- kind / source：\`${cluster.kind}\` / \`${cluster.source}\``,
    `- recurrence（该 fingerprint 累计次数）：**${cluster.recurrence}**`,
    `- 首次 / 末次：${firstTs || '（缺）'} / ${lastTs || '（缺）'}`,
    `- 错误码集合：${cluster.codes.length > 0 ? cluster.codes.map((c) => `\`${c}\``).join('、') : '（无）'}`,
    `- 来源事件：${(() => {
      const ids = [...new Set(members.flatMap((s) => (Array.isArray(s.members) ? s.members : []).map((e) => e && e.id).filter(Boolean)))].sort()
      return ids.length > 0 ? ids.map((i) => `\`${i}\``).join('、') : '（无 · 事件库早于 provenance 落盘，属存量）'
    })()}`,
    `- 采集口（learned_via）：${(() => {
      const cols = [...new Set(members.flatMap((s) => (Array.isArray(s.members) ? s.members : []).map((e) => e && e.provenance && e.provenance.collected_by).filter(Boolean)))].sort()
      return cols.length > 0 ? cols.map((c) => `\`${c}\``).join('、') : '（无）'
    })()}`,
    '',
    '### 触发样本（供人工判读与守卫破坏测试直接复用）',
    '',
    ...members.map((m, i) => `${i + 1}. \`${m.fingerprint}\` · ${m.recurrence} 次\n   > ${sampleOf(m.members[0]) || '（payload.message 为空）'}`),
    '',
    '## 人工评审清单（逐条勾选后才有资格晋升）',
    '',
    '- [ ] claim 里的根因与前置动作属实（事件统计不等于根因，根因要人来判）',
    '- [ ] scope 归域正确',
    '- [ ] 守卫判据可执行，且破坏测试「注入违规样本必须变红」已实测',
    `- [ ] 已在 registry 登记守卫 key \`${guard.key}\`（未登记前 \`guard_ref\` 保持 null）`,
    '- [ ] 决定晋升为正式条目（并分配 `LRN|ERR-FEAT-YYYYMMDD-NNN` ID）或丢弃',
    '',
  ]

  // provenance：这份草案是从**哪些事件**、经**哪些采集口**学来的（拍2 归因 / 拍4 绑定的账）。
  // `collectors` 收去重后的采集口（hook:PostToolUseFailure 之类），`eventIds` 收全部来源事件 ID ——
  // 二者合起来才能回答「这条知识凭什么存在」，否则草案正文里的 recurrence 是个无源数字。
  const evs = cluster.members.flatMap((s) => (Array.isArray(s.members) ? s.members : []))
  const eventIds = [...new Set(evs.map((e) => (e && typeof e.id === 'string' ? e.id : null)).filter(Boolean))].sort()
  const collectors = [...new Set(evs.map((e) => (e && e.provenance && typeof e.provenance.collected_by === 'string' ? e.provenance.collected_by : null)).filter(Boolean))].sort()

  return { fileName, text: `${fmLines.join('\n')}\n${body.join('\n')}`, guardKey: guard.key, type, scope, recurrence: cluster.recurrence, claim, eventIds, collectors }
}

// ===== 五、陈旧清扫 =====

/** 现命名：`PROP-<cluster16>-<slug>.md`（一簇一文件，cid 是稳定标识）。 */
const NEW_PROP_RE = /^PROP-([0-9a-f]{16})-.+\.md$/
/** 旧命名：`PROP-<evtset8>-<cluster16>-<slug>.md`（文件名带集指纹 → 每次蒸馏新开一份 = 重复的来源）。 */
const LEGACY_PROP_RE = /^PROP-[0-9a-f]{8}-([0-9a-f]{16})-.+\.md$/

/**
 * 陈旧清扫：proposals 目录里 cid 不在本轮存活簇集合内的草案一律删（`--dry-run` 只报不删）。
 *
 * 删的是**重复副本与失效簇的草稿**，不留历史：proposals_dir 是 gitignored 暂存区，
 * approve.mjs 只「读单个文件 → 人工消费」，全程不写回不删不改（旧副本零消费者）；
 * 晋升后的权威记录在 `.learnings/` 条目 + registry。留着只淹没人工评审面。
 *
 * 旧命名的文件一并删（reason=legacy-naming）：它们就是集指纹错配造出来的那批同簇重复，
 * 新命名已由本轮写入的同名文件取代；不清扫的话 434 份 → 22 份的收敛永远做不出来。
 * 非 `PROP-*.md` 形态的文件（README / 人工手记）一律不碰。
 *
 * 全程 0 子进程：readdirSync + unlinkSync。
 * @param {string} proposalsDir
 * @param {Set<string>|string[]} liveCids 本轮存活簇的 clusterId 集合
 * @param {{dryRun?: boolean}} opts
 * @returns {object[]} 被清扫的草案清单（dry-run 时为「将要被清扫」的清单）
 */
export function sweepStaleProposals(proposalsDir, liveCids, { dryRun = false } = {}) {
  if (!existsSync(proposalsDir)) return []
  let names = []
  try {
    names = readdirSync(proposalsDir)
  } catch (e) {
    console.error(`[distill] 提案目录读不出，跳过陈旧清扫: ${e.message}`)
    return []
  }
  const live = liveCids instanceof Set ? liveCids : new Set(liveCids)
  const swept = []
  for (const name of names.sort()) {
    const legacy = LEGACY_PROP_RE.exec(name)
    const match = legacy || NEW_PROP_RE.exec(name)
    if (!match) continue
    const cid = match[1]
    // 旧命名一律清（同簇重复）；现命名只在簇已消失时清。
    if (!legacy && live.has(cid)) continue
    const target = path.join(proposalsDir, name)
    if (!dryRun) {
      try {
        unlinkSync(target)
      } catch (e) {
        console.error(`[distill] 陈旧草案删除失败（跳过）: ${name} — ${e.message}`)
        continue
      }
    }
    swept.push({
      file: target,
      fileName: name,
      cid,
      reason: legacy ? 'legacy-naming' : 'cluster-gone',
      action: dryRun ? 'stale-dry-run' : 'stale-removed',
    })
  }
  return swept
}

// ===== 六、主流程 =====

/**
 * 蒸馏主流程（导出供测试与接线层复用）。
 * @returns {{ proposals: object[], setFingerprint: string, eventsRead: number, skipped: number }}
 */
export function distill({ config, baseDir, fromDir = null, toDir = null, scopeOverride = null, minCount = 1, sweep = null, dryRun = false }) {
  const eventsDir = fromDir ? path.resolve(fromDir) : path.resolve(baseDir, config.storage.events_dir)
  const proposalsDir = toDir ? path.resolve(toDir) : path.resolve(baseDir, config.storage.proposals_dir)
  const hits = readEvents(eventsDir)
  const allClusters = buildClusters(hits)
  const clusters = allClusters.filter((c) => c.recurrence >= minCount)
  // 存活集合按**未过滤**的全量簇算：--min-count 只是降噪输出开关，不得顺手删掉低频簇的旧草案。
  const liveCids = new Set(allClusters.map((c) => clusterId(c)))
  // 清扫的**来源一致性**闸（2026-10-17 主代理复核补洞）：
  // 存活集合是「本轮读到的事件」推出来的，所以它只在「读的就是配置里那个事件目录、
  // 写的也是配置里那个提案目录」时才配得上解释这个提案目录。
  // 一旦 `--from` / `--to` 指向别处（例如拿别的事件集做一次性试算），存活集合来自 A 宇宙、
  // 被扫的却是 B 宇宙 → **会把真实草案全删光**，而空集安全阀挡不住这种情况
  // （A 宇宙非空、B 宇宙全被判为陈旧）。批量删文件正是本仓 ERR-20261017-002 点名的反模式，
  // 所以默认不做，要做必须显式 `--sweep`。
  const sourceMismatch = fromDir !== null || toDir !== null
  const sweepEnabled = sweep === null ? !sourceMismatch : sweep === true
  const sweepSkipReason = sourceMismatch && sweep !== true
    ? `--from/--to 改变了事件源或落位，存活集合与提案目录不属于同一宇宙，拒绝清扫（要扫请显式 --sweep）`
    : null
  const setFp = eventSetFingerprint(hits)
  const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
  const out = []

  const scopeValues = config.scope.values
  const explicitScopes = Array.isArray(scopeOverride) && scopeOverride.length > 0 ? scopeOverride : null

  clusters.forEach((cluster) => {
    // ===== scope 解析：显式参数 > 事件文本命中 > 条目语料投票（须过置信门槛）> config.scope.default =====
    // 每一级都判不出可信域时落默认桶并**明说「未归类」**：宁可交人工归域，也不编一个看着像的域。
    let scope = config.scope.default
    let scopeBasis = `未归类（无归域证据，落默认桶 \`${config.scope.default}\` 等人工归域）`
    if (explicitScopes) {
      scope = explicitScopes[0]
      scopeBasis = `显式 --scope 参数（人工指定，最高优先）`
    } else {
      const text = [cluster.kind, cluster.source, ...cluster.codes, ...cluster.tokens, sampleOf(cluster.members[0].members[0])].join(' ')
      const textVotes = scopeHitsInText(text, scopeValues.filter((v) => v !== config.scope.default))
      const textHit = scopeFromVotes(textVotes)
      const corpusHit = scopeFromVotes(scopeVotesFromEntries(entriesDir, config, cluster.tokens))
      if (textHit !== null) {
        scope = textHit
        scopeBasis = `事件文本直接出现域名 \`${textHit}\``
      } else if (corpusHit !== null) {
        scope = corpusHit
        scopeBasis = `条目语料 IDF 加权投票（≥${MIN_COOCCURRENCE} 词共现 + 置信门槛）落到 \`${corpusHit}\``
      } else {
        scopeBasis = `未归类：事件文本无域名，条目语料投票未过置信门槛（证据弱或势均力敌），落默认桶 \`${config.scope.default}\``
      }
    }

    const proposal = renderProposal({ cluster, scope, scopeBasis, config })

    // ===== 自校验：草案必须当场过 validateEntry —— 提案器的第一职责就是「不产出非法条目」=====
    const { fm, error } = extractFrontmatter(proposal.text)
    const violations = error ? [error] : validateEntry(fm, config.scope.values, proposal.text)
    if (violations.length > 0) {
      throw new Error(`草案 ${proposal.fileName} 未过 validateEntry: ${violations.join('; ')}`)
    }

    const target = path.join(proposalsDir, proposal.fileName)
    let action = 'written'
    if (dryRun) {
      action = 'dry-run'
    } else if (existsSync(target) && readFileSync(target, 'utf8') === proposal.text) {
      action = 'unchanged' // 幂等：内容逐字节相同 → 不重写（mtime 也不动）
    } else {
      mkdirSync(proposalsDir, { recursive: true })
      atomicWrite(target, proposal.text, 'utf8') // 原子写：并发 distill 写同名提案时不会留半截文件（票 H2）
    }
    out.push({ file: target, fileName: proposal.fileName, action, ...proposal, text: undefined })
  })

  // ===== 陈旧清扫：本轮全部簇写完后跑一次，目录收敛到「一簇一份」=====
  // 安全阀 1：本轮一个簇都没成（空事件库 / 事件目录不存在）→ 不动目录（沿用「空库零副作用」契约）。
  // 安全阀 2：--from/--to 造成来源与落位不同源 → 不动目录（见上面 sweepSkipReason 的理由）。
  const stale =
    allClusters.length === 0 || !sweepEnabled ? [] : sweepStaleProposals(proposalsDir, liveCids, { dryRun })

  return {
    proposals: out,
    stale,
    sweepSkipped: sweepSkipReason,
    setFingerprint: setFp,
    eventsRead: hits.length,
    skipped: hits.length - clusters.length,
  }
}

export function main(argv) {
  // ===== 1. 参数（纯调用方错误 → exit 2，先于任何 kill-switch 判定）=====
  let cliConfig = null
  let projectDir = process.cwd()
  let fromDir = null
  let toDir = null
  let scopeArg = null
  let minCount = 1
  let dryRun = false
  let wantJson = false
  let sweep = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run' || a === '--json') {
      if (a === '--json') wantJson = true
      else dryRun = true
      continue
    }
    if (a === '--sweep') {
      sweep = true
      continue
    }
    if (!['--config', '--project-dir', '--from', '--to', '--scope', '--min-count'].includes(a)) return usage(`未知参数 ${a}`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) return usage(`${a} 后须跟值`)
    i++
    if (a === '--config') cliConfig = path.resolve(next)
    else if (a === '--project-dir') projectDir = path.resolve(next)
    else if (a === '--from') fromDir = path.resolve(next)
    else if (a === '--to') toDir = path.resolve(next)
    else if (a === '--scope') scopeArg = next
    else {
      minCount = Number.parseInt(next, 10)
      if (!Number.isInteger(minCount) || minCount < 0) return usage('--min-count 须为 ≥0 整数')
    }
  }
  const scopeOverride = scopeArg ? scopeArg.split(',').map((s) => s.trim()).filter(Boolean) : null

  // ===== 2. 配置链（与 inject/capture 同一份 loadContext；失败 fail-open）=====
  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    return failOpen(e, (e && e.config) || null, (e && e.baseDir) || null, 'distill')
  }

  // ===== 3. 显式 scope 取值校验（需 config.scope.values；调用方错误 → exit 2）=====
  if (scopeOverride) {
    const bad = scopeOverride.filter((s) => !config.scope.values.includes(s))
    if (bad.length > 0) return usage(`--scope 取值非法: ${bad.join(', ')}（合法值: ${config.scope.values.join(', ')}）`)
  }

  // ===== 4. kill-switch off：零写盘、零提案（先于 mkdir，绝不产生副作用）=====
  if (config.kill_switch.distill !== true) {
    console.error('[distill] kill_switch.distill=false，不产草案、不写盘（零副作用）')
    return 0
  }

  // ===== 5. 主流程（内部异常 fail-open：不写草案 + 审计 + exit 0）=====
  try {
    const result = distill({ config, baseDir, fromDir, toDir, scopeOverride, minCount, sweep, dryRun })
    const auditRecords = result.proposals.map((p) => ({
      action: p.action === 'unchanged' ? 'proposal-unchanged' : 'proposal-written',
      learned_via: 'distill',
      file: p.fileName,
      scope: p.scope,
      recurrence: p.recurrence,
      guard_ref_candidate: p.guardKey,
      // provenance：草案 ↔ 来源事件 ↔ 采集口三向可追。`source_events` 长度 = 该草案吃进去几个归并事件
      source_events: Array.isArray(p.eventIds) ? p.eventIds : [],
      collectors: Array.isArray(p.collectors) ? p.collectors : [],
    }))
    const staleAudit = result.stale.map((s) => ({
      action: s.action === 'stale-dry-run' ? 'proposal-stale-dry-run' : 'proposal-stale-removed',
      learned_via: 'distill',
      file: s.fileName,
      scope: null,
      recurrence: null,
      guard_ref_candidate: null,
      source_events: [],
      collectors: [],
      cluster_id: s.cid,
      reason: s.reason,
    }))
    if (auditRecords.length + staleAudit.length > 0) flushAudit(config, baseDir, [...auditRecords, ...staleAudit])

    for (const p of result.proposals) {
      console.error(`[distill] ${p.action} ${p.fileName} · ${p.type}/proposed · scope=${p.scope} · recurrence=${p.recurrence} · guard 候选 ${p.guardKey}`)
    }
    for (const s of result.stale) {
      console.error(`[distill] ${s.action} ${s.fileName} · cid=${s.cid} · ${s.reason === 'legacy-naming' ? '旧命名（同簇重复）' : '簇已不存在'}`)
    }
    if (result.proposals.length === 0) {
      console.error(`[distill] 0 个草案（事件 ${result.eventsRead} 条 / 命中 ${result.skipped === 0 ? '全部被 min-count 过滤' : `${result.skipped} 条低于 --min-count`}）`)
    } else {
      console.error(`[distill] 草案 ${result.proposals.length} 份 · 事件集指纹 ${result.setFingerprint} · 落位 ${toDir ? path.resolve(toDir) : config.storage.proposals_dir}（正式区零写入）`)
    }
    if (result.stale.length > 0) {
      console.error(`[distill] 陈旧清扫 ${result.stale.length} 份（${dryRun ? '--dry-run 只报不删' : '已删除'}）`)
    }
    if (result.sweepSkipped) console.error(`[distill] 陈旧清扫已跳过：${result.sweepSkipped}`)
    if (wantJson) process.stdout.write(`${JSON.stringify({ set_fingerprint: result.setFingerprint, events_read: result.eventsRead, proposals: result.proposals, stale: result.stale, sweep_skipped: result.sweepSkipped }, null, 2)}\n`)
    return 0
  } catch (e) {
    return failOpen(e, config, baseDir, 'distill')
  }
}

// 仅当被直接执行时运行 CLI（导出供测试 / 接线层复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
