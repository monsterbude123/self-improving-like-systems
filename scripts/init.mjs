#!/usr/bin/env node
/**
 * init.mjs —— 接入一个项目：铺一份最小可用实例配置
 *
 * 形态纪律（承自本技能其余 CLI）：
 *   · **默认零写盘** —— 不带 `--apply` 时只打印「将要落什么」，与 `approve.mjs --dry-run` 同一条纪律。
 *     接入方第一次跑它时大概率还在看，不该因为「试一下」就在仓里留下文件。
 *   · **只增缺失，绝不覆盖** —— 已存在的文件一律不动。这比「写前比对内容是否相同」更强：
 *     人改过的 scope / 路径在第二次跑时原样保留，不存在「以为没改其实覆盖了」的情形。
 *   · **唯一有写盘副作用的子命令** —— 接线、捕获、蒸馏、批准都各有 `--apply`/`--approve` 一类的显式开关，
 *     本命令是其中唯一一个「一次铺一套」的，故开关取同名 `--apply`。
 *   · **fail-closed 的文本替换** —— 配置从 `config.example.yaml` 派生（模板是形状的单一权威，
 *     本文件不自造第二份 YAML 结构）。替换逐条断言「命中且只命中一次」，少一条就报错退出：
 *     模板改了形状而本表没跟上时，静默产出半成品配置比直接失败糟得多。
 *
 * 退出码：0=成功 / 1=前置事实不满足（模板缺关键行、项目路径不可写）/ 2=用法错误
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { atomicWrite } from './lib/atomic-file.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 协议层根 = 本文件所在目录的上一级（init.mjs 住在 scripts/ 下）。 */
export const PROTOCOL_ROOT = path.resolve(HERE, '..')
const CONFIG_TEMPLATE = path.join(HERE, 'config.example.yaml')
const REGISTRY_TEMPLATE = path.join(HERE, 'registry.example.yaml')
/** 项目侧薄壳模板 —— 一字不改地复制进项目（它是「层在哪 / 怎么跑 / 怎么判装没装好」的入口）。 */
const SHELL_TEMPLATE = path.join(HERE, 'project-side', 'self-improving.mjs')

/** 项目侧薄壳在项目里的相对位置。 */
export const SHELL_REL = 'scripts/self-improving.mjs'

/**
 * 接入后的目录分工（与本技能在真实项目上验证过的布局同构）：
 *   `<tracked>/`      条目、注册表、归档 —— 永久知识库，进 git
 *   `<work>/`         事件、提案暂存、守卫态、审计 —— 运行时数据，必须 gitignored
 * 分层的原因只有一个：混在一起时，运行时数据每次跑都让 `git status` 不干净，
 * 而「跑完仓库就不干净」会让人直接放弃接线。
 */
export const TRACKED_ROOT = '.self-improving'
export const WORK_ROOT = '.self-improving-work'

/** 生成后必须写进 exclude 的运行时目录（**只提示，不代改** `.git/info/exclude`）。 */
export const EXCLUDE_SUGGESTION = `${WORK_ROOT}/`

/**
 * 展示用相对路径一律归一成正斜杠。
 * 落盘交给 `path.join` 自己处理分隔符；只有**给人看的**和**要进配置/清单的**需要归一 ——
 * Windows 上 `path.join` 产出反斜杠，直接印出来会让人以为配置里就该写反斜杠，
 * 而这份配置是要照抄进别的系统的。
 */
function posixRel(p) {
  return p.split(path.sep).join('/')
}

/**
 * 配置派生替换表。`from` 必须是模板里的**精确单行**（audit 块除外），命中数必须恰为 1。
 * 每条都写明「为什么必须换」—— 后人改模板时才知道哪些是不可省的自定义项。
 */
const REPLACEMENTS = [
  {
    key: 'scope.values',
    from: '  values: [infra, testing, git, data-ui, model, kb, other]',
    to: [
      '  # ⚠️ TODO(必填)：下面这组是**模板示例**，不是你这个项目的主题分类。',
      '  #    取值应与你的真实语料分类同构（否则召回会按错域命中）。',
      '  #    改完记得同步 scope.default —— 它必须在 values 内，否则 validate.mjs 判红。',
      '  values: [infra, testing, git, data-ui, model, kb, other]',
    ].join('\n'),
    why: '标出待人填；值本身保留模板默认，保证生成立即可通过校验（fail-safe 桶 other 永不自动注入）',
  },
  {
    key: 'storage.events_dir',
    from: '  events_dir: .self-improving/events/',
    to: '  events_dir: .self-improving-work/events/',
    why: '运行时数据不得落在 git-tracked 目录下',
  },
  {
    key: 'storage.proposals_dir',
    from: '  proposals_dir: .self-improving/proposals/',
    to: '  proposals_dir: .self-improving-work/proposals/',
    why: '同上；草案只落暂存区，正式区必须保持 git 干净',
  },
  {
    key: 'storage.guard_state',
    from: '  guard_state: .self-improving/guard-state.json',
    to: '  guard_state: .self-improving-work/guard-state.json',
    why: '每次 commit 都变的字段进仓会造成 churn',
  },
  {
    key: 'storage.audit_log',
    from: [
      '  # ⚠️ 下面这个默认值**不可照抄**：它落在 `.self-improving/`（该目录装 registry.yaml，是 git-tracked），',
      '  #    而审计日志是运行时数据、必须 gitignored。照抄的后果实测过：任何一次探针跑完，',
      '  #    `git status` 就多出一个 `?? .self-improving/audit.jsonl`，仓内立刻不干净。',
      '  #    项目复制本模板后**必须**把本键改成自己仓里已被 ignore 的路径（事件/审计/守卫态同一条纪律）。',
      '  audit_log: .self-improving/audit.jsonl',
    ].join('\n'),
    to: [
      '  # ✅ 本行已由 init.mjs 改写到 gitignored 的工作目录 —— 模板里「不可照抄」的那个默认值已落实。',
      '  #    若你手动搬动过这些目录，记得三处（events / proposals / guard_state / audit_log）同步改。',
      '  audit_log: .self-improving-work/audit.jsonl',
    ].join('\n'),
    why: '模板的默认值本身是「反例示范」，照抄必然让仓不干净；init 既然已经落实分层，就把那段警告替换成结论',
  },
]

/** 生成头：写进产物顶部，交代 init 替人做了什么、还剩什么要人做。 */
function header(workRoot) {
  return [
    '# .self-improving.yaml —— 由 init.mjs 从 scripts/config.example.yaml 派生，请勿当作手写文件',
    '#',
    '# init 已替你做好的：',
    `#   · 目录分层：永久知识库在 ${TRACKED_ROOT}/（进 git），运行时数据在 ${workRoot}/（须 gitignored）`,
    '#   · kill_switch 三开关保持 false —— 开关必须先于它防的风险存在，接线后再逐条打开',
    '#',
    '# 还需要你做的：',
    '#   1. 填 scope.values（下面有 TODO 标记），并确认 scope.default 在 values 内',
    `#   2. 把 ${workRoot}/ 加进 .git/info/exclude 或 .gitignore（init 只提示，不代改）`,
    '#   3. 接线：node <协议层>/scripts/hook-install.mjs --doctor --project-dir <项目目录>',
    '#   4. 跑一次自检确认判据在跑，再逐条打开 kill_switch',
    '',
  ].join('\n')
}

/**
 * 从模板渲染实例配置。
 * @param {string} templateText 模板原文
 * @returns {string} 渲染结果
 * @throws {Error} 任一替换未命中或命中多次（fail-closed：宁可不产出，也不产出半成品）
 */
export function renderConfig(templateText) {
  let out = templateText
  for (const { key, from, to, why } of REPLACEMENTS) {
    const hits = out.split(from).length - 1
    if (hits !== 1) {
      throw new Error(
        `配置模板形状已变：${key} 的替换项命中 ${hits} 次（须恰好 1 次）。` +
        `这条替换的作用是「${why}」。` +
        `请同步 scripts/init.mjs 的 REPLACEMENTS 与 scripts/config.example.yaml —— ` +
        `静默产出半成品配置比直接失败糟得多。`,
      )
    }
    out = out.replace(from, to)
  }
  return header(WORK_ROOT) + out
}

/** 读模板并渲染（模板自身缺失 = 协议层装坏了，属阻塞）。 */
export function renderConfigFromTemplate() {
  if (!existsSync(CONFIG_TEMPLATE)) {
    throw new Error(`配置模板缺失：${CONFIG_TEMPLATE} —— 协议层不完整，重装后再试`)
  }
  return renderConfig(readFileSync(CONFIG_TEMPLATE, 'utf8'))
}

/** 读 registry 模板（空表骨架）。 */
export function renderRegistry() {
  if (!existsSync(REGISTRY_TEMPLATE)) {
    throw new Error(`注册表模板缺失：${REGISTRY_TEMPLATE} —— 协议层不完整，重装后再试`)
  }
  return readFileSync(REGISTRY_TEMPLATE, 'utf8')
}

/**
 * 接入项目后判据自检的 npm script 值。
 *
 * 两条约束各消一个具体故障：
 *   · 路径走正斜杠 —— node 在 Windows 上同样接受，而正斜杠进 JSON 不用转义反斜杠，
 *     少一层「在别的机器上路径写法变了就坏」的机会。
 *   · **只有路径含空白才加引号**，加了必须按 JSON 规则转义 —— 否则生成的片段
 *     `"k": "node "C:/a b/run-tests.mjs""` 是坏 JSON，粘进 package.json 直接解析失败。
 */
export function selfTestScript() {
  const p = posixRel(path.join(PROTOCOL_ROOT, 'scripts', 'run-tests.mjs'))
  return /\s/.test(p) ? `node "${p}"` : `node ${p}`
}

/**
 * 计算要落的东西（纯函数，不碰盘）。
 * @param {string} projectDir 接入项目根
 * @returns {Array<{path:string, abs:string, exists:boolean, kind:string, content:string}>}
 */
export function planInit(projectDir) {
  const items = []
  const push = (rel, kind, content) => {
    const abs = path.join(projectDir, rel)
    items.push({ path: posixRel(rel), abs, kind, exists: existsSync(abs), content })
  }
  push('.self-improving.yaml', 'config', renderConfigFromTemplate())
  push(path.join(TRACKED_ROOT, 'registry.yaml'), 'registry', renderRegistry())
  // 项目侧薄壳：没有它，宿主钩子就没有入口（接线片段指向它），项目也不知道「层怎么用」。
  // 2026-10-21 补：此前薄壳由接入项目各写一份 → 每个项目都手抄一遍「层在哪、怎么更新」。
  if (!existsSync(SHELL_TEMPLATE)) {
    throw new Error(`项目侧薄壳模板缺失：${SHELL_TEMPLATE} —— 协议层不完整，重装后再试`)
  }
  push(SHELL_REL, 'shell', readFileSync(SHELL_TEMPLATE, 'utf8'))
  return items
}

/**
 * 执行落盘：只增缺失。
 * @returns {{written:string[], skipped:string[]}}
 */
export function applyInit(projectDir) {
  const items = planInit(projectDir)
  const written = []
  const skipped = []
  for (const it of items) {
    if (it.exists) { skipped.push(it.path); continue }
    mkdirSync(path.dirname(it.abs), { recursive: true })
    atomicWrite(it.abs, it.content)
    written.push(it.path)
  }
  return { written, skipped }
}

/** npm script 的键名。 */
export const NPM_SCRIPT_KEY = 'test:self-improving'

/** 建议片段。**永不代改 package.json**：清单文件由包的版本管理覆盖，脚本被 agent 悄悄塞进去不容易发现。 */
export function npmScriptSuggestion(projectDir) {
  // 片段必须是**可被 JSON.parse 接受**的一行 —— 用户会整行粘进 package.json，
  // 粘坏的表现是 package.json 整体解析失败（连带整个包起不来），代价远高于少个自检脚本。
  const snippet = JSON.stringify({ [NPM_SCRIPT_KEY]: selfTestScript() }).slice(1, -1).trim()
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return `该项目没有 package.json —— 请手工并入你实际的清单文件：\n    ${snippet}`
  }
  const text = readFileSync(pkgPath, 'utf8')
  if (text.includes(`"${NPM_SCRIPT_KEY}"`)) return `package.json 已有 "${NPM_SCRIPT_KEY}"，未改动`
  return `建议在 scripts 段加入（init 不代改清单文件）：\n    ${snippet}`
}

export function main(argv) {
  let projectDir = null
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') { apply = true; continue }
    if (a === '--project-dir') {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) return usage('--project-dir 后须跟目录')
      projectDir = path.resolve(next)
      continue
    }
    return usage(`未知参数 ${a}`)
  }
  if (!projectDir) return usage('--project-dir 必填（本命令只在明确的接入目标上动作，不猜 cwd）')
  if (!existsSync(projectDir)) return fail(`项目目录不存在：${projectDir}`)

  let plan
  try {
    plan = planInit(projectDir)
  } catch (e) {
    return fail(e.message)
  }

  const todo = plan.filter((p) => !p.exists)
  const npm = npmScriptSuggestion(projectDir)

  if (!apply) {
    console.log(`[init] 演练模式（零写盘）。将要落 ${todo.length} 个文件：`)
    for (const p of todo) console.log(`  + ${p.path}`)
    for (const p of plan.filter((p) => p.exists)) console.log(`  · ${p.path} 已存在，保持不动`)
    console.log('\n[init] 需要你手工做的：')
    console.log(`  · 把 ${EXCLUDE_SUGGESTION} 加进 .git/info/exclude 或 .gitignore（本命令只提示，不代改）`)
    console.log(`  · 填 scope.values（生成后文件里有 TODO 标记）`)
    console.log(`  · ${npm}`)
    console.log('\n确认无误后加 --apply 落盘。')
    return 0
  }

  let result
  try {
    result = applyInit(projectDir)
  } catch (e) {
    return fail(`落盘失败：${e.message}`)
  }
  console.log(`[init] 已落盘 ${result.written.length} 个文件：`)
  for (const p of result.written) console.log(`  + ${p}`)
  if (result.skipped.length) {
    console.log(`[init] 已存在、保持不动 ${result.skipped.length} 个：`)
    for (const p of result.skipped) console.log(`  · ${p}`)
  }
  console.log('\n[init] 还需要你手工做的：')
  console.log(`  · 把 ${EXCLUDE_SUGGESTION} 加进 .git/info/exclude 或 .gitignore（本命令只提示，不代改）`)
  console.log('  · 填 scope.values（文件里有 TODO 标记）')
  console.log(`  · ${npm}`)
  return 0
}

function fail(msg) {
  console.error(`[init] 前置事实不满足：${msg}`)
  return 1
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node init.mjs --project-dir <项目目录> [--apply]
  不带 --apply = 演练，零写盘，只打印将要落什么
  --apply      = 只增缺失，绝不覆盖已存在的文件
  退出码：0=成功 / 1=前置事实不满足 / 2=用法错误`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
