#!/usr/bin/env node
/**
 * capture.mjs —— 错误事件捕获 + 触发式检索（通用技能，零项目耦合，宿主可跑）
 *
 * 用法：
 *   node capture.mjs --source <gate|hook|tool|manual> --kind <tool_error|gate_block|hook_failure|manual>
 *                    [--severity <info|warn|error>] [--text <原文> | --payload <JSON> | --payload-file <p>]
 *                    [--path-prefix <前缀>]... [--scopes <域>[,<域>]] [--max-events <n>]
 *                    [--json] [--no-block] [--config <p>]
 *   --text          门禁拦截输出 / 人工输入的原始报错文本（宿主缺事件源时的降级入口，
 *                   直接管道喂 pre-commit 的 FAIL 输出即可：`| node capture.mjs --source gate --kind gate_block --text-`）
 *                   （`--text -` = 从 stdin 读，省去 shell 引号地狱）
 *   --payload       结构化细节（JSON 字符串）；与 --text / --payload-file 三选一，缺省记 {message:""}
 *   --path-prefix   已知路径根前缀（可重复）：命中则先剥前缀再归一化，用于提高 fingerprint 精度
 *   --scopes        触发检索的域（缺省取 config.hook.default_scopes，与 SessionStart 同一来源）
 *   --json          stdout 输出事件 JSON 一行（否则 stdout 输出注入块，stderr 输出人类摘要）
 *   --no-block      只落事件不触发检索
 *   --diag <路径>    诊断探针（接线体检用 · 见下方 appendDiag 说明）。默认关闭、零副作用。
 *
 * 输出：事件写入 `config.storage.events_dir`（本地 gitignored）下按日分片 JSONL；
 * 命中相关条目时把**注入块**打到 stdout —— 这就是「并入后续注入上下文」的通道
 * （调用方原样转发 stdout 即可，块内出处与命中计数的渲染逻辑与 inject.mjs **同一份**，
 * 本文件只 import 复用，绝不复制第二份过滤/预算实现）。
 *
 * 退出码：0 = 正常（含 kill-switch off 与所有 fail-open）；2 = 用法错误 / 事件源不在白名单。
 * **任何内部异常 fail-open**：不写事件 + 审计一条 + exit 0，绝不阻塞调用方。
 *
 * 行为契约（AC 全部 fixture 化 = tests/capture.test.mjs）：
 *   - 正向：事件行含 §2 Event 全键，fingerprint 稳定，按日分片
 *   - 双形态：宿主路径与 devbox 路径表达的同一错误 → 同一 fingerprint
 *   - 归并：同一 fingerprint 二次捕获 → 同一行 count+1（不新增行）
 *   - 近邻：相似但不同的错误 → 只写「待人工合并清单」绝不自动合并（首要键而非唯一真理）
 *   - 白名单：source 不在 config.event_sources → 拒收（exit 2）
 *   - kill_switch.capture=false → 零输出、零写盘、零检索（零副作用）
 *   - 并发：N 个进程同时捕获同一错误 → 单条记录 count == N（不丢计数），分片全程原子可读
 *
 * O(1) spawn 纪律：全部判定进程内完成，子进程仅 loadContext 解析仓根的一次 git rev-parse。
 * YAML 统一经 ./lib/yaml-lite.mjs 双后端读取（宿主钩子零外部依赖可跑）。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { loadContext, runInject, flushAudit } from './inject.mjs'
import { atomicWrite, withFileLock } from './lib/atomic-file.mjs'
import { createLogger } from './lib/log.mjs'

/** §2 Event 契约的 kind / severity 枚举（validate.mjs 不校事件，判据权威 = 事件层 = 本文件）。 */
export const EVENT_KINDS = ['tool_error', 'gate_block', 'hook_failure', 'manual']
export const EVENT_SEVERITIES = ['info', 'warn', 'error']
/** 近邻合并候选的相似度阈值（Jaccard）。刻意偏高：宁可漏提示也不误合并。 */
export const NEIGHBOR_THRESHOLD = 0.55
/** 触发检索的停用词（英文 + 常见噪声词）：不进检索关键词，避免污染命中计数。 */
const STOPWORDS = new Set([
  'error', 'cannot', 'failed', 'failure', 'with', 'from', 'this', 'that', 'have', 'been',
  'was', 'were', 'not', 'the', 'and', 'for', 'you', 'are', 'but', 'all', 'any', 'can',
  'err', 'exc', 'exception', 'traceback', 'null', 'undefined', 'object', 'string',
])

// ===== 路径形态识别与归一化 =====
// 绝对路径 token（Windows 盘符 / POSIX 至少三段）；片段以「含扩展名的段」判真，
// 否则 `/2026/10/16` 这类日期形态会被误当路径改写掉。
const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s'"()[\]{}<>]+/g
const POSIX_PATH_RE = /(?:\/[A-Za-z0-9_.@+-]+){3,}/g
const HAS_FILE_EXT = /\.[A-Za-z0-9]{1,10}$/

/** 判断一个候选 token 是否真像路径（含扩展名的末段）。 */
function looksLikePath(token) {
  const segs = token.replace(/\\/g, '/').split('/').filter(Boolean)
  return segs.some((s) => HAS_FILE_EXT.test(s))
}

/**
 * 路径归一化（宿主/devbox 双形态同 fingerprint 的关键）。
 *
 * 规则（通用，零项目耦合）：先按已知前缀（`--path-prefix`，大小写与分隔符不敏感）剥根；
 * 剥不掉的（典型：宿主 `D:\...` 与容器 `/workspace/app/...` 的根无法预知）**只保留末两段**。
 * 只保留末两段是有意的近似 —— 跨目录同名文件会被归到同一 fingerprint，这正是契约里
 * 「fingerprint 是首要键而非唯一真理、近邻候选留人工合并」要覆盖的场景；项目若在意精度，
 * 就用 `--path-prefix` 显式声明仓库根与容器根，把区分度补回来。
 * @param {string} token 路径 token
 * @param {string[]} prefixes 已知路径根前缀
 * @returns {string} 归一化后的相对形态
 */
export function normalizePathToken(token, prefixes = []) {
  let p = String(token).replace(/\\/g, '/').replace(/[.,;:)\]}'"]+$/, '')
  for (const pref of prefixes) {
    const norm = String(pref).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!norm) continue
    const lower = p.toLowerCase()
    if (lower === norm.toLowerCase()) {
      p = ''
      break
    }
    if (lower.startsWith(`${norm.toLowerCase()}/`)) {
      p = p.slice(norm.length + 1)
      break
    }
  }
  const segs = p.split('/').filter(Boolean)
  return segs.length > 2 ? segs.slice(-2).join('/') : p
}

/** 把文本里的绝对路径 token 换成功一归一化形态；不像路径的片段原样返回。 */
function normalizePaths(text, prefixes) {
  const one = (m) => (looksLikePath(m) ? normalizePathToken(m, prefixes) : m)
  return text.replace(WINDOWS_PATH_RE, one).replace(POSIX_PATH_RE, one)
}

/** 信封里错误消息的候选键（按可信度排序：越靠前越像「这句话就是给人看的报错」）。 */
const ENVELOPE_MESSAGE_KEYS = ['error', 'message', 'reason', 'stderr', 'stdout', 'output']

/**
 * 信封里「这条事件从哪来」的字段（宿主多版本双写 camelCase + snake_case，故每项都列候选）。
 * 键名不在此表内的一律不采信 —— 宁可少记也不猜（猜出来的 provenance 会污染对账，错的比没有更糟）。
 */
const PROVENANCE_KEYS = {
  hook_event: ['hookEventName', 'hook_event_name'],
  tool: ['toolName', 'tool_name'],
  session_id: ['sessionId', 'session_id'],
  turn_id: ['turnId', 'turn_id'],
  trace_id: ['traceId', 'trace_id'],
}

/**
 * 从宿主 hook 信封里抽 provenance（2026-10-17）。
 *
 * **为什么必须记**：进化体系要能回答「这条经验是哪个会话、哪次工具调用、哪个 hook 采到的」。
 * 只记 `source: tool` 的话，全库所有工具失败长得一模一样 —— 归并能work（fingerprint 只吃消息），
 * 但**归因**（拍2）无从下手：分不清是 Read 超限、Bash 端口占用还是 Edit 冲突，
 * scope 投票与近邻聚类都只能靠 tokens 猜。
 *
 * 与 `unwrapHookEnvelope` 的分工：那个剥**语义**（消息本体），这个剥**出处**（信封元数据）；
 * 两者都只认信封、认不出就返回 null，绝不猜。
 *
 * @param {string} text 原始输入（可能是整包 JSON 信封）
 * @returns {{collected_by: string, transport: string, tool: string|null, session_id: string|null,
 *            turn_id: string|null, trace_id: string|null}|null} 非信封 / 无任何元数据 → null
 */
export function extractProvenance(text, transport = 'stdin') {
  const trimmed = String(text ?? '').trim()
  if (!trimmed.startsWith('{')) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const out = { collected_by: 'cli', transport: String(transport || 'unknown') }
  let any = false
  for (const [field, candidates] of Object.entries(PROVENANCE_KEYS)) {
    for (const key of candidates) {
      const v = parsed[key]
      if (typeof v === 'string' && v.trim() !== '') {
        out[field] = v.trim()
        any = true
        break
      }
    }
    if (out[field] === undefined) out[field] = null
  }
  if (!any) return null
  if (out.hook_event) out.collected_by = `hook:${out.hook_event}`
  return out
}

/**
 * 剥掉宿主 hook 的 JSON 信封，只留错误消息本体（2026-10-17 主仓接线实证）。
 *
 * **为什么必须在 capture 侧做而不是宿主接线侧**：宿主送什么形状是宿主的事（每个 CLI 版本都可能变，
 * 键名还有 `error` / `message` / 双写 `error_details.message` 等多种形态），把这份「信封知识」
 * 写进 `.zcode/config.json` 就成了机器本地的一次性 hack —— 换宿主、换版本即失效，且没人测得到。
 * 协议侧（capture）做则是通用能力：认得信封就剥，认不得就原样保留，永远不会把数据弄坏。
 *
 * @param {string} text 原始输入（可能是纯文本、也可能是整包 JSON 信封）
 * @returns {string} 剥壳后的消息；非信封或剥不出内容时原样返回
 */
export function unwrapHookEnvelope(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return raw // 长得像 JSON 但不是（门禁输出里带花括号很常见）→ 不猜，原样
  }
  if (parsed === null || typeof parsed !== 'object') return raw
  const seen = new Set()
  /** 深度优先找第一个像「报错句子」的值（含空格、长度合理、不像 ID）。数组当单元素处理（批次信封）。 */
  const pick = (node, depth) => {
    if (depth > 4 || node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const v of node) {
        const hit = pick(v, depth + 1)
        if (hit) return hit
      }
      return null
    }
    for (const key of ENVELOPE_MESSAGE_KEYS) {
      const v = node[key]
      if (typeof v !== 'string') continue
      const t = v.trim()
      // 排除纯 ID / 纯路径 / 太短的值 —— 它们不是「给人看的报错」
      if (t.length >= 8 && /[\s:：]/.test(t) && !/^[0-9a-f-]{16,}$/i.test(t)) return t
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object' && !seen.has(v)) {
        seen.add(v)
        const hit = pick(v, depth + 1)
        if (hit) return hit
      }
    }
    return null
  }
  const msg = pick(parsed, 0)
  return msg ?? raw
}

/**
 * 消息骨架：抽错误码 → 归一化路径 → 抹掉易变部分（十六进制 / UUID / 数字 / 引号内容）→ 压空白小写。
 * 「抹掉易变部分」是归并的前提：同一错误两次发生的行号、时间戳、耗时必须消掉，
 * 否则 fingerprint 每次都变、归并退化成无限流。
 */
function buildSkeleton(text, prefixes) {
  const codes = [...new Set((text.match(/\b(?:E[A-Z]{2,10}|ERR_[A-Z0-9_]+|SIG[A-Z]{2,10})\b/g) || []).map((c) => c.toUpperCase()))].sort()
  let s = normalizePaths(text, prefixes)
  s = s
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(/\b\d+\b/g, '#')
    .replace(/[^A-Za-z0-9#/._~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return { codes, skeleton: s }
}

/**
 * fingerprint = sha256(kind | 错误码集合 | 消息骨架) 前 16 位。
 * 错误码进签名是刻意的：同一个文件不同错误码是两类问题，不该被骨架的相似度吞成一条。
 * @param {{kind: string, text: string}} input
 * @param {string[]} prefixes
 * @returns {{fingerprint: string, codes: string[], skeleton: string, tokens: string[]}}
 */
export function computeFingerprint({ kind, text }, prefixes = []) {
  const { codes, skeleton } = buildSkeleton(String(text ?? ''), prefixes)
  const digest = createHash('sha256').update(`${kind}|codes=${codes.join(',')}|${skeleton}`).digest('hex')
  const tokens = [...new Set(skeleton.split(/[^a-z0-9#]+/).filter((t) => t.length >= 4 && !STOPWORDS.has(t)))]
  return { fingerprint: `fp-${digest.slice(0, 16)}`, codes, skeleton, tokens }
}

/** 两段骨架的 Jaccard 相似度（近邻候选用；空集对空集返回 0 —— 「都无内容」不算近邻）。 */
export function similarity(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0
  const a = new Set(tokensA)
  let inter = 0
  for (const t of new Set(tokensB)) if (a.has(t)) inter++
  return inter / (a.size + new Set(tokensB).size - inter)
}

/** 当日事件分片路径（按日切分 = 事件层职责，契约只规定目录不给文件名）。 */
export function todayShard(eventsDir, now = new Date()) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '')
  return path.join(eventsDir, `events-${ymd}.jsonl`)
}

/** 读一个 JSONL 分片 → 记录数组（缺文件 = 空；坏行跳过并提示，绝不因单行坏掉整个文件）。 */
function readShard(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch (e) {
      console.error(`[capture] 跳过坏行（${path.basename(file)}）: ${e.message}`)
    }
  }
  return out
}

/**
 * 最近事件（SessionStart 接线消费）：跨分片按 ts 升序取末 limit 条。
 * 供 hook 在注入块后附「近期触发事件」小节 —— 这是「并入后续注入上下文」的落地形态。
 * @param {object} config 实例配置
 * @param {string} baseDir 配置所在目录（storage.* 相对它解析）
 * @param {number} limit
 * @returns {object[]}
 */
export function readRecentEvents(config, baseDir, limit = 3) {
  const eventsDir = path.resolve(baseDir, config.storage.events_dir)
  if (!existsSync(eventsDir)) return []
  const files = readdirSync(eventsDir)
    .filter((f) => /^events-\d{8}\.jsonl$/.test(f))
    .sort()
    .reverse()
  const picked = []
  for (const f of files) {
    picked.push(...readShard(path.join(eventsDir, f)))
    if (picked.length >= limit) break
  }
  picked.sort((a, b) => String(a.last_ts || a.ts).localeCompare(String(b.last_ts || b.ts)))
  return picked.slice(-Math.max(0, limit))
}

/** 「近期触发事件」小节渲染（hook 用；无事件返回空串 = 零噪音）。 */
export function renderRecentSection(records) {
  if (!records || records.length === 0) return ''
  const lines = records.map(
    (r) => `- ${r.last_ts || r.ts} · ${r.kind} · ${r.source} · ${r.fingerprint} · 累计 ${r.count} 次`,
  )
  return `## 近期触发事件（${records.length} 条 · 相关经验见上方注入块）\n${lines.join('\n')}\n`
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node capture.mjs --source <${['gate', 'hook', 'tool', 'manual'].join('|')}> --kind <${EVENT_KINDS.join('|')}>
                   [--severity <${EVENT_SEVERITIES.join('|')}>] [--text <原文>|--text -|--payload <JSON>|--payload-file <p>]
                   [--path-prefix <前缀>]... [--scopes <域>,...] [--max-events <n>] [--json] [--no-block] [--config <p>]
                   [--diag <探针路径>]
  退出码：0=正常（含 fail-open 与 kill-switch off） / 2=用法错误、事件源不在白名单`)
  return 2
}

/**
 * 诊断探针（`--diag <路径>`，默认关闭 = 零副作用）。
 *
 * **为什么需要它**：2026-10-18 实测踩到「接线看着全对、事件在触发、脚本手工跑也正常，
 * 但事件库零新增」。这三种解释的修法**完全相反**，肉眼分不清：
 *   ① 钩子压根没被调起      → 改宿主接线（事件名 / matcher / 钩子类型 / 配置没被读到）
 *   ② 调起了但没喂 stdin    → 改钩子类型（process 走 argv、command 走 shell 管道，投递路径不同）
 *   ③ 喂了但脚本没落库      → 改脚本（参数解析 / kill-switch / 写盘失败）
 * 没有探针时三者表现为同一个现象：**事件库没动静**。这正是本仓反复记的
 * 「看起来有防护但从没生效」——此处更甚，是「看起来接上了但从没生效」。
 *
 * **三段式留痕 = 三个环节各留一个判据**：
 *   `invoked` → 进程被拉起（`--diag` 一进来就写，先于参数解析）
 *   `stdin`   → 宿主把事件载荷喂进来没有（读 stdin 后写，含字节数与失败码）
 *   `exit`    → 写盘成功 / usage 错误 / kill-switch off（进程退出前写，含退出码）
 *
 * 只看探针即可定位：**没有 invoked 行 = 接线问题（宿主没调起）**；
 * 有 invoked 无 stdin = 载荷没投递到这条钩子；有 stdin 而事件库无新增 = 脚本侧问题。
 *
 * **绝不抛错**：探针自身失败（路径不存在 / 只读卷）一律吞掉 —— 观测器的第一纪律是
 * 「坏了也不能影响被观测者」，它写不进去顶多让诊断退化，绝不能把钩子打成失败。
 */
let DIAG_PATH = null

/** 追加一行探针。零副作用（未开探针时立即返回）。 */
function appendDiag(line) {
  if (!DIAG_PATH) return
  try {
    mkdirSync(path.dirname(DIAG_PATH), { recursive: true })
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 探针写不进去也不能影响调用方 */
  }
}

/** 从 argv 摘 `--diag <路径>`（先于参数解析，故用裸扫而非 switch）。 */
function diagPathFrom(argv) {
  const i = argv.indexOf('--diag')
  const v = i >= 0 ? argv[i + 1] : null
  return typeof v === 'string' && v !== '' && !v.startsWith('--') ? path.resolve(v) : null
}

/** fail-open：不写事件、不检索，审计一条，exit 0（绝不阻塞调用方）。 */
function failOpen(err, config, baseDir, records = []) {
  const reason = (err && err.message) || String(err)
  console.error(`[capture] fail-open: ${reason}（不写事件、不触发检索，绝不阻塞调用方）`)
  flushAudit(config, baseDir, [{ tool: 'capture', action: 'fail-open', error: reason }, ...records])
  return 0
}

export function main(argv) {
  // ===== 0. 诊断探针（先于一切：参数写错、stdin 读不到也要留痕）=====
  DIAG_PATH = diagPathFrom(argv)
  if (DIAG_PATH) appendDiag(`invoked argv=${JSON.stringify(argv)}`)

  // ===== 1. 参数语法（纯调用方错误 → exit 2，先于任何 kill-switch 判定）=====
  let cliConfig = null
  let source = null
  let kind = null
  let severity = 'error'
  let text = null
  let payloadArg = null
  let payloadFile = null
  const prefixes = []
  let scopesArg = null
  let maxEvents = 3
  let wantJson = false
  let noBlock = false
  const STDIN = Symbol('stdin')

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!['--config', '--source', '--kind', '--severity', '--text', '--payload', '--payload-file', '--path-prefix', '--scopes', '--max-events', '--diag'].includes(a)) {
      if (a === '--json' || a === '--no-block') {
        if (a === '--json') wantJson = true
        else noBlock = true
        continue
      }
      return usage(`未知参数 ${a}`)
    }
    const next = argv[i + 1]
    if (next === undefined) return usage(`${a} 后须跟值`)
    i++
    switch (a) {
      case '--config': cliConfig = path.resolve(next); break
      case '--source': source = next.trim(); break
      case '--kind': kind = next.trim(); break
      case '--severity': severity = next.trim(); break
      case '--text': text = next === '-' ? STDIN : next; break
      case '--payload': payloadArg = next; break
      case '--payload-file': payloadFile = path.resolve(next); break
      case '--path-prefix': prefixes.push(next); break
      case '--scopes': scopesArg = next; break
      case '--max-events': maxEvents = Number.parseInt(next, 10); break
      // --diag 已在第 0 段解析，这里只消费掉这个参数位
      case '--diag': break
      default: break
    }
  }
  if (!source) return usage('--source 必填（gate|hook|tool|manual）')
  if (!kind) return usage(`--kind 必填（${EVENT_KINDS.join('|')}）`)
  if (!EVENT_KINDS.includes(kind)) return usage(`--kind 取值非法: ${kind}（合法值: ${EVENT_KINDS.join(', ')}）`)
  if (!EVENT_SEVERITIES.includes(severity)) return usage(`--severity 取值非法: ${severity}（合法值: ${EVENT_SEVERITIES.join(', ')}）`)

  // stdin 读取（降级路径：门禁 FAIL 输出管道喂进来）
  if (text === STDIN) {
    try {
      text = readFileSync(0, 'utf8')
    } catch (e) {
      // EAGAIN 在 Windows 上是已知形态：宿主管道已关但 fd 仍被当可读，同步读抛它
      appendDiag(`stdin READ-FAILED code=${e.code || '?'} msg=${e.message}`)
      return usage(`--text - 读 stdin 失败: ${e.message}`)
    }
    appendDiag(`stdin bytes=${Buffer.byteLength(text, 'utf8')}`)
  }

  // payload 三选一解析（结构化优先；解析失败是调用方错误 → exit 2）
  let payload = {}
  let provenance = null
  if (payloadArg !== null) {
    try {
      payload = JSON.parse(payloadArg)
    } catch (e) {
      return usage(`--payload 不是合法 JSON: ${e.message}`)
    }
  } else if (payloadFile) {
    if (!existsSync(payloadFile)) return usage(`--payload-file 不存在: ${payloadFile}`)
    try {
      payload = JSON.parse(readFileSync(payloadFile, 'utf8'))
    } catch (e) {
      return usage(`--payload-file 不是合法 JSON: ${e.message}`)
    }
  } else if (text !== null && text !== undefined) {
    // provenance 必须在**剥壳之前**抽（剥壳会把信封换成消息本体，元数据随之丢失）
    provenance = extractProvenance(String(text), 'text')
    payload = { message: String(text) }
    // 宿主 hook 送来的常常是**整包 JSON 信封**（tool 名 / sessionId / toolInput / 各种 ID）。
    // 直接把信封当消息文本的后果是灾难性的、且静默：buildSkeleton 会把带引号的值全抹成 `"…"`、
    // 把数字全抹成 `#`，于是 tokens 几乎为空（实测 PostToolUseFailure 信封 → tokens=[]），
    // 而指纹仍然唯一 —— 结果是**归并照常工作、语义全丢**：蒸馏拿不到任何抓手，
    // 近邻聚类因空 token 恒不相似而永不合并，scope 投票（按共同词找存量条目）也全失效。
    // 这里把信封剥掉，只留错误消息本体；剥不动就原样保留（门禁 FAIL 纯文本等形态不受影响）。
    payload.message = unwrapHookEnvelope(payload.message)
  }
  // `--payload` / `--payload-file` 也可能装着整包信封（宿主换接线方式时）；同样在剥壳前抽一次
  if (provenance === null) {
    const rawCandidate = payloadArg ?? (payloadFile ? readFileSync(payloadFile, 'utf8') : null) ?? payload.message
    provenance = extractProvenance(rawCandidate, payloadArg ? 'payload' : payloadFile ? 'payload-file' : 'text')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return usage('payload 须为 JSON 对象（--payload / --payload-file）')
  }
  const rawText = [
    typeof payload.message === 'string' ? payload.message : '',
    typeof payload.code === 'string' ? payload.code : '',
    typeof payload.path === 'string' ? payload.path : '',
    typeof payload.command === 'string' ? payload.command : '',
  ]
    .filter(Boolean)
    .join('\n')

  // ===== 2. 配置链（与 inject.mjs 同一份 loadContext，失败 → fail-open）=====
  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: process.cwd() })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    return failOpen(e, (e && e.config) || null, (e && e.baseDir) || null)
  }

  // ===== 3. 事件源白名单（拒收 = 调用方错误，先于 kill-switch：否则开关关着时
  //      拼错的 source 会被静默吞成「开关关着」，人再也看不出接线错了）=====
  const whitelist = Array.isArray(config.event_sources) ? config.event_sources : []
  if (!whitelist.includes(source)) {
    return usage(`事件源不在 config.event_sources 白名单: ${source}（白名单: ${whitelist.join(', ') || '空'}）`)
  }

  // ===== 4. kill-switch off：零输出、零写盘、零检索=====
  if (config.kill_switch.capture !== true) {
    console.error('[capture] kill_switch.capture=false，不写事件、不触发检索（零副作用）')
    createLogger({ module: 'capture', baseDir, config, traceId: (provenance && provenance.trace_id) || null })
      .info('kill_switch.capture=false → 跳过（零副作用）', { source, kind, severity })
    return 0
  }

  // ===== 5. 主流程：归一化 → 归并 → 落盘 → 触发检索（内部异常 fail-open）=====
  try {
    // 诊断 logger：trace_id 优先取宿主信封里的 traceId（capture 独有 —— 别的事件源没有）
    const logger = createLogger({ module: 'capture', baseDir, config, traceId: (provenance && provenance.trace_id) || null })
    const auditRecords = []
    const eventsDir = path.resolve(baseDir, config.storage.events_dir)
    const now = new Date()
    const shard = todayShard(eventsDir, now)
    const { fingerprint, codes, tokens } = computeFingerprint({ kind, text: rawText }, prefixes)

    /**
     * 记账临界区：读分片 → 归并/新增 → 近邻登记 → 原子写整分片。
     *
     * **必须互斥**（票 H2）：整段是「读-改-写 + 整体覆盖」，无锁时并发捕获会互相覆盖
     * （实测 12 个并发 capture 只记到 count=11，丢 1 次 —— 而事件计数正是近邻合并的判据底座）。
     * 锁粒度取**目录级一把**（`<events_dir>/.events.lock`）而非分片级：临界区里还要写
     * `pending-merge/*.jsonl`，跨文件若各拿一把锁就形成嵌套，违反「不得嵌套两把锁」的锁序纪律。
     * 计数增量（count+1 / 事件行 +1）是可交换的，锁内重读 + 增量叠加即杜绝丢更新。
     */
    const critical = () => {
      const records = readShard(shard) // 锁内重读 = 叠加在最新分片上
      const existing = records.find((r) => r.fingerprint === fingerprint)
      // 近邻候选：同 kind、不同 fingerprint、骨架相似度达阈值 → 只登记不合并
      const nearCandidates = records
        .filter((r) => r.fingerprint !== fingerprint && r.kind === kind)
        .map((r) => ({ fingerprint: r.fingerprint, similarity: similarity(tokens, r.tokens || []) }))
        .filter((c) => c.similarity >= NEIGHBOR_THRESHOLD)

      let record
      if (existing) {
        // ===== 归并：同一 fingerprint 累加计数，绝不新增行（重复错误只留一条事实）=====
        existing.count = (typeof existing.count === 'number' ? existing.count : 1) + 1
        existing.last_ts = now.toISOString()
        existing.severity = severity
        existing.payload = payload
        // provenance 只增不减：本次没抽到（纯文本输入）不该抹掉首次采到的会话出处
        if (provenance !== null) existing.provenance = provenance
        record = existing
        auditRecords.push({ action: 'event-merged', fingerprint, count: existing.count, entry: existing.id })
      } else {
        const seq = records.length + 1
        record = {
          id: `evt-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
          ts: now.toISOString(),
          first_ts: now.toISOString(),
          last_ts: now.toISOString(),
          count: 1,
          source,
          kind,
          severity,
          payload,
          provenance,
          fingerprint,
          codes,
          tokens,
          near_neighbors: [],
          entry_id: null,
        }
        records.push(record)
        auditRecords.push({ action: 'event-captured', fingerprint, kind, source, entry: record.id })
      }

      // 近邻登记：主记录挂 near_neighbors + 独立「待人工合并清单」（人工判权威，不自动合并）
      const neighbors = record.near_neighbors || []
      for (const c of nearCandidates) {
        const other = records.find((r) => r.fingerprint === c.fingerprint)
        const otherNeighbors = (other && other.near_neighbors) || []
        if (!neighbors.some((n) => n.fingerprint === c.fingerprint) && !otherNeighbors.some((n) => n.fingerprint === fingerprint)) {
          const item = { fingerprint: c.fingerprint, similarity: Number(c.similarity.toFixed(3)) }
          neighbors.push(item)
          record.near_neighbors = neighbors
          if (other) other.near_neighbors = [...otherNeighbors, { fingerprint, similarity: Number(c.similarity.toFixed(3)) }]
          mkdirSync(path.join(eventsDir, 'pending-merge'), { recursive: true })
          appendFileSync(
            path.join(eventsDir, 'pending-merge', `pending-${now.toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`),
            `${JSON.stringify({ ts: now.toISOString(), kind, a: fingerprint, b: c.fingerprint, similarity: item.similarity, status: 'pending-human-review' })}\n`,
            'utf8',
          )
          auditRecords.push({ action: 'near-neighbor-flagged', fingerprint, near: c.fingerprint, similarity: item.similarity })
        }
      }

      mkdirSync(path.dirname(shard), { recursive: true })
      // 原子写：读方（hook 的 readRecentEvents）永远只看到旧版或新版完整分片，不会读到写了一半的行
      atomicWrite(shard, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
      return record
    }

    // 拿不到锁（锁不可用 / 等锁超时）：降级为无锁记账并显式告警。方向是「可能丢这一次计数」
    // 而非「卡住调用方」—— 与本系统 fail-open 纪律一致（锁自带陈旧回收，不会永久死锁）。
    const locked = withFileLock(path.join(eventsDir, '.events.lock'), critical)
    if (locked === null) console.error(`[capture] 事件锁获取失败（降级为无锁记账，可能丢本次计数）: ${path.join(eventsDir, '.events.lock')}`)
    const record = locked === null ? critical() : locked

    // ===== 触发式检索：复用 inject.mjs 的 runInject（同一份 scope 过滤/top_k/预算渲染）=====
    // 刻意在**锁外**：runInject 内部会写审计日志，拿两把锁即构成嵌套（锁序纪律）。
    let block = ''
    if (!noBlock && config.kill_switch.injection === true) {
      const configured = config.hook && Array.isArray(config.hook.default_scopes) ? config.hook.default_scopes : []
      const scopes = (scopesArg ? scopesArg.split(',') : configured)
        .map((s) => String(s).trim())
        .filter((s) => s !== '' && config.scope.values.includes(s) && s !== config.scope.default)
      if (scopes.length > 0) {
        const keywords = [...new Set([...codes.map((c) => c.toLowerCase()), ...tokens.slice(0, 5)])].slice(0, 6)
        block = runInject(config, scopes, keywords, baseDir, auditRecords)
      }
    }

    flushAudit(config, baseDir, auditRecords)
    console.error(`[capture] 事件 ${record.id} → ${shard}（${fingerprint} · 累计 ${record.count} 次 · 近邻 ${record.near_neighbors.length}）`)
    // 诊断轨迹：把「这次失败采到了什么」落成结构化一条，供 log-query --cycle <fingerprint> 跨调用串联。
    // 注意它与事件库是两回事：事件库是证据（append-only 不滚动），这里是诊断（会滚动）。
    logger.span('capture.record', {
      fingerprint,
      source,
      kind,
      severity,
      merged: record.count > 1,
      count: record.count,
      shard,
      provenance: provenance ? provenance.collected_by : null,
      tool: provenance ? provenance.tool : null,
    })
    logger.info(`捕获 ${record.id} · ${kind} · ${fingerprint}`, {
      fingerprint,
      source,
      severity,
      count: record.count,
      collected_by: provenance ? provenance.collected_by : null,
    })
    if (wantJson) process.stdout.write(`${JSON.stringify(record)}\n`)
    else if (block !== '') process.stdout.write(block)
    return 0
  } catch (e) {
    // fail-open 前先记异常：异常独立成文件（si-error.log），「今天有没有出事」扫一个文件就够
    createLogger({ module: 'capture', baseDir, config, traceId: (provenance && provenance.trace_id) || null })
      .error(`capture fail-open: ${e.message}`, e, { source, kind })
    return failOpen(e, config, baseDir)
  }
}

// 仅当被直接执行时运行 CLI（导出供 hook / 测试复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
  // 退出码也要留痕：这是「事件到底有没有落库」的最终判据（0=落库/正常，
  // 2=用法错误，脚本侧问题就在这里现形）。appendDiag 是全局探针，未开时零副作用。
  appendDiag(`exit code=${process.exitCode}`)
}
