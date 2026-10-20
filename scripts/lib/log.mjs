/**
 * log.mjs —— 经验系统自身的结构化诊断日志（通用技能，零项目耦合）
 *
 * **先分清它不是什么**：本文件不是「审计」。审计（`injection-audit.jsonl` / `events/*.jsonl`）
 * 是六拍的**证据账**，append-only、逐行可对账、**绝不滚动** —— 滚一次就毁掉一批证据。
 * 日志是**诊断面**：回答「现在是不是在工作」「这一条为什么没生效」「刚才那次失败在第几步」，
 * 因此才需要分级、按大小滚动、异常独立成文件。这些特性恰恰是审计账**不能**有的。
 *
 * 三级标识（决定「grep 什么能看出一条链」）：
 *   run_id   每次进程执行一个 = **一次调用的完整周期**（含各阶段与耗时）
 *   trace_id 宿主 hook 信封自带的 `traceId`（capture 可从信封抽到）；没有就由本进程生成
 *   业务键   `fingerprint` / `entry_id` / `guard_key` / `proposal` —— **跨调用**串起六拍
 * 三者缺一不可：只有 run_id 只能看单次执行，只有业务键只能看结果看不到过程。
 *
 * 文件布局（全在 gitignored 目录下，缺配置回退 os tmpdir）：
 *   <dir>/si.log[.1..N]         全级别文本，按大小滚动
 *   <dir>/si-error.log[.1..N]   仅 error（异常**独立成文件**，主日志里不重复刷）
 *   <dir>/si-trace-YYYYMMDD.jsonl[.1..N] 结构化轨迹，按天分片 + 按大小滚动
 *
 * **fail-safe 到极致**：本模块任何异常都不得影响调用方（写不出日志 ≠ 不能干正事），
 * 与全系统 fail-open 纪律同源。故所有 IO 都包在 try/catch 里，失败即退化为「不写」。
 *
 * **热路径纪律**：capture 与 inject 有时间预算（`injection.budget_ms`），日志不得让它们变慢。
 * 故低于阈值级别**直接丢弃、不构造消息字符串**；写入用 `appendFileSync`（无 fsync），
 * 且日志目录不可用时立即短路（`_disabled = true`），后续调用零开销。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/** 级别序（数值越大越严重）。低于阈值直接丢弃，不构造消息。 */
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
export const LEVEL_NAMES = Object.keys(LEVELS)

/** 内置默认：与 config.example.yaml 的 `logging:` 段语义一致（两处同批改）。 */
export const DEFAULT_LOGGING = {
  enabled: true,
  level: 'info',
  dir: '.self-improving/logs/', // 技能默认值必须零项目耦合：不得写死任何具体仓的路径
             // （approve 套的「通用性」用例扫的就是这个；本仓实例配置各自覆盖成自己的 gitignored 路径）
  max_bytes: 2 * 1024 * 1024,
  max_files: 5,
  trace_enabled: true,
  trace_max_bytes: 5 * 1024 * 1024,
  trace_max_files: 3,
}

/** 解析 logging 配置：缺段/非法值全部回落默认（不抛，日志器永远不给调用方添麻烦）。 */
export function resolveLogging(config) {
  const l = (config && config.logging) || {}
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d)
  const lvl = typeof l.level === 'string' && LEVELS[l.level] !== undefined ? l.level : DEFAULT_LOGGING.level
  return {
    enabled: l.enabled === undefined ? DEFAULT_LOGGING.enabled : Boolean(l.enabled),
    level: lvl,
    dir: typeof l.dir === 'string' && l.dir.trim() !== '' ? l.dir : DEFAULT_LOGGING.dir,
    max_bytes: num(l.max_bytes, DEFAULT_LOGGING.max_bytes),
    max_files: num(l.max_files, DEFAULT_LOGGING.max_files),
    trace_enabled: l.trace_enabled === undefined ? DEFAULT_LOGGING.trace_enabled : Boolean(l.trace_enabled),
    trace_max_bytes: num(l.trace_max_bytes, DEFAULT_LOGGING.trace_max_bytes),
    trace_max_files: num(l.trace_max_files, DEFAULT_LOGGING.trace_max_files),
  }
}

/**
 * 日志目录解析 —— **写侧与读侧（log-query.mjs）必须得出同一个答案**。
 *
 * 2026-10-20 实测修掉的 bug：配置损坏 → `loadContext` 拿不到 `baseDir` → 日志器把内置
 * 缺省 `.self-improving/logs/` 解析到 `process.cwd()` 上。而 `log-query.mjs` 在同样情况下
 * 查的是 `fallbackLogDir()`（os tmpdir）。**写侧和读侧指向两个不同目录**：
 *   · 故障现场：注入挂了，去查日志，什么都没有（读侧看不到写侧写的东西）；
 *   · 附带污染：自检的 cwd 是协议层根，于是「故意踩 fail-open 的夹具」每跑一次自检，
 *     就往**安装目录的真实运行时日志**里塞一条与线上真故障逐字节同形的 ERROR，
 *     把可观测面变成噪声源（fail-open 按设计必须记 ERROR，降级级别是错的方向，
 *     该修的是落点）。
 *
 * 所以规则是：**没有 baseDir（配置不可用）就落 tmp 兜底目录，绝不猜 cwd**。
 * 猜 cwd 的代价是「判据污染安装目录 + 故障现场查不到日志」两条同时中。
 *
 * @param {string|null|undefined} baseDir 配置与相对路径的基准（loadContext 给的）
 * @param {string} [cfgDir] 配置里**原始的** `logging.dir`（未兜底）
 * @returns {string} 绝对路径
 */
export function resolveLogDir(baseDir, cfgDir) {
  const base = typeof baseDir === 'string' && baseDir.trim() !== '' ? baseDir : null
  const explicit = typeof cfgDir === 'string' && cfgDir.trim() !== ''
  if (explicit) return path.resolve(base || process.cwd(), cfgDir)
  if (base) return path.resolve(base, DEFAULT_LOGGING.dir)
  return fallbackLogDir()
}

/** 生成一个短 id（run_id / trace_id 兜底用）。 */
export function newId(prefix) {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

/**
 * 按大小滚动：si.log → si.log.1 → si.log.2 …，超出 max_files 的最老一份删掉。
 *
 * 用 renameSync 而不是 copy+truncate：rename 是原子的，读者永远看不到「已清空但还没写入」的
 * 空窗。Windows 上 renameSync 覆盖已存在文件亦可（REPLACE_EXISTING），两后端语义一致。
 */
function rotate(file, maxFiles) {
  try {
    let oldest = `${file}.${maxFiles}`
    if (existsSync(oldest)) rmSync(oldest, { force: true })
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${file}.${i}`
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`)
    }
    if (existsSync(file)) renameSync(file, `${file}.1`)
  } catch {
    /* 滚动失败不抛：宁可日志文件偏大，也不能让调用方因为日志失败 */
  }
}

/** 当前文件是否已到上限（含即将写入的这行是否越界 —— 提前判断，不写完再发现）。 */
function needsRotate(file, incomingBytes, maxBytes) {
  try {
    if (!existsSync(file)) return false
    return statSync(file).size + incomingBytes > maxBytes
  } catch {
    return false
  }
}

/**
 * 建一个 logger。
 *
 * @param {object} o
 * @param {string} o.module 模块名（capture / inject / distill / run-guard / verify / approve / trace / hook）
 * @param {string|null} [o.baseDir] 配置与日志目录的基准（= loadContext 里的 baseDir）。
 *   **刻意不用 `process.cwd()` 兜底**：没有 baseDir 说明配置不可用，此时该落 tmp 兜底目录
 *   （见 resolveLogDir），猜 cwd 会污染安装目录、且与读侧对不上。
 * @param {object} [o.config] 已解析的实例配置（读 `logging:` 段）
 * @param {string} [o.traceId] 上游 trace id（capture 从宿主信封抽到的）
 * @param {string} [o.runId] 本次进程执行的 run id
 * @returns {{debug:Function,info:Function,warn:Function,error:Function,runId:string,traceId:string,
 *            child:Function, span:Function, disabled:boolean}}
 */
export function createLogger({ module, baseDir = null, config = null, traceId = null, runId = null } = {}) {
  const cfg = resolveLogging(config)
  const run = runId || newId('run')
  const trace = traceId || newId('trc')
  const threshold = LEVELS[cfg.level] ?? LEVELS.info
  // 传**原始** config.logging.dir 而非 resolveLogging 兜底后的 cfg.dir：
  // 兜底后它永远非空，env 就再也顶不掉兜底落点，隔离等于没做。
  const dir = resolveLogDir(baseDir, config && config.logging ? config.logging.dir : '')
  const disabled = cfg.enabled === false

  // 目录建不出来 / 无写权限 → 立即短路，后续每次调用只做一次布尔判断（零 IO）
  if (!disabled) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* 退化为不写 */ }
  }

  const write = (file, line, maxBytes) => {
    try {
      if (needsRotate(file, Buffer.byteLength(line), maxBytes)) rotate(file, cfg.max_files)
      appendFileSync(file, line, 'utf8')
    } catch { /* 不写 */ }
  }

  const fmt = (level, msg, fields, err) => {
    const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `run=${run}`, `trace=${trace}`, `mod=${module}`]
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue
        parts.push(`${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : String(v)}`)
      }
    }
    if (err) parts.push(`err=${err && err.code ? err.code : ''}${err && err.message ? `:${err.message}` : ''}`)
    if (err && err.stack) parts.push(`stack=${JSON.stringify(String(err.stack).split('\n').slice(0, 3).join(' | '))}`)
    return `${parts.join(' ')} ${msg}\n`
  }

  const emit = (level, msg, fields, err) => {
    if (disabled || LEVELS[level] < threshold) return // 热路径：低级别连字符串都不构造
    const line = fmt(level, msg, fields, err)
    write(path.join(dir, 'si.log'), line, cfg.max_bytes)
    // 异常独立成文件：主日志仍留一行（便于按时间线定位），但 error 文件只收 error，
    // 「今天有没有出事」扫一个文件就够，不必在几万行主日志里 grep。
    if (level === 'error') write(path.join(dir, 'si-error.log'), line, cfg.max_bytes)
  }

  const logger = {
    disabled,
    runId: run,
    traceId: trace,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, err, fields) => emit('error', msg, fields, err),

    /** 派生子 logger：共享同一 run_id / trace_id，只换 module 与附加字段（一次调用里的多模块）。 */
    child: (childModule, extra = {}) => createLogger({ module: childModule, baseDir, config, traceId: trace, runId: run, ...extra }),

    /**
     * 结构化轨迹记录（si-trace-YYYYMMDD.jsonl）。
     * 与文本日志的分工：文本给人看，轨迹给机器看 —— `log-query.mjs` 靠它按 trace_id /
     * 业务键把跨调用的六拍串起来，grep 文本日志做不到这种结构化检索。
     */
    span: (event, fields = {}) => {
      if (disabled || !cfg.trace_enabled) return
      try {
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        const file = path.join(dir, `si-trace-${day}.jsonl`)
        const rec = { ts: new Date().toISOString(), run: run, trace: trace, module, event, host: hostname(), ...fields }
        const line = `${JSON.stringify(rec)}\n`
        if (needsRotate(file, Buffer.byteLength(line), cfg.trace_max_bytes)) rotate(file, cfg.trace_max_files)
        appendFileSync(file, line, 'utf8')
      } catch { /* 不写 */ }
    },

    /** 取日志目录（查询 CLI 用；日志关闭时回退 tmpdir，保持可查）。 */
    dir,
  }
  return logger
}

/**
 * 包一次执行：自动记 span(begin) / span(end，含 status + duration_ms)。
 * 「一次调用」是这套日志的基本单元，漏了它就无法回答「这次跑成功没有、花了多久」。
 *
 * @param {object} logger
 * @param {string} name span 名（如 'capture.run' / 'inject.rank'）
 * @param {() => any} fn
 * @returns {any} fn 的返回值
 */
export function withSpan(logger, name, fn) {
  const t0 = Date.now()
  logger.span(`${name}.begin`)
  try {
    const r = fn()
    logger.span(`${name}.end`, { status: 'ok', duration_ms: Date.now() - t0 })
    return r
  } catch (e) {
    logger.span(`${name}.end`, { status: 'error', duration_ms: Date.now() - t0 })
    logger.error(`${name} 异常`, e)
    throw e
  }
}

/** 列出日志目录下所有文件（查询 CLI 用；目录不存在时返回空数组，不抛）。 */
export function listLogFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.startsWith('si.') || f.startsWith('si-trace-')).sort()
  } catch {
    return []
  }
}

/** 配置未指定日志目录时的兜底（fail-open：配置不可用也要能写日志）。 */
export function fallbackLogDir() {
  return path.join(tmpdir(), 'self-improving-logs')
}
