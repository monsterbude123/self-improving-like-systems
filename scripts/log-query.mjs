#!/usr/bin/env node
/**
 * log-query.mjs —— 经验系统诊断日志的**只读**查询面
 *
 * 存在的理由：日志写进去没人看得见等于没写。这个 CLI 把三个问题变成一条命令：
 *   ① 现在是不是在工作        → `--stats`
 *   刚才那次为什么没生效      → `--trace <traceId>`（一次调用的完整周期，含各阶段耗时）
 *   这条经验卡在哪一拍        → `--cycle <entry_id|guard_key|fingerprint>`（跨调用串六拍）
 *   今天出没出事              → `--errors [--since 1h|1d|<ISO>]`
 *
 * **只读**：本文件不写任何东西（与 trace.mjs 同纪律）。数据源 = `logging.dir` 下的
 * `si.log[.N]` / `si-error.log[.N]` / `si-trace-*.jsonl[.N]`，**不读审计与事件账**
 * （那两本账是证据，由 trace.mjs 管，日志轮不到它们）。
 *
 * 退出码：0=查到 / 1=没查到（不是失败，是「没有」这个事实）/ 2=用法错误或目录不可读
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadContext } from './inject.mjs'
import { LEVELS, resolveLogging, fallbackLogDir } from './lib/log.mjs'

/** 读日志目录里所有匹配前缀的文件（滚动分片一并读，最老的分片最小序）。 */
function readAll(dir, prefix) {
  const out = []
  let names
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names.filter((f) => f.startsWith(prefix)).sort()) {
    try { out.push({ file: n, text: readFileSync(path.join(dir, n), 'utf8') }) } catch { /* 读不到就跳过 */ }
  }
  return out
}

/** 把 `--since 1h` / `--since 1d` / ISO 时间解析成毫秒时间戳下限。 */
function sinceMs(spec, now = Date.now()) {
  if (!spec) return 0
  const m = /^(\d+)([mhd])$/.exec(spec)
  if (m) {
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
    return now - Number(m[1]) * mult
  }
  const t = Date.parse(spec)
  return Number.isFinite(t) ? t : 0
}

/** 从一行文本日志里抠出 `key=value`（引号值也吃）。 */
function field(line, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(\\S+|"[^"]*")`).exec(line)
  return m ? m[1].replace(/^"|"$/g, '') : null
}

const TS = /^\S+\s+\S+\s+run=(\S+)\s+trace=(\S+)\s+mod=(\S+)/

/** `--stats`：按级别 / 模块聚合，回答「是不是工作正常」。 */
function stats(dir, since) {
  const lines = readAll(dir, 'si.log').flatMap((f) => f.text.split('\n')).filter(Boolean)
  const byLevel = {}
  const byModule = {}
  let recent = 0
  let oldest = null
  for (const line of lines) {
    const ts = Date.parse(line.slice(0, 24))
    if (Number.isFinite(ts)) { oldest = oldest === null ? ts : Math.min(oldest, ts); if (ts >= since) recent++ }
    const parts = line.slice(0, 60).trim().split(/\s+/)
    const lvl = (parts[1] || '?').toLowerCase()
    byLevel[lvl] = (byLevel[lvl] || 0) + 1
    const mod = field(line, 'mod') || '?'
    byModule[mod] = (byModule[mod] || 0) + 1
  }
  const spans = readSpans(dir).filter((s) => Date.parse(s.ts) >= since)
  const failed = spans.filter((s) => s.event.endsWith('.end') && s.status === 'error')
  const errorFile = readAll(dir, 'si-error.log').flatMap((f) => f.text.split('\n')).filter(Boolean)
  return { total: lines.length, recent, since: new Date(since).toISOString(), byLevel, byModule, spans: spans.length, failedSpans: failed.length, errorLines: errorFile.length, oldest }
}

/** 读全部结构化轨迹记录（坏行跳过，不猜）。 */
function readSpans(dir) {
  const out = []
  for (const { file, text } of readAll(dir, 'si-trace-')) {
    for (const l of text.split('\n')) {
      if (!l.trim()) continue
      try { const r = JSON.parse(l); if (r && typeof r === 'object') { r._file = file; out.push(r) } } catch { /* 坏行不猜 */ }
    }
  }
  return out
}

export function main(argv) {
  let cliConfig = null
  let projectDir = process.cwd()
  let mode = null
  let value = null
  let since = null
  let wantJson = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') { wantJson = true; continue }
    if (a === '--since') { since = argv[++i]; continue }
    if (['--stats', '--errors'].includes(a)) { mode = a.slice(2); value = null; continue }
    if (['--trace', '--cycle'].includes(a)) {
      mode = a.slice(2)
      const next = argv[++i]
      if (!next || next.startsWith('--')) return usage(`${a} 后须跟值`)
      value = next
      continue
    }
    if (a === '--config') { cliConfig = path.resolve(argv[++i]); continue }
    if (a === '--project-dir') { projectDir = path.resolve(argv[++i]); continue }
    return usage(`未知参数 ${a}`)
  }
  if (mode === null) return usage('须指定一个模式：--stats / --trace <id> / --cycle <key> / --errors')

  let cfg = null
  let baseDir = projectDir
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    cfg = resolveLogging(loaded.config)
    baseDir = loaded.baseDir
  } catch {
    // 配置链坏了也要能查日志：退到 cwd + 默认目录，不因配置坏而查不了
    cfg = resolveLogging(null)
  }
  const dir = path.resolve(baseDir, cfg.dir)
  if (!existsSync(dir)) {
    const msg = `日志目录不存在：${dir}\n  （没有日志 ≠ 系统没跑过 —— 也可能是 logging.enabled=false，或日志已被滚动清空）`
    if (wantJson) process.stdout.write(`${JSON.stringify({ dir, found: false }, null, 2)}\n`)
    else console.error(msg)
    return 1
  }
  const sinceTs = sinceMs(since)

  if (mode === 'stats') {
    const r = stats(dir, sinceTs)
    if (wantJson) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.total > 0 ? 0 : 1 }
    console.error([
      `## 诊断日志 · 统计（${dir}）`,
      '',
      `总行数: ${r.total}　最近窗口(${r.since}) 行数: ${r.recent}`,
      `轨迹记录: ${r.spans}　其中失败 span: ${r.failedSpans}`,
      `异常文件行数: ${r.errorLines}`,
      '',
      '按级别:',
      ...Object.entries(r.byLevel).map(([k, v]) => `    ${k}: ${v}`),
      '',
      '按模块:',
      ...Object.entries(r.byModule).map(([k, v]) => `    ${k}: ${v}`),
      '',
    ].join('\n'))
    return r.total > 0 ? 0 : 1
  }

  if (mode === 'errors') {
    const files = readAll(dir, 'si-error.log')
    const rows = files.flatMap((f) => f.text.split('\n')).filter((l) => l.trim() && Date.parse(l.slice(0, 24)) >= sinceTs)
    if (wantJson) { process.stdout.write(`${JSON.stringify({ dir, count: rows.length, lines: rows }, null, 2)}\n`); return rows.length > 0 ? 0 : 1 }
    console.error(rows.length === 0 ? `（${since ? `自 ${new Date(sinceTs).toISOString()} ` : ''}无异常记录）` : rows.join('\n'))
    return rows.length > 0 ? 0 : 1
  }

  // --trace / --cycle 都落到轨迹记录上，只是匹配键不同：
  //   --trace  一次调用的完整周期（run + trace 两个键都认）
  //   --cycle  跨调用的六拍（业务键：entry_id / guard_key / fingerprint / proposal）
  const spans = readSpans(dir)
  const key = mode === 'trace' ? ['trace', 'run'] : ['entry_id', 'entryId', 'guard_key', 'guard', 'fingerprint', 'proposal', 'key']
  const hit = spans.filter((s) => key.some((k) => s[k] !== undefined && String(s[k]) === value))
  const textHits = readAll(dir, 'si.log').flatMap((f) => f.text.split('\n')).filter((l) => l.includes(value))
  if (hit.length === 0 && textHits.length === 0) {
    const msg = `没查到 ${mode}=${value} 的任何记录（${dir}）`
    if (wantJson) { process.stdout.write(`${JSON.stringify({ dir, mode, value, found: false }, null, 2)}\n`); return 1 }
    console.error(msg)
    return 1
  }
  if (wantJson) { process.stdout.write(`${JSON.stringify({ dir, mode, value, spans: hit, log_lines: textHits }, null, 2)}\n`); return 0 }
  console.error([
    `## ${mode}=${value}　命中轨迹 ${hit.length} 条 / 文本日志 ${textHits.length} 行`,
    '',
    ...hit.map((s) => `  ${s.ts} ${s.module} ${s.event}${s.duration_ms !== undefined ? ` ${s.duration_ms}ms` : ''}${s.status ? ` status=${s.status}` : ''}${s.file ? ` file=${s.file}` : ''}${s.reason ? ` reason=${s.reason}` : ''}`),
    '',
    ...(textHits.length > 0 ? ['文本日志命中:', ...textHits.map((l) => `  ${l}`)] : []),
    '',
  ].join('\n'))
  return 0
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node log-query.mjs --stats [--since 1h|1d|<ISO>] [--json]
  node log-query.mjs --errors [--since 1h|1d|<ISO>] [--json]
  node log-query.mjs --trace <traceId|runId> [--json]
  node log-query.mjs --cycle <entry_id|guard_key|fingerprint|proposal> [--json]
  通用：--config <p> --project-dir <d>
  退出码：0=查到 / 1=没查到 / 2=用法错误`)
  return 2
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('log-query.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
