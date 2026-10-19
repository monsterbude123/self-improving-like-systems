#!/usr/bin/env node
/**
 * approve.mjs —— 批准落盘 + 守卫注册（通用技能，零项目耦合，宿主可跑）
 *
 * 角色：蒸馏草案（`config.storage.proposals_dir`）经**人工逐条裁决**后的落地位。
 *   --approve：草案 → 正式条目（`config.storage.entries_dir`，文件名 `<ID>-<slug>.md`）+
 *              守卫登记（registry 的 dispatch 三键 + Guard 实体字段）；
 *   --reject ：**零变更**（正式区与 registry 一个字节都不动，只有审计留痕），可 git 级证明。
 *
 * 用法：
 *   node approve.mjs --proposal <草案文件> --approve --id <LRN|ERR|FEAT-YYYYMMDD-NNN>
 *                    [--guard-script <守卫脚本路径>] [--guard-key <key>] [--pattern <正则>]
 *                    [--when <plan 字段谓词>] [--shadow-runs <n>] [--reason <说明>]
 *                    [--config <p>] [--project-dir <d>] [--dry-run] [--json]
 *   node approve.mjs --proposal <草案文件> --reject [--reason <说明>] [--config <p>]
 *
 * 退出码：0 = 落盘完成（或拒绝留痕完成） / 1 = 校验不通过或目标已存在（零变更） / 2 = 用法错误
 *
 * ===== 单一归宿纪律 =====
 *   条目字段判据**不发明第二套**：草案与落盘条目都过 `validate.mjs` 的 `validateEntry`；
 *   registry 条目过同一文件的 `validateRegistryEntry`。三处都是「解析→校验→写盘」，
 *   校验不通过则**一个字节都不写**（先在内存里组装 + 解析回验，最后一步才落盘）。
 *
 * ===== registry 写法（注释保全）=====
 *   YAML 无 js-yaml 的 dump 可用（宿主钩子路径），而 registry 是带大量解释性注释的入仓文件，
 *   整体重新序列化会把手写注释全部抹掉。故采用**文本追加**：新条目按块序列形态追加到 guards 末尾，
 *   追加后在内存里整表解析回验（结构 + 每条 validateRegistryEntry）通过才落盘。
 *   同 key 已存在 → **不产生第二条登记**，但会把本条目并入该守卫的 covered_entries（重复并入幂等）。
 *
 * ===== 拦截权 =====
 *   登记 ≠ 拦截。登记时 `mode: shadow` + `shadow_required`，计数与升级由 `run-guard.mjs` 裁决
 *   （前 N 次 warn-only，全绿自动升 blocking）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadContext, flushAudit } from './inject.mjs'
import { atomicWrite } from './lib/atomic-file.mjs'
import { createLogger } from './lib/log.mjs'
import { extractFrontmatter, validateEntry, validateRegistryEntry, EVENT_ID_RE as VALIDATE_EVENT_ID_RE } from './validate.mjs'
import { parseYaml } from './lib/yaml-lite.mjs'
import { loadRegistry, readGuardState, writeGuardState, guardStatePath, withStateLock, DEFAULT_SHADOW_RUNS } from './run-guard.mjs'

/** 条目 ID 形态（与项目命名门禁同款形态；唯一性归命名门禁，本文件只管形态）。 */
const ENTRY_ID_RE = /^(?:LRN|ERR|FEAT)-\d{8}-\d{3}$/
/** registry key 形态 = guard_ref 形态（小写连字符），与 validate.mjs 同款。 */
const GUARD_KEY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/**
 * 默认触发注解：`when` 是**声明性注解**（记录该守卫在宿主钩子路由里的触发面，供人读），
 * **派发器不求值**（schema.md §3 三条理由）。
 *
 * 2026-10-16 · 架构审计 F5 补漏：此处此前写死本仓宿主 `classifyStaged` 的字段名
 * `touchesExperienceSystem`。该字段是**宿主自有**的（各仓触发面判据不同），通用技能
 * 写死它等于「第二个项目注册守卫时，registry 里就带上了上一个项目的字段名」——
 * 与 schema.md §3 理由②「零项目耦合」自相矛盾，也正是「技能目录不含项目物」
 * 守卫（lifecycle.test.mjs 对 verify.mjs 的 banned 名单里就有它）要拦的形态。
 * 改为中性措辞 + 在接线提示里要求项目方替换成自己的 plan 字段。
 */
const DEFAULT_WHEN = 'host-hook-route-field'
/** 本脚本目录（派发器与批准器同目录 → registry 的 args 直调同目录的 run-guard.mjs）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 正则元字符转义（草案 token 是自然语言词，直接当正则可能因 `-` / `.` 误匹配）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 共现窗口（字符数）：两个抓手必须靠得够近才算"同一个失效形态"。 */
const CO_WINDOW = 200

/**
 * 草案 salient token → 守卫判据正则。
 *
 * **为什么不是裸 alternation**（`test|vitest|worker` 这种）：单个抓手词在仓内到处都是，
 * 裸 alternation 会让守卫命中一切 —— 它在 shadow 期只警告不阻断（所以不会伤到人），
 * 但也**永远攒不满 3 次绿**，于是这条守卫就永久停在 warn-only，白登记。
 * 所以默认用**两两共现**（同窗口内出现任意两个抓手才算命中）：既保留可执行性，
 * 又把误报压到可被 shadow 期消化掉的量级。抓不准时用 `--pattern` 人工接管。
 */
export function renderPattern(tokens) {
  const t = tokens.map(escapeRe)
  if (t.length === 0) return null
  if (t.length === 1) return t[0]
  const alts = []
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      alts.push(`${t[i]}.{0,${CO_WINDOW}}${t[j]}`, `${t[j]}.{0,${CO_WINDOW}}${t[i]}`)
    }
  }
  return [...new Set(alts)].join('|')
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node approve.mjs --proposal <草案> --approve --id <LRN|ERR|FEAT-YYYYMMDD-NNN> --guard-script <守卫脚本路径>
                   [--guard-key <key>] [--pattern <正则>] [--when <谓词>] [--shadow-runs <n>] [--dry-run] [--json]
  node approve.mjs --proposal <草案> --reject [--reason <说明>]
  退出码：0=完成 / 1=校验不通过或目标已存在（零变更） / 2=用法错误`)
  return 2
}

/** 双引号标量（JSON 字符串是 YAML 双引号标量的合法子集）。 */
const q = (s) => JSON.stringify(String(s))
/** 简单标识符形态的标量不必加引号（可读性优先；其余一律双引号，避免 `||` / 冒号等破坏解析）。 */
const scalar = (s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(s)) ? String(s) : q(s))
const toPosix = (p) => p.split(path.sep).join('/')

/**
 * 草案文件名 → 条目 slug（去掉提案专用前缀）。
 * 现命名 `PROP-<cluster>-<slug>.md` 去掉两段；旧命名 `PROP-<setfp>-<cluster>-<slug>.md` 去掉三段
 * （distill.mjs 已去掉集指纹段；旧命名仍可能被人手挑出来消费，故保留兼容分支）。
 */
export function slugFromProposalName(fileName) {
  const base = String(fileName).replace(/\.md$/, '')
  const parts = base.split('-')
  const legacy = /^PROP-[0-9a-zA-Z]{8}-[0-9a-f]{16}-/.test(base)
  const slug = parts.slice(legacy ? 3 : 2).join('-')
  return slug !== '' ? slug : 'entry'
}

/** 草案正文里的守卫候选 key（`候选 guard_ref：**`key`**`），供人工不显式指定时兜底。 */
export function guardKeyFromProposal(text) {
  const m = /\*\*`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`\*\*/.exec(text)
  return m ? m[1] : null
}

/** 草案正文里的判据抓手 token（`本簇 salient token = a / b / c；`），供生成守卫骨架。 */
export function tokensFromProposal(text) {
  const m = /salient token = ([^；\n]+)/.exec(text)
  if (!m) return []
  return m[1]
    .split('/')
    .map((t) => t.trim())
    .filter((t) => t !== '' && !/^（.*）$/.test(t))
}

/**
 * 生成守卫骨架（shell + 单次 awk/grep，O(1) spawn）。
 * 契约：0 = 通过 / 2 = 命中判据（阻断） / 其他 = 内部异常（派发层 fail-open 不阻塞）。
 * 判据抓手来自草案的 salient token —— 生成即可跑（可立刻做破坏测试），但**必须人工复核**：
 * token 抓得太宽会误拦（全被 shadow 期拦下，不会误伤提交），抓得太窄则拦不住（破坏测试不变红）。
 */
export function renderGuardTemplate({ key, pattern, entryId, proposalName, tokens }) {
  return `#!/usr/bin/env bash
# ${key} —— 经验系统守卫（approve.mjs 由草案 ${proposalName} 生成，绑定条目 ${entryId}）
#
# 退出码契约（run-guard.mjs 依赖，不可改）：
#   0 = 放行 / 2 = 命中判据（阻断提交）/ 其他 = 守卫自身异常 → 派发层 fail-open 只记审计不阻塞
# 判据抓手（来源 = 草案「命中判据的抓手」）：${tokens.length > 0 ? tokens.join(' / ') : '（草案无 token，由 --pattern 指定）'}
#   ⚠️ 人工复核点：抓得太宽会误拦（shadow 期只警告不阻断，抓够 3 次绿才会真拦），
#      抓得太窄则拦不住 —— 改完必须重跑破坏测试：喂违规样本应变红、喂正常样本应保持绿。
#
# 输入：默认读暂存区 diff（提交那一刻的判据面）；派发层带 --input-stdin 时改读 stdin。
# 性能：两次 spawn（git + grep）读完判据输入，**不按文件起子进程**（O(1) spawn 纪律）。
set -uo pipefail
KEY='${key}'
PATTERN='${pattern.replace(/'/g, "'\\''")}'

if [ "\${1:-}" = '--input-stdin' ]; then
  INPUT="$(cat)"
else
  INPUT="$(git diff --cached --diff-filter=ACMR -- . 2>/dev/null)"
fi

if printf '%s' "$INPUT" | grep -Eq "$PATTERN"; then
  echo "FAIL [$KEY]: 暂存改动命中已登记失效形态（判据: $PATTERN）"
  exit 2
fi
echo "PASS [$KEY]: 未命中判据（$PATTERN）"
exit 0
`
}

/** 拆出 frontmatter 结束行之后的正文（复用 extractFrontmatter 的判定口径：第二个独立 `---` 行）。 */
function splitAfterFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return lines.slice(i + 1).join('\n').replace(/^\n+/, '')
  }
  return ''
}

/**
 * 正文里若带草案的定性抬头（`> **这是提案，不是条目。**` 起头的引用段），整段摘掉。
 * 摘的是**定性**，不是**证据**：草案正文里的触发样本 / 统计事实全部原样留存
 * —— 没有样本的经验只剩一句断言，对账时没人能回溯它凭什么成立。
 */
function stripProposalBanner(body) {
  const lines = String(body).split('\n')
  const start = lines.findIndex((l) => l.trimStart().startsWith('>') && l.includes('这是提案'))
  if (start < 0) return body
  let end = start
  while (end < lines.length && lines[end].trimStart().startsWith('>')) end++
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n')
}

/** 来源事件 ID 的形态判据（拍1 关联的唯一入口守卫）—— 与 validate.mjs 共用同一个常量，不写第二份。 */
const EVENT_ID_RE = VALIDATE_EVENT_ID_RE

/**
 * 从草案正文抽出来源事件 ID（distill.mjs 写的 `- 来源事件：\`evt-…\`、\`evt-…\``）。
 *
 * **为什么是「条目 → 事件」这个方向**（拍1 此前恒 ✗ 的根因）：事件是只增不改的纯事实账
 * （stoploss.md §2），往事件上回写 `entry_id` 等于让一次蒸馏裁决篡改证据；条目是裁决后的产物，
 * 由它声明「我学自哪些事件」是本职。因此事件侧的 `entry_id` 恒 null，**判据取条目侧的 `event_ids`**。
 *
 * 只认 `evt-YYYYMMDD-NNN`，避免草案正文里随口提到的其它 ID 混进账里。抽不到就返回空数组 ——
 * `event_ids` 是可选键（validate.mjs `OPTIONAL_ENTRY_KEYS`），存量草案缺它不算违规。
 */
export function sourceEventIdsOf(proposalText) {
  const body = splitAfterFrontmatter(proposalText)
  const line = body.split('\n').find((l) => l.trimStart().startsWith('- 来源事件'))
  if (!line) return []
  const ids = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => EVENT_ID_RE.test(s))
  return [...new Set(ids)].sort()
}

/**
 * 草案 → 正式条目文本。
 * frontmatter：status 提案态 → resolved、guard_ref null → 真 key（recurrence/claim/scope 原样继承，不改写断言）。
 * 正文：**草案正文原样留存**（触发样本是这条经验的可追溯证据，丢掉就只剩一句断言），
 *   前面加批准抬头（推翻草案里"这是提案"那句），后面追加批准记录。
 */
export function renderEntry({ fm, id, guardKey, proposalName, proposalText, today, reason = null, shadowRuns = DEFAULT_SHADOW_RUNS }) {
  const lines = [
    '---',
    `type: ${fm.type}`,
    'status: resolved',
    `scope: ${fm.scope}`,
    `claim: ${q(fm.claim)}`,
    `guard_ref: ${guardKey}`,
    `recurrence: ${Number.isInteger(fm.recurrence) ? fm.recurrence : 0}`,
    'last_verified_at: null',
  ]
  if (fm.tags) lines.push(`tags: ${JSON.stringify(fm.tags)}`)
  if (fm.date) lines.push(`date: ${q(fm.date)}`)
  if (fm.category) lines.push(`category: ${q(fm.category)}`)
  if (fm.resolved_date) lines.push(`resolved_date: ${q(fm.resolved_date)}`)
  if (fm.resolved_by) lines.push(`resolved_by: ${q(fm.resolved_by)}`)
  // 拍1 关联真正接线的地方。草案里记的来源事件搬进 frontmatter，条目从此可被 trace 回溯到
  // 「凭哪几条事实学来」；没有这条链，六拍链的第一环永远红，trace 永远判冻结。
  const sourceEvents = sourceEventIdsOf(proposalText)
  if (sourceEvents.length > 0) lines.push(`event_ids: ${JSON.stringify(sourceEvents)}`)
  lines.push('---')
  const keptBody = stripProposalBanner(splitAfterFrontmatter(proposalText)).trimEnd()
  return `${lines.join('\n')}\n${renderBanner({ guardKey, proposalName, today, shadowRuns, reason })}\n\n${keptBody}\n${approvalRecord({ id, guardKey, proposalName, today, shadowRuns })}`
}

/** 批准抬头：作废草案抬头里"这是提案"的定性，同时写清拦截权是挣来的。 */
function renderBanner({ guardKey, proposalName, today, shadowRuns, reason }) {
  return `> **本条目已批准落盘**（approve.mjs · 原草案 \`${proposalName}\` · 批准日期 ${today}）。
> 守卫 \`${guardKey}\` 已登记入 registry，本失效形态自此在本仓有可执行判据。
> **拦截权不是注册即得**：新守卫前 ${shadowRuns} 次为 warn-only shadow 运行，全绿才自动升 blocking
> （计数与升级由 run-guard.mjs 裁决，契约见 references/schema.md §3）；守卫自身异常 fail-open，只记审计不阻塞。${reason ? `\n> 批准说明：${reason}` : ''}
>
> 以下为**原草案正文原文留存**（触发样本是该条经验的可追溯证据；其中"候选 guard_ref / 未登记"的表述是草案当时的状态，以本抬头与下方批准记录为准）。`
}

/** 批准记录：谁批的、批了什么、守卫怎么挣的拦截权、记账口径在哪。 */
function approvalRecord({ id, guardKey, proposalName, today, shadowRuns }) {
  return `
## 批准记录

- 条目 ID：\`${id}\` · 批准日期：${today} · 草案来源：\`${proposalName}\`
- 守卫登记：registry 条目 \`${guardKey}\`（dispatch 三键 + Guard 实体字段；\`mode: shadow\`、\`shadow_required: ${shadowRuns}\`）
- 拦截权：shadow 期内命中只警告不阻断；\`shadow_runs ≥ ${shadowRuns} && shadow_green === shadow_runs\` 才自动升 blocking
- 记账口径：blocking 期每次命中判据 → 本条目 \`recurrence\` +1 且刷新 \`last_verified_at\`（六拍命中 +1）
- 人工改判据的正确姿势：改守卫脚本本身，然后 \`node run-guard.mjs --key ${guardKey}\` 复跑；
  不要手改 \`recurrence\`（那是对账事实，不是记账结果）
`
}

/**
 * 把一个条目 ID 并入**已存在**守卫的 `covered_entries`（幂等，保全注释）。
 *
 * 2026-10-17 修（真实缺陷，非用法问题）：同 key 已存在时 approve 原先整段跳过 registry 写入，
 * 于是「第二个条目绑定到一个共享守卫」永远不会被写进该守卫的 covered_entries，
 * 而 trace 拍3 正是按 covered_entries 判的 —— 结果是**六拍对同守卫的第二个条目不可完成**。
 * 第一次绑定看不出来（它自己创建了 key 并写进了 covered_entries），第二次才暴露。
 *
 * 只在那一行的 `[...]` 里插入，不重排整表：registry 里每条守卫都带中文出处注释，
 * 任何整表重写都会毁掉它们（appendRegistryEntry 走的是纯追加，正是为此）。
 */
export function addEntryToCoverage(rawText, guardKey, id) {
  const keyLine = new RegExp(`^(\\s*-\\s*key:\\s*["']?)${escapeRe(guardKey)}(["']?)\\s*$`, 'm')
  const keyMatch = keyLine.exec(rawText)
  if (!keyMatch) return rawText // 找不到该 key → 原样返回（调用方随后会被回验拦下）
  const after = rawText.slice(keyMatch.index + keyMatch[0].length)
  // 搜索范围**必须截到本守卫块尾**（下一个 `- key:`）。否则本守卫缺 covered_entries 时，
  // 会命中下一个守卫的那行，把条目并到错守卫上——比不写更糟（静默错账）。
  const nextKey = /^[ \t]*-[ \t]+key:/m.exec(after)
  const block = nextKey ? after.slice(0, nextKey.index) : after
  const covMatch = /^[ \t]*covered_entries:[ \t]*\[([^\]]*)\][ \t]*$/m.exec(block)
  if (!covMatch) return rawText // 该守卫没有 covered_entries 行 → 不擅自造（结构异常应显式报错）
  const current = covMatch[1]
  const already = new RegExp(`(^|[,\\s])["']?${escapeRe(id)}["']?($|[,\\s])`).test(current)
  if (already) return rawText
  const trimmed = current.trim()
  const nextInner = trimmed === '' ? q(id) : `${trimmed}, ${q(id)}`
  const covLine = `${/^[ \t]*/.exec(covMatch[0])[0]}covered_entries: [${nextInner}]`
  const covStart = keyMatch.index + keyMatch[0].length + covMatch.index
  return rawText.slice(0, covStart) + rawText.slice(covStart).replace(covMatch[0], covLine)
}

/** registry 文本追加一段 guards 条目（保全既有注释）；追加后整表回验。 */
export function appendRegistryEntry(rawText, entry) {
  const block = [
    `  - key: ${scalar(entry.key)}`,
    `    args: [${entry.args.map(q).join(', ')}]`,
    `    when: ${scalar(entry.when)}`,
    `    kind: ${entry.kind}`,
    `    path: ${q(entry.path)}`,
    `    command: [${entry.command.map(q).join(', ')}]`,
    `    covered_entries: [${entry.covered_entries.map(q).join(', ')}]`,
    `    mode: ${entry.mode}`,
    `    shadow_required: ${entry.shadow_required}`,
    '',
  ].join('\n')
  const trimmed = rawText.replace(/\s*$/, '')
  const next = `${trimmed}\n${block}`
  // 回验：整表必须仍可解析，且每条都过 validateRegistryEntry（单一归宿，不在落盘处另立判据）。
  const parsed = parseYaml(next)
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.guards)) {
    throw new Error('追加后 registry 解析失败（结构非法）')
  }
  const bad = []
  parsed.guards.forEach((g, i) => {
    for (const v of validateRegistryEntry(g)) bad.push(`guards[${i}] ${g && g.key ? g.key : '?'}: ${v}`)
  })
  if (bad.length > 0) throw new Error(`追加后 registry 条目不合规:\n  ${bad.join('\n  ')}`)
  if (!parsed.guards.some((g) => g && g.key === entry.key)) throw new Error('追加后未在 registry 中读到该 key')
  return { nextText: next, registry: parsed }
}

export function main(argv) {
  let cliConfig = null
  let projectDir = process.cwd()
  let proposalArg = null
  let approve = false
  let reject = false
  let id = null
  let guardScriptArg = null
  let guardKeyArg = null
  let patternArg = null
  let whenArg = null
  let shadowRunsArg = null
  let reason = null
  let dryRun = false
  let wantJson = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--approve') { approve = true; continue }
    if (a === '--reject') { reject = true; continue }
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--json') { wantJson = true; continue }
    if (!['--proposal', '--id', '--guard-script', '--guard-key', '--pattern', '--when', '--shadow-runs', '--reason', '--config', '--project-dir'].includes(a)) {
      return usage(`未知参数 ${a}`)
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) return usage(`${a} 后须跟值`)
    i++
    if (a === '--proposal') proposalArg = path.resolve(next)
    else if (a === '--id') id = next.trim()
    else if (a === '--guard-script') guardScriptArg = next
    else if (a === '--guard-key') guardKeyArg = next.trim()
    else if (a === '--pattern') patternArg = next
    else if (a === '--when') whenArg = next.trim()
    else if (a === '--shadow-runs') shadowRunsArg = Number.parseInt(next, 10)
    else if (a === '--reason') reason = next
    else if (a === '--config') cliConfig = path.resolve(next)
    else projectDir = path.resolve(next)
  }

  if (!proposalArg) return usage('--proposal 必填（草案文件路径）')
  if (approve === reject) return usage('--approve 与 --reject 二选一')
  if (reject) {
    if (id || guardScriptArg || guardKeyArg || patternArg || whenArg || shadowRunsArg !== null) {
      return usage('--reject 不接受落盘参数（拒绝路径必须零变更）')
    }
  } else {
    if (!id) return usage('--approve 必填 --id <LRN|ERR|FEAT-YYYYMMDD-NNN>（条目 ID 由人分配，提案器不代签）')
    if (!ENTRY_ID_RE.test(id)) return usage(`--id 形态非法: ${id}（须 LRN|ERR|FEAT-YYYYMMDD-NNN）`)
    if (!guardScriptArg) return usage('--approve 必填 --guard-script <守卫脚本路径>（无守卫 = 无判据的条目 = 愿望不是教训）')
    if (shadowRunsArg !== null && (!Number.isInteger(shadowRunsArg) || shadowRunsArg < 0)) return usage('--shadow-runs 须为 ≥0 整数')
  }

  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    // 与 inject/capture 的 fail-open（exit 0）**刻意不同**：那两条挂生命周期钩子，绝不能把会话搞失败；
    // 批准落盘是**人显式发起的写动作**，静默 exit 0 = 「以为批了其实没批」，故硬失败 exit 1。
    console.error(`FAIL config: 配置链失败 ${e.message}`)
    flushAudit(config, baseDir, [{ tool: 'approve', action: 'config-error', error: e.message }])
    return 1
  }

  if (!existsSync(proposalArg)) {
    console.error(`FAIL: 草案不存在 ${proposalArg}`)
    return 1
  }
  const proposalText = readFileSync(proposalArg, 'utf8')
  const proposalName = path.basename(proposalArg)

  // ===== 拒绝路径：零变更（正式区 / registry / 守卫脚本都不碰），只有审计留痕 =====
  if (reject) {
    console.error(`[approve] rejected ${proposalName}${reason ? ` · 理由: ${reason}` : ''}（正式区与 registry 零变更）`)
    flushAudit(config, baseDir, [{ tool: 'approve', action: 'proposal-rejected', proposal: proposalName, reason }])
    if (wantJson) process.stdout.write(`${JSON.stringify({ decision: 'reject', proposal: proposalName, changed: false }, null, 2)}\n`)
    return 0
  }

  try {
    // ===== 1. 草案自校验（判据单一归宿：validate.mjs 的 extractFrontmatter + validateEntry）=====
    const { fm, error } = extractFrontmatter(proposalText)
    if (error) {
      console.error(`FAIL: 草案 frontmatter 解析失败 ${proposalName}: ${error}`)
      return 1
    }
    const entryViolations = validateEntry(fm, config.scope.values, proposalText)
    if (entryViolations.length > 0) {
      console.error(`FAIL: 草案未过 validateEntry ${proposalName}（零变更）`)
      for (const v of entryViolations) console.error(`  - ${v}`)
      return 1
    }

    // ===== 2. 守卫身份：key / 脚本路径 / 判据抓手 =====
    const guardKey = guardKeyArg ?? guardKeyFromProposal(proposalText)
    if (!guardKey || !GUARD_KEY_RE.test(guardKey)) return usage(`守卫 key 缺失或形态非法: ${guardKey ?? '（草案未给出候选）'}（可显式 --guard-key）`)
    const guardScriptAbs = path.resolve(projectDir, guardScriptArg)
    const guardScriptRel = toPosix(path.relative(baseDir, guardScriptAbs)) || guardScriptArg
    if (guardScriptRel.startsWith('..')) return usage(`--guard-script 必须在仓内（当前解析到仓外: ${guardScriptRel}）`)
    const tokens = tokensFromProposal(proposalText)
    const pattern = patternArg ?? renderPattern(tokens)
    if (!pattern) {
      console.error('FAIL: 判据抓手缺失 —— 草案未给出 salient token 且未传 --pattern。守卫判据只能从草案抓手或人工显式给出，不许留空。')
      return 1
    }

    // ===== 3. 组装（全部先在内存里做完并回验，最后一步才落盘）=====
    const slug = slugFromProposalName(proposalName)
    const entriesDir = path.resolve(baseDir, config.storage.entries_dir)
    const entryFile = path.join(entriesDir, `${id}-${slug}.md`)
    if (existsSync(entryFile)) {
      console.error(`FAIL: 目标条目已存在 ${toPosix(path.relative(baseDir, entryFile))}（零变更；换 ID 或先人工处置）`)
      return 1
    }
    const today = new Date().toISOString().slice(0, 10)
    const shadowRequired = shadowRunsArg ?? DEFAULT_SHADOW_RUNS
    const entryText = renderEntry({ fm, id, guardKey, proposalName, proposalText, today, reason, shadowRuns: shadowRequired })
    // 落盘前再过一次判据（同一份 validateEntry，不发明第二套）
    const { fm: entryFm, error: entryErr } = extractFrontmatter(entryText)
    const entryViolations2 = entryErr ? [entryErr] : validateEntry(entryFm, config.scope.values, entryText)
    if (entryViolations2.length > 0) {
      console.error('FAIL: 组装的条目未过 validateEntry（零变更）')
      for (const v of entryViolations2) console.error(`  - ${v}`)
      return 1
    }
    // id 前缀须与 type 一致（形态纪律；唯一性归项目命名门禁）
    if (!path.basename(entryFile).startsWith(`${entryFm.type}-`)) {
      console.error(`FAIL: 条目 ID 前缀与 type 不一致（type=${entryFm.type} · id=${id}）`)
      return 1
    }

    const { path: registryAbs } = loadRegistry(config, baseDir)
    const registryRaw = readFileSync(registryAbs, 'utf8')
    const existing = parseYaml(registryRaw)
    const alreadyRegistered = Array.isArray(existing?.guards) && existing.guards.some((g) => g && g.key === guardKey)
    const isShell = guardScriptArg.endsWith('.sh')
    // 派发器 argv 的第一段：优先写成**相对 baseDir**的仓内路径（registry 入仓，机器本地绝对路径不该进去）；
    // 技能目录在仓外（测试 fixture / 非常规布局）时退回绝对路径 —— 派发器 cwd 是仓根，两者都能解析。
    const runnerRel = toPosix(path.join(path.relative(baseDir, HERE), 'run-guard.mjs'))
    const runnerArg = runnerRel.startsWith('..') ? toPosix(path.join(HERE, 'run-guard.mjs')) : runnerRel
    const registryEntry = {
      key: guardKey,
      // args = 直调派发形态（不经包管理器 run 层）；真守卫 argv 放实体字段 command。
      args: [runnerArg, '--key', guardKey],
      when: whenArg ?? DEFAULT_WHEN,
      kind: 'gate',
      path: guardScriptRel,
      command: [isShell ? 'bash' : 'node', guardScriptRel],
      covered_entries: [id],
      mode: 'shadow',
      shadow_required: shadowRequired,
    }
    let nextRegistryText = null
    if (!alreadyRegistered) {
      nextRegistryText = appendRegistryEntry(registryRaw, registryEntry).nextText
    } else {
      nextRegistryText = addEntryToCoverage(registryRaw, guardKey, id)
    }

    const guardExists = existsSync(guardScriptAbs)
    const guardText = guardExists ? null : renderGuardTemplate({ key: guardKey, pattern, entryId: id, proposalName, tokens })

    if (dryRun) {
      console.error(`[approve] dry-run：批准 ${proposalName} → ${toPosix(path.relative(baseDir, entryFile))}；守卫 ${guardKey} ${alreadyRegistered ? '（已登记，将并入 covered_entries）' : '将登记'}；${guardExists ? '守卫脚本已存在，不覆盖' : '将生成守卫骨架'}（零写盘）`)
      if (wantJson) process.stdout.write(`${JSON.stringify({ decision: 'approve', dry_run: true, entry: toPosix(path.relative(baseDir, entryFile)), guard_key: guardKey, registry_written: true, registry_key_appended: !alreadyRegistered, guard_script_generated: !guardExists }, null, 2)}\n`)
      return 0
    }

    // ===== 4. 落盘（顺序：守卫骨架 → registry → 条目；每步失败即中止，前面已写的靠 git 回滚）=====
    if (guardText !== null) {
      mkdirSync(path.dirname(guardScriptAbs), { recursive: true })
      atomicWrite(guardScriptAbs, guardText, 'utf8')
      try {
        chmodSync(guardScriptAbs, 0o755)
      } catch {
        /* Windows 无 POSIX 位：不影响，command 走 bash/node 直调 */
      }
    }
    // 原子写（票 H2）：并发 approve 写 registry / 条目时不会留半截文件被读成非法 YAML。
    // 注意 registry 的「读-改-写」仍可能互相覆盖 —— 入仓数据由 git 序列化、人工审 diff 兜底，故不加锁。
    if (nextRegistryText !== null) atomicWrite(registryAbs, nextRegistryText, 'utf8')
    mkdirSync(entriesDir, { recursive: true })
    atomicWrite(entryFile, entryText, 'utf8')

    // ===== 5. shadow 计数从 0 起（挣拦截权从第一跑开始，不是从登记开始）=====
    // 锁内重读再改：与并发派发（run-guard）争同一份账，锁外读-改-写会把对方刚记的计数整段覆盖（票 H2）。
    const statePath = guardStatePath(config, baseDir)
    withStateLock(statePath, () => {
      const { state } = readGuardState(config, baseDir)
      if (state.guards[guardKey]) return // 已在账上：幂等，不重置任何既有计数
      state.guards[guardKey] = { shadow_runs: 0, shadow_green: 0, mode: 'shadow', last_result: 'skipped' }
      writeGuardState(config, baseDir, state)
      return null
    })

    const audit = [{ tool: 'approve', action: 'entry-approved', proposal: proposalName, entry: `${id}-${slug}.md`, guard_ref: guardKey, registry_written: true, registry_key_appended: !alreadyRegistered, guard_script_generated: guardText !== null }]
    flushAudit(config, baseDir, audit)
    console.error(`[approve] approved ${proposalName} → ${toPosix(path.relative(baseDir, entryFile))} · 守卫 ${guardKey} 登记（mode=shadow，shadow_required=${registryEntry.shadow_required}）${alreadyRegistered ? `（registry 已有该 key，本次并入 covered_entries：${id}）` : ''}${guardText !== null ? ` · 守卫骨架已生成 ${guardScriptRel}` : ''}`)
    console.error(`[approve] 接线提示：把 { key: '${guardKey}', args: [...], when: (p) => p.<你的宿主钩子触发字段> } 挂进宿主 commit 钩子的守卫数组（窄谓词）。`
      + `当前 when 注解是占位值「${whenArg ?? DEFAULT_WHEN}」—— 请替换成本宿主 classifyStaged 真实返回的字段名（触发面窄是纪律）。`)
    if (wantJson) process.stdout.write(`${JSON.stringify({ decision: 'approve', entry: `${id}-${slug}.md`, entry_path: toPosix(path.relative(baseDir, entryFile)), guard_key: guardKey, guard_script: guardScriptRel, registry_written: true, registry_key_appended: !alreadyRegistered, guard_script_generated: guardText !== null, state_path: statePath }, null, 2)}\n`)
    return 0
  } catch (e) {
    console.error(`FAIL approve: ${e.message}`)
    flushAudit(config, baseDir, [{ tool: 'approve', action: 'approve-error', error: e.message }])
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
