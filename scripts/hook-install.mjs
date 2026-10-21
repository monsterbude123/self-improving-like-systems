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
 *   --apply   直接把片段写进 `--project-dir` 的配置（已存在的条目**不动**，只增缺的那些）。
 *             配置文件**不存在**时会新建（空配置 + hooks 段，无既有内容可覆盖）；
 *             存在但**不是合法 JSON** 时拒绝并退出 —— 那更可能是别人正在编辑的半成品，
 *             覆盖它造成的损失远大于让人手工并一次片段。
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLayerCandidate } from './lib/layer-resolve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 钩子入口 = 项目侧薄壳（项目相对路径，由宿主在会话启动时展开）。
 * 薄壳在运行期去层里找真脚本 —— 所以这份配置**可移植**（不含任何机器路径），
 * 又**正确**（层装在仓外、换了位置、clone 换成 npm，都照样跑）。
 */
export const PROJECT_SHELL_REL = '${ZCODE_PROJECT_DIR}/scripts/self-improving.mjs'

/**
 * 解析协议层脚本目录 —— **指向真正装着协议层的那一份**。
 *
 * ## 查找顺序（2026-10-21 统一）
 *
 * 委托给 {@link resolveLayerCandidate}（`scripts/lib/layer-resolve.mjs`）的单一顺序：
 * env 显式 → 宿主 `~/.agents/skills/<name>`（clone 副本）→ npm 全局目录（npm 副本）
 * → **协议层自身**（源码仓 / npx 临时目录）。
 *
 * ## 为什么不再「项目内优先」（2026-10-21 改）
 *
 * 原实现是「项目内 → 全局 → 自身」，理由是「接入方显式 vendor 一份协议层 = 这个项目要独立演进」。
 * 但那份 vendor 副本同时是**两份事实源**的来源：改了一份忘了另一份，
 * 门禁判的和提交里跑的不是同一份判据。协议层的形态纪律已经明确
 * 「层装在仓外、项目侧只留薄壳」，所以项目内副本**不该**被选中。
 *
 * ## 为什么必须解析真实位置（这正是 2026-10-21 修掉的静默失效）
 *
 * 原实现生成的接线片段写死 `${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts/...`
 * —— 即「协议层在项目内」的假设。而层迁到仓外（全局安装）后，这个路径**不存在**，
 * 钩子每次都失败，而体检器只核对「脚本名在解析到的层目录里在不在」、
 * **从不核对命令里写的那个路径在不在** ⇒ 体检判绿、钩子全哑。
 * 现在生成的片段指向**解析到的真实目录**，体检也按**命令里写的路径**核对。
 */
export function resolveSkillScriptsDir(projectDir) {
  const hit = resolveLayerCandidate()
  if (hit !== null) return path.join(hit.dir, 'scripts')
  return HERE
}

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
  // 钩子入口 = **项目侧薄壳**（项目相对路径），薄壳在运行期去层里找真脚本。
  //
  // 为什么绕这一圈（2026-10-21 修两个静默失效）：
  //   ① 写死层的绝对路径 → 宿主配置里留下「某台机器的目录布局」，配置不可移植；
  //      而宿主配置一旦被提交进仓，别的机器 clone 下来就指向一个不存在的目录。
  //   ② 写「层在项目内」（`${ZCODE_PROJECT_DIR}/.agents/skills/<层名>/scripts/…`）→
  //      层装在仓外时那条路径根本不存在，钩子每次都失败（实测主仓就这样哑了 25 小时，
  //      而体检只核对脚本名、从不核对命令里写的路径 ⇒ 体检全绿）。
  // 走薄壳，两个问题同时没有：配置里只有项目相对路径（可移植），运行期按层**实际所在**去找。
  const S = PROJECT_SHELL_REL
  const W = projectDir ? resolveWorkDir(projectDir) : '${ZCODE_PROJECT_DIR}'
  // 每个事件的值是**数组**（一组匹配组），不是单个对象 —— 宿主的 `hooks.events.<Event>`
  // 契约就是数组，本仓在跑的 `.zcode/config.json` 与权威形态 `references/hook-wiring.json`
  // 也都是数组。此前这里吐的是对象，形状与宿主、与自己的 doctorConfig 判据三方对不上：
  // 同事照着「跑 hook-install 并入片段」这条官方路径接线，再跑 `--doctor` 会拿到五条
  // 「事件值必须是数组」，而片段本身若并进真实配置则不会被宿主匹配到 —— 静默零投递。
  return {
    SessionStart: [{
      hooks: [{
        type: 'command',
        command: `node "${S}" hook-session-start --project-dir "\${ZCODE_PROJECT_DIR}"`,
        timeout: 10,
        statusMessage: '预加载相关经验条目',
      }],
    }],
    PostToolUse: [{
      matcher: 'Bash|Write|Edit|NotebookEdit|MultiEdit|ApplyPatch',
      hooks: [{
        type: 'command',
        command: `node "${S}" hook-tool-events`,
        timeout: 5,
        statusMessage: '记录工具事件用于批次节奏对账',
      }],
    }],
    PostToolUseFailure: [{
      hooks: [{
        type: 'command',
        command: `node "${S}" capture --source tool --kind tool_error --severity error `
          + `--text - --no-block --diag "${W}/hook-probe.log"`,
        timeout: 10,
        statusMessage: '记录本轮工具失败为经验系统事件',
      }],
    }],
    UserPromptSubmit: [{
      hooks: [{
        type: 'command',
        command: `node "${S}" hook-user-correction`,
        timeout: 15,
        statusMessage: '捕获用户纠正信号',
      }],
    }],
    Stop: [{
      hooks: [{
        type: 'command',
        command: `node "${S}" distill --project-dir "\${ZCODE_PROJECT_DIR}"`,
        timeout: 10,
        statusMessage: '蒸馏本轮失效事件为经验草案',
      }],
    }],
  }
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node hook-install.mjs                                  # 吐接线片段（零写盘）
  node hook-install.mjs --doctor --project-dir <项目目录>  # 体检各仓 .zcode/config.json
  node hook-install.mjs --apply   --project-dir <项目目录>  # 把缺失的条目补进配置
  [--scripts-dir <协议层 scripts 目录>]  # 只影响 --doctor 的核对基准（默认自动解析）
  [--json]
  退出码：0=通过 / 1=体检发现问题 / 2=用法错误`)
  return 2
}

/**
 * 从钩子命令里抽出「会被执行的那个脚本路径」。
 *
 * 三层形态，顺序不能乱：
 *   ① `project-relative` —— `${ZCODE_PROJECT_DIR}/<相对路径>`：运行期展开后就是项目里的那个路径；
 *   ② `absolute` —— `C:/…` 或 `/…`：原样就是绝对路径；
 *   ③ `loose` —— 其余形如 `dir/x.mjs` 的相对路径：按协议层目录解。
 *
 * @returns {{kind:'project-relative'|'absolute'|'loose', path:string}|null}
 */
export function extractScriptPath(body) {
  const proj = /\$\{(?:ZCODE|CLAUDE)_PROJECT_DIR\}\/([^\s"']+?\.(?:mjs|cjs|js|sh))/.exec(body)
  if (proj) return { kind: 'project-relative', path: proj[1] }
  const abs = /(?:[A-Za-z]:[\\/]|\/)[^\s"']*?\.(?:mjs|cjs|js|sh)/.exec(body)
  if (abs) return { kind: 'absolute', path: abs[0] }
  const loose = /[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:mjs|cjs|js|sh)\b/.exec(body)
  if (loose) return { kind: 'loose', path: loose[0] }
  return null
}

/**
 * 逐条判一个钩子条目；返回问题串数组（空 = 无静态问题）。
 *
 * @param {object} h 钩子条目
 * @param {string} event 事件名
 * @param {string} scriptDir 解析到的协议层 scripts 目录
 * @param {string|null} projectRoot 项目根 —— 判「项目相对路径」时必需
 */
function checkHook(h, event, scriptDir, projectRoot) {
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
  // 脚本路径存在性：**按命令里写的那个路径判**（2026-10-21 修静默失效）。
  //
  // 旧口径只核对「脚本名在解析到的层目录里在不在」，**从不核对命令实际指向的路径**。
  // 于是「层迁出仓外、配置还指着项目内那份已删的副本」这种形态**体检全绿、钩子每次失败** ——
  // 实测本机就是这样哑了 25 小时（事件库停在 10-20 18:16，条目却还在长）。
  // 现在三条形态各按各的基准判：
  //   ① 项目相对（`${ZCODE_PROJECT_DIR}/…`）→ 按**项目根**解（运行期就是这么展开的）；
  //   ② 绝对路径 → 原样判；
  //   ③ 其余相对路径 → 按协议层 scripts 目录解。
  const sp = extractScriptPath(body)
  if (sp) {
    if (sp.kind === 'project-relative') {
      if (!projectRoot) {
        bad.push(`${event}: 命令含项目相对脚本路径 ${sp.path}，但未提供项目根 —— 无法核对它是否存在`)
        return bad
      }
      const abs = path.resolve(projectRoot, sp.path)
      if (!existsSync(abs)) {
        bad.push(`${event}: 命令指向 ${abs} —— 该文件不存在，钩子必然失败`
          + `（协议层装在仓外时，钩子应指向真实层目录而不是项目内副本）`)
      }
      return bad
    }
    if (sp.kind === 'absolute') {
      if (!existsSync(sp.path)) {
        bad.push(`${event}: 命令指向 ${sp.path} —— 该文件不存在，钩子必然失败`)
      }
      return bad
    }
    if (!existsSync(path.resolve(scriptDir, sp.path))) {
      bad.push(`${event}: 引用的脚本 ${sp.path} 在 ${scriptDir} 下不存在 —— 钩子必然失败`)
    }
    return bad
  }
  return bad
}

/** 体检一份配置；返回 {problems, checked, missing} */
/**
 * 体检一份配置。
 *
 * @param {object} cfg 配置对象
 * @param {string} scriptDir 解析到的协议层 scripts 目录
 * @param {string|null} projectRoot 项目根 —— 判「项目相对脚本路径」时必需
 * @returns {{problems:string[], checked:number, missing:string[]}}
 */
export function doctorConfig(cfg, scriptDir, projectRoot = null) {
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
      // 形状错一层（`[[{hooks:[…]}]]` 而不是 `[{hooks:[…]}]`）时，宿主读到的那一层是数组，
      // 取不到 `hooks` 字段 ⇒ 整条事件被静默忽略：配置看着齐、宿主一条都不匹配、事件永远不投递。
      // 2026-10-21 实测：本仓的 `hook-install --apply` 一直产出这个形状 —— 也就是说
      // 「跑一次 --apply 就接上了线」这条路**从来没通过**。这里把它判红。
      if (Array.isArray(g)) {
        problems.push(`${event}: 事件值多包了一层数组（应为 [{hooks:[…]}]，实为 [[{hooks:[…]}]]）`
          + ' —— 宿主读不到 hooks 字段，整条事件被静默忽略')
        continue
      }
      for (const h of g?.hooks ?? []) {
        checked += 1
        problems.push(...checkHook(h, event, scriptDir, projectRoot))
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
  let scriptsDir = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project-dir') { projectDir = argv[++i]; continue }
    if (a === '--doctor') { doDoctor = true; continue }
    if (a === '--apply') { doApply = true; continue }
    if (a === '--json') { asJson = true; continue }
    if (a === '--scripts-dir') {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) return usage('--scripts-dir 后须跟目录')
      scriptsDir = path.resolve(next)
      continue
    }
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
    const r = doctorConfig(cfg, scriptsDir ?? resolveSkillScriptsDir(root), root)
    if (asJson) { console.log(JSON.stringify({ config: cfgPath, ...r }, null, 2)); return r.problems.length === 0 ? 0 : 1 }
    return renderDoctor(r.problems, r.missing, cfgPath)
  }

  // --apply：只增缺失条目，既有条目一律不动（禁止覆盖别人的接线）
  const r = applyHooks(root)
  for (const l of r.lines) console.log(l)
  return r.ok ? 0 : 1
}

/**
 * 把缺失的钩子条目补进 `<projectDir>/.zcode/config.json`（**只增不减**）。
 *
 * 抽成导出函数是为了让一键接入命令（install-project.mjs）复用同一套接线逻辑 ——
 * 接线只有一份实现。否则「命令手工接的」和「安装器接的」会长得不一样，
 * 而那种差异要等到某天钩子不触发时才被发现。
 *
 * @param {string} projectDir 项目根
 * @returns {{ok:boolean, created:boolean, added:string[], kept:string[], lines:string[]}}
 */
export function applyHooks(projectDir) {
  const root = path.resolve(projectDir)
  const cfgPath = path.join(root, '.zcode', 'config.json')
  let cfg = null
  let created = false
  if (!existsSync(cfgPath)) {
    // 原实现在这里一律拒绝，理由写的是「新建会覆盖该仓既有的 hooks 段」。
    // 那条理由对「文件存在但解析失败」成立，对**文件根本不存在**不成立：
    // 不存在的文件没有任何内容可覆盖，`--apply` 新建它不可能弄丢任何东西。
    // 一律拒绝的实际后果是 2026-10-20 实测到的死局：一个全新项目（有 `.git`、
    // 无 `.zcode/`）永远接不上线 —— 而「协议层能被别的项目接进去」正是本仓存在的理由。
    // 所以这里区分两种情况：文件不存在 → 建空配置再接线（并如实报告这是新文件）；
    // 文件存在 → 走原有的「解析失败即拒绝」，绝不覆盖别人的配置。
    cfg = {}
    created = true
  } else {
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) }
    catch (e) {
      return { ok: false, created: false, added: [], kept: [], lines: [
        `[apply] ❌ 配置存在但不是合法 JSON：${e.message}`,
        `[apply]   ${cfgPath}`,
        '[apply]   不覆盖它 —— 一份坏掉的配置更可能是别人正在编辑。请手工修好或手工并入片段。',
      ] }
    }
  }
  cfg.hooks = cfg.hooks ?? {}
  cfg.hooks.enabled = true
  cfg.hooks.events = cfg.hooks.events ?? {}
  const added = []
  const kept = []
  for (const [event, frag] of Object.entries(snippets(root))) {
    if (cfg.hooks.events[event]) { kept.push(event); continue }
    // `frag` **本身就已经是数组**（一组匹配组），直接赋值 —— 不能再包一层。
    // 2026-10-21 实测：旧写法 `= [frag]` 产出 `[[{hooks:[…]}]]`（双层），
    // 而宿主契约是 `events.<Event> = [{matcher?, hooks:[…]}]`（单层，见
    // references/hook-wiring.json 与本仓既有的 .zcode/config.json）。
    // 双层时宿主读到的那一层是**数组**，取不到 `hooks` 字段 ⇒ **钩子被静默忽略**：
    // 配置看着齐、宿主一条都不匹配、事件永远不投递，而没有任何报错。
    // 也就是说：`--apply` 从来没给任何人真正接上过线。
    cfg.hooks.events[event] = frag
    added.push(event)
  }
  mkdirSync(path.dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  const lines = []
  if (created) {
    lines.push(`[apply] 新建配置：${cfgPath}`)
    lines.push('[apply]   该文件此前不存在，本次只写入 hooks 段（无任何既有内容被覆盖）。')
    lines.push('[apply]   它机器本地、被 exclude、不入库 —— 同事各自在自己机器上跑一次本命令。')
  }
  lines.push(`[apply] 已补：${added.length ? added.join(', ') : '(无)'}`)
  lines.push(`[apply] 已存在未动：${kept.length ? kept.join(', ') : '(无)'}`)
  lines.push('[apply] ⚠️ 配置改动**下个会话生效**（hooks 在会话启动时读一次），本会话验证不了。')
  return { ok: true, created, added, kept, lines }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  process.exitCode = main(process.argv.slice(2))
}
