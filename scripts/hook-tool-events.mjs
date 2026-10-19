#!/usr/bin/env node
/**
 * hook-tool-events.mjs —— PostToolUse 工具事件记录器（票 08 · 验证节奏可观测化）
 *
 * **为什么需要它**：现有钩子只覆盖「工具**失败**」，本仓第一次对**成功路径**留痕。
 * 「一批改完跑一次」与「逐项改逐项验」在时间序列上是两种不同形状（写×9 然后验×1，
 * 对比 写-验-写-验 交替）—— 票 10 的事件时序门禁要判的正是这个形状，没有事件源就无从判起。
 *
 * **读什么**：宿主把工具事件的 JSON 载荷送到 **stdin**（与本仓已接线的
 * PostToolUseFailure → capture.mjs 同一传输形态，capture.mjs 的 PROVENANCE_KEYS
 * 已证明 `toolName` / `tool_name` 两种拼写都出现过）。
 *
 * ⚠️ **字段名不猜**：宿主未公开工具事件载荷的完整 schema，本脚本对每类字段同时接受
 * snake_case 与 camelCase 两种拼写，**取不到就写 `unknown` 而不是丢事件** ——
 * 宁可留一条字段为空的记录等人看，也不要因为猜错键名而静默无数据（那会让下游门禁
 * 误判成「没有逐项测试」）。真实形状由**新会话**的首条记录确定后再收紧本脚本。
 *
 * **写什么**：`config.storage.events_dir` 同级的 `tool-events.jsonl`（append-only，
 * 本地 gitignored，与事件库同一生命周期）。每行 = 一条工具事件。
 *
 * **绝不阻塞调用方**：任何内部异常一律 fail-open（不写 + exit 0）。钩子抛错会让每一次
 * 工具调用都报错，那是把观测器变成故障源 —— 观测器的第一纪律是「坏了也不能影响被观测者」。
 *
 * 退出码：恒 0。
 *
 * O(1) spawn：全部判定进程内完成，零子进程。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 写类工具 = 产生源码变更。宿主别名：Write/Edit ← ApplyPatch（见宿主钩子文档）。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'ApplyPatch', 'NotebookEdit', 'MultiEdit'])
/**
 * 验证类命令的判据：命令文本里出现这些形态即算「跑了一次验证」。
 * 刻意保守 —— 误把普通命令算成验证会让时序门禁恒绿（假阴性），比漏判更危险。
 */
const VERIFY_CMD_RE =
  /\b(?:npm|pnpm|yarn|bunx|npx|node|bash|go|cargo|make|pytest|python3?)\b[^\n]{0,200}?\b(?:test|vitest|jest|typecheck|lint|check|build|verify|gates?|audit)\b|\bgit\s+diff\b\s*--check|\btsc\b|\beslint\b|\bprettier\b/i

/** 取第一个非空候选键 —— 宿主字段名 snake/camel 并存，不猜哪一个是。 */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/**
 * 取工具入参对象 —— **两种形态都要接**。
 *
 * 2026-10-18 实测踩到的坑：原先这里用 `pick(payload, 'toolInput', 'tool_input')`，
 * 而 `pick` 只接受**字符串**（`typeof v === 'string'`）。ZCode 的 PostToolUse 载荷里
 * `tool_input` 是**已解析的对象**，于是 `pick` 返回 null → `inputObj = {}` →
 * 每一条 Bash 事件的 `command` 恒为 `null`、`category` 恒为 `other`。
 * 后果不是「少记一条」，而是 `classify` 的 verify 分支**永不触发** ——
 * D18 批次时序门禁在这个 hook 下结构性恒红，会把「写完一批跑一次验证」误判成
 * 「批次未收口」（实测 179 条事件、0 条 verify、command 非 null 的 0 条）。
 *
 * 判据：字符串就 JSON.parse，对象直接用；都不是才退 `{}`。宁可空对象也不能崩。
 */
function readToolInput(payload) {
  const v = payload?.toolInput ?? payload?.tool_input
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  return {}
}

function classify(tool, cmd) {
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (tool === 'Bash' || tool === 'BashOutput') {
    return cmd && VERIFY_CMD_RE.test(cmd) ? 'verify' : 'other'
  }
  return 'other'
}

/** 从工具入参里取目标路径：写类取文件路径，shell 类取命令行。 */
function targetOf(tool, input, cmd) {
  if (WRITE_TOOLS.has(tool)) {
    return pick(input, 'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath') ?? 'unknown'
  }
  if (tool === 'Bash' || tool === 'BashOutput') return cmd ?? 'unknown'
  return pick(input, 'file_path', 'filePath', 'path', 'command', 'pattern') ?? 'unknown'
}

/** 命令行取前 200 字符：够门禁判形态，又不会把整段脚本塞进事件库。 */
function shorten(s) {
  if (typeof s !== 'string') return null
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 200 ? `${one.slice(0, 200)}…` : one
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += chunk
  return buf
}

/** 定位事件目录：优先实例配置，加载失败退回技能同级的 .learnings-work。 */
function resolveEventsDir() {
  for (const cfgRel of [path.join(HERE, '..', '..', '..', '..', '.self-improving.yaml')]) {
    try {
      if (!existsSync(cfgRel)) continue
      const raw = readFileSync(cfgRel, 'utf8')
      const m = /^[ \t]*events_dir:[ \t]*(\S+)/m.exec(raw)
      if (m) return path.resolve(path.dirname(cfgRel), m[1].replace(/\/+$/, ''))
    } catch {
      /* 读不到就退下一档，绝不抛 */
    }
  }
  return null
}

async function main() {
  const raw = await readStdin()
  if (raw.trim() === '') process.exit(0) // 非钩子调用（手工跑 / 无载荷）→ 零副作用
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    process.exit(0) // 载荷不是 JSON：不是本钩子该处理的东西，安静退出
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0)

  const tool = pick(payload, 'toolName', 'tool_name') ?? 'unknown'
  const inputObj = readToolInput(payload)
  const rawCmd = pick(inputObj, 'command', 'cmd') ?? pick(payload, 'command')
  const cmd = shorten(rawCmd)
  const record = {
    ts: new Date().toISOString(),
    kind: 'tool',
    // 分类走**全文**，只有落库才截断（2026-10-18 实测缺陷）。
    // 原来 classify 吃的是 shorten 之后的串，而 `VERIFY_CMD_RE` 的匹配窗口恰好也是
    // 200 字符 —— 等于「信号词落在第 201 字符之后」的长命令会被自己的截断抹掉分类
    // 依据。本仓的合规命令几乎都被 `dev-container.sh box run … sh -lc '…'` 包一层，
    // 光前缀就 ~175 字符（实测 `npm run test:gates` 落在第 ~210 字符），截断后
    // verify 词根本不在串里 → 事件恒记 other → D18 判「批次未收口」。
    // 现象：确实跑了 `npm run test:gates`，事件流里却没有对应的 verify 事件。
    category: classify(tool, rawCmd),
    tool,
    target: targetOf(tool, inputObj, cmd),
    session_id: pick(payload, 'sessionId', 'session_id'),
    turn_id: pick(payload, 'turnId', 'turn_id'),
    // 载荷里没有原始命令全文时留 null，不编造：下游门禁必须能区分「没记录」与「命令为空」
    command: cmd,
  }

  const dir = resolveEventsDir()
  if (!dir) process.exit(0)
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'tool-events.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 写不进去（只读卷 / 权限）也不能影响调用方 */
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
