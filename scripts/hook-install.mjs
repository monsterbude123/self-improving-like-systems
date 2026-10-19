#!/usr/bin/env node
/**
 * hook-install.mjs —— 宿主钩子接线脚手架 + 接线体检（零项目耦合，宿主可跑）
 *
 * **为什么需要它**：2026-10-18 实测，本仓 PostToolUseFailure 钩子「配好了、
 * `hooks.loadHooks OK`、脚本手工跑也正常、事件在触发（rollout 里 7799 次）」，
 * 但事件库零新增 —— 事件数小时**看起来一切正常**，只有停下来查账才发现整条失败路径哑火。
 * 手工接线有四个必踩的坑（见下方 PITFALLS），本脚本把它们做成机器判据：
 *   --doctor  体检：对着各仓 `.zcode/config.json` 逐条判，**静默失效当场报出**
 *   （默认）    只吐接线片段到 stdout，不碰任何文件 —— 接线是机器本地的，
 *               各仓 `.zcode/config.json` 被 exclude、不入库，片段才是可复用的权威
 *   --apply   直接把片段写进 `--project-dir` 的配置（已存在的条目**不动**，只增缺的那些）
 *
 * **体检查得出 / 查不出的**（重要，不要误用）：
 *   查得出 = 配置层错误：开关没开 / 事件名非法 / 类型与字段错配 / 超时单位错 /
 *           插件专有变量用在配置钩子上 / 引用了不存在的脚本 —— 这些都是**静态**可判的。
 *   查不出 = 运行时投递失败：钩子配得完全合法、事件也在触发，但宿主没把载荷喂到
 *           脚本（`--text -` 拿到空 stdin）。**这类只能靠 `--diag` 探针在运行期观察**：
 *           探针文件见 capture.mjs 的三段式留痕（invoked / stdin / exit）。
 *           所以本脚本的体检结论必须配一句「配置合法 ≠ 事件已落库，仍需探针确认」，
 *           否则体检本身就会变成 LRN-20261018-001 那种「看起来有防护但从没生效」。
 *
 * 退出码：0 = 通过 / 1 = 体检发现配置层问题 / 2 = 用法错误。
 * O(1) spawn：全部判定进程内完成，零子进程。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 七事件全集 —— 写错任何一个，钩子永远不触发且**无任何报错**（宿主静默跳过）。 */
const EVENT_NAMES = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop',
]
/**
 * 每类事件各自允许的钩子字段 —— 字段与 type 错配时**钩子被整个丢弃**，同样静默。
 * `enabled` 是宿主容忍的扩展键（各仓普遍在用，关单个钩子），不算错配，故两型都放行。
 */
const FIELDS_BY_TYPE = {
  command: ['type', 'command', 'shell', 'timeout', 'timeoutMs', 'statusMessage', 'async', 'enabled'],
  process: ['type', 'command', 'args', 'timeoutMs', 'statusMessage', 'enabled'],
}
/** 仅插件钩子可用的模板变量；用在配置钩子上会**在钩子内部直接报错**。 */
const PLUGIN_ONLY_VARS = ['${CLAUDE_PLUGIN_ROOT}', '${ZCODE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}']
const CONFIG_VARS = ['${CLAUDE_PROJECT_DIR}', '${ZCODE_PROJECT_DIR}', '${CLAUDE_SESSION_ID}']

/**
 * 从项目实例配置里解析「运行期工作目录」（探针落点）。
 *
 * **为什么不硬编码路径**：本技能是通用件，`approve.test.mjs` 的「零项目耦合」扫描
 * 会把脚本里出现的项目路径判为违规（注释已剥离，只看可执行/用户可见字符串）。
 * 探针必须与事件库同处一个被 exclude 的工作目录，所以路径**从各仓 `.self-improving.yaml`
 * 的 `storage.events_dir` 反推**（取其父目录）—— 配置链是 SSOT，技能不复制第二份。
 * 读不到配置时回落到 events 同级，仍是配置派生而非硬编码。
 */
function resolveWorkDir(projectDir) {
  if (!projectDir) return '${ZCODE_PROJECT_DIR}'
  const cfg = path.join(path.resolve(projectDir), '.self-improving.yaml')
  try {
    const m = /^[ \t]*events_dir:[ \t]*(\S+)/m.exec(readFileSync(cfg, 'utf8'))
    if (m) return path.dirname(m[1].replace(/\\/g, '/'))
  } catch { /* 读不到就退回项目目录，仍是配置派生 */ }
  return '.'
}

/**
 * 接线片段（权威副本；`references/hook-wiring*.json` 是同一份的机器可读形态）。
 * 刻意全部用 `type: command` + `node` 显式解释器：
 *   ① 跨平台 —— command 走 shell，POSIX 语法在 Windows 上会炸，故脚本本体是 .mjs 由 node 跑；
 *   ② **可诊断** —— 失败事件那条挂 `--diag`，运行期一眼分清「没被调起 / 没喂 stdin / 没落库」。
 *      这条是 2026-10-18 付了整轮排查代价换来的：配置全对但事件库零新增时，
 *      没有探针就只能在三种解释之间猜，而三者的修法完全相反。
 *
 * @param {string|null} projectDir 仅用于把探针路径解析成该仓的实际工作目录；
 *                              省略时片段用 `${ZCODE_PROJECT_DIR}` 相对形式，由运行期展开。
 */
function snippets(projectDir = null) {
  const S = '${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts'
  const W = projectDir ? resolveWorkDir(projectDir) : '${ZCODE_PROJECT_DIR}'
  return {
    SessionStart: {
      hooks: [{
        type: 'command',
        command: `node "${S}/hook-session-start.mjs" --project-dir "\${ZCODE_PROJECT_DIR}"`,
        timeout: 10,
        statusMessage: '预加载相关经验条目',
      }],
    },
    PostToolUse: {
      matcher: 'Bash|Write|Edit|NotebookEdit|MultiEdit|ApplyPatch',
      hooks: [{
        type: 'command',
        command: `node "${S}/hook-tool-events.mjs"`,
        timeout: 5,
        statusMessage: '记录工具事件用于批次节奏对账',
      }],
    },
    PostToolUseFailure: {
      hooks: [{
        type: 'command',
        command: `node "${S}/capture.mjs" --source tool --kind tool_error --severity error `
          + `--text - --no-block --diag "${W}/hook-probe.log"`,
        timeout: 10,
        statusMessage: '记录本轮工具失败为经验系统事件',
      }],
    },
    UserPromptSubmit: {
      hooks: [{
        type: 'command',
        command: `node "${S}/hook-user-correction.mjs"`,
        timeout: 15,
        statusMessage: '捕获用户纠正信号',
      }],
    },
    Stop: {
      hooks: [{
        type: 'command',
        command: `node "${S}/distill.mjs" --project-dir "\${ZCODE_PROJECT_DIR}"`,
        timeout: 10,
        statusMessage: '蒸馏本轮失效事件为经验草案',
      }],
    },
  }
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node hook-install.mjs                                  # 吐接线片段（零写盘）
  node hook-install.mjs --doctor --project-dir <项目目录>  # 体检各仓 .zcode/config.json
  node hook-install.mjs --apply   --project-dir <项目目录>  # 把缺失的条目补进配置
  [--json]
  退出码：0=通过 / 1=体检发现问题 / 2=用法错误`)
  return 2
}

/** 逐条判一个钩子条目；返回问题串数组（空 = 无静态问题）。 */
function checkHook(h, event, scriptDir) {
  const bad = []
  if (typeof h !== 'object' || h === null) return [`${event}: 钩子条目不是对象`]
  const t = h.type
  if (t !== 'command' && t !== 'process') {
    bad.push(`${event}: type=${JSON.stringify(t)} 非法（只允许 command / process）—— 宿主会整个丢弃该钩子且不报错`)
    return bad
  }
  const allowed = FIELDS_BY_TYPE[t]
  const extra = Object.keys(h).filter((k) => !allowed.includes(k))
  if (extra.length) bad.push(`${event}: type=${t} 不接受字段 ${extra.join(',')} —— 字段错配会让钩子被丢弃`)
  if (typeof h.command !== 'string' || h.command.trim() === '') bad.push(`${event}: command 缺失`)
  if (t === 'command' && 'timeoutMs' in h && 'timeout' in h) {
    bad.push(`${event}: timeout 与 timeoutMs 同时给，优先级为 timeoutMs，容易误以为生效的是 timeout`)
  }
  if (t === 'command' && typeof h.timeout === 'number' && h.timeout > 600) {
    bad.push(`${event}: command 钩子的 timeout 单位是**秒**，${h.timeout} 意味着 ${h.timeout / 60} 分钟`)
  }
  if (t === 'process' && typeof h.timeoutMs === 'number' && h.timeoutMs < 1000 && h.timeoutMs > 100) {
    bad.push(`${event}: process 钩子的 timeoutMs 单位是毫秒，${h.timeoutMs} 很可能本意是秒`)
  }
  const body = `${h.command ?? ''} ${JSON.stringify(h.args ?? [])}`
  for (const v of PLUGIN_ONLY_VARS) {
    if (body.includes(v)) bad.push(`${event}: 用了插件专有变量 ${v} —— 配置钩子里不展开，会在钩子内部直接报错`)
  }
  // 脚本存在性只在「路径不含模板变量」时判：路径带 ${ZCODE_PROJECT_DIR} 时宿主要到
  // 运行期才替换，静态拼不出真实路径，判它「不存在」是纯误报（2026-10-18 实测踩到）。
  if (body.includes('${')) return bad
  const script = /[A-Za-z0-9_./-]+\.(mjs|cjs|js|sh)\b/.exec(body)
  if (script && !existsSync(path.resolve(scriptDir, script[0]))) {
    bad.push(`${event}: 引用的脚本 ${script[0]} 在 ${scriptDir} 下不存在 —— 钩子必然失败`)
  }
  return bad
}

/** 体检一份配置；返回 {problems, checked, missing} */
export function doctorConfig(cfg, scriptDir) {
  const problems = []
  const hooks = cfg?.hooks
  if (!hooks || typeof hooks !== 'object') {
    return { problems: ['没有 hooks 段 —— 配置钩子一条都不会跑'], checked: 0, missing: [] }
  }
  // 头号静默失效：enabled 缺失/false 时，宿主只在「有插件贡献钩子」时才自动启用，
  // 否则全部配置钩子被静默跳过 —— 不报错、不进日志、事件库零新增。
  if (hooks.enabled !== true) {
    problems.push(`hooks.enabled=${JSON.stringify(hooks.enabled)} —— 配置钩子默认关闭，`
      + '未显式置 true 时不会运行（除非恰有插件贡献了钩子）')
  }
  const events = hooks.events
  if (!events || typeof events !== 'object') {
    return { problems: [...problems, '没有 hooks.events 段'], checked: 0, missing: [] }
  }
  let checked = 0
  for (const [event, groups] of Object.entries(events)) {
    if (!EVENT_NAMES.includes(event)) {
      problems.push(`事件名 ${event} 非法 —— 七个合法值之外的**永不触发且无报错**（${EVENT_NAMES.join('/')}）`)
      continue
    }
    if (!Array.isArray(groups)) {
      problems.push(`${event}: 事件值必须是数组`)
      continue
    }
    for (const g of groups) {
      for (const h of g?.hooks ?? []) {
        checked += 1
        problems.push(...checkHook(h, event, scriptDir))
      }
      if (g?.matcher !== undefined && typeof g.matcher === 'string') {
        try { new RegExp(g.matcher) } catch { problems.push(`${event}: matcher ${g.matcher} 不是合法正则（非法表达式永不匹配）`) }
      }
    }
  }
  const want = Object.keys(snippets())
  const missing = want.filter((e) => !(e in events))
  return { problems, checked, missing }
}

function renderDoctor(problems, missing, cfgPath) {
  console.log(`[doctor] 配置：${cfgPath}`)
  if (problems.length === 0) console.log('[doctor] ✅ 配置层无静态问题')
  else for (const p of problems) console.log(`[doctor] ❌ ${p}`)
  if (missing.length) console.log(`[doctor] ⚠️  尚未接线的事件（可选，按需补）：${missing.join(', ')}`)
  console.log('[doctor] ⚠️  配置合法 ≠ 事件已落库。运行期投递失败（宿主没把载荷喂给 `--text -`）'
    + '静态查不出，必须看 capture.mjs 的 `--diag` 探针三段留痕：')
  console.log('[doctor]     有 invoked 无 stdin → 宿主没投递载荷；有 stdin 而事件库无新增 → 脚本侧问题；')
  console.log('[doctor]     连 invoked 都没有 → 钩子没被调起（事件名 / matcher / 配置没被读到）。')
  return problems.length === 0 ? 0 : 1
}

export function main(argv) {
  let projectDir = null
  let doDoctor = false
  let doApply = false
  let asJson = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project-dir') { projectDir = argv[++i]; continue }
    if (a === '--doctor') { doDoctor = true; continue }
    if (a === '--apply') { doApply = true; continue }
    if (a === '--json') { asJson = true; continue }
    if (a === '--help' || a === '-h') { usage(''); return 0 }
    return usage(`未知参数 ${a}`)
  }
  if (!doDoctor && !doApply) {
    // 默认：只吐片段，零写盘
    if (asJson) { console.log(JSON.stringify({ hooks: { enabled: true, events: snippets() } }, null, 2)); return 0 }
    console.log(JSON.stringify({ hooks: { enabled: true, events: snippets() } }, null, 2))
    console.error('\n以上为接线片段（权威形态）。落到各仓：复制进 <仓>/.zcode/config.json 的 hooks 下，'
      + '或直接 `node hook-install.mjs --apply --project-dir <仓>`。该文件机器本地、被 exclude、不入库。')
    return 0
  }
  if (!projectDir) return usage('--doctor / --apply 须带 --project-dir')
  const root = path.resolve(projectDir)
  const cfgPath = path.join(root, '.zcode', 'config.json')

  if (doDoctor) {
    if (!existsSync(cfgPath)) {
      console.log(`[doctor] 配置不存在：${cfgPath}`)
      console.log(`[doctor] 该仓尚未接线。用 --apply 生成，或把片段手工并入。`)
      return 1
    }
    let cfg
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) }
    catch (e) { console.log(`[doctor] ❌ 配置不是合法 JSON：${e.message}`); return 1 }
    const r = doctorConfig(cfg, path.join(root, '.agents', 'skills', 'self-improving-like-systems', 'scripts'))
    if (asJson) { console.log(JSON.stringify({ config: cfgPath, ...r }, null, 2)); return r.problems.length === 0 ? 0 : 1 }
    return renderDoctor(r.problems, r.missing, cfgPath)
  }

  // --apply：只增缺失条目，既有条目一律不动（禁止覆盖别人的接线）
  if (!existsSync(cfgPath)) {
    if (asJson) { console.log(JSON.stringify({ ok: false, reason: `配置不存在：${cfgPath}` })); return 1 }
    console.log(`[apply] 配置不存在：${cfgPath}（不新建 —— 新建会覆盖该仓既有的 hooks 段，请手工并入片段）`)
    return 1
  }
  let cfg
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) }
  catch (e) { console.log(`[apply] ❌ 配置不是合法 JSON：${e.message}`); return 1 }
  cfg.hooks = cfg.hooks ?? {}
  cfg.hooks.enabled = true
  cfg.hooks.events = cfg.hooks.events ?? {}
  const added = []
  const kept = []
  for (const [event, frag] of Object.entries(snippets(root))) {
    if (cfg.hooks.events[event]) { kept.push(event); continue }
    cfg.hooks.events[event] = [frag]
    added.push(event)
  }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  console.log(`[apply] 已补：${added.length ? added.join(', ') : '(无)'}`)
  console.log(`[apply] 已存在未动：${kept.length ? kept.join(', ') : '(无)'}`)
  console.log('[apply] ⚠️ 配置改动**下个会话生效**（hooks 在会话启动时读一次），本会话验证不了。')
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  process.exitCode = main(process.argv.slice(2))
}
