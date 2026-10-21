#!/usr/bin/env node
/**
 * scripts/self-improving.mjs —— **项目侧薄壳**（由协议层的 install 命令写入本项目）
 *
 * ## 这个文件是什么
 *
 * 协议层 `self-improving-like-systems` 装在**仓外**（宿主技能目录或 npm 全局目录）。
 * 本项目需要三件事：知道层在哪、能跑层的判据、能判「层装没装好」。
 * 这三件事的**逻辑全在协议层里**（`scripts/lib/layer-resolve.mjs` / `layer-gate.mjs`），
 * 本文件只做两件事：
 *   1. **找到层**（找不到就打印「怎么装」，而不是让调用方自己猜）；
 *   2. **转发**给层的对应命令。
 *
 * ## 为什么是薄壳而不是复制
 *
 * 复制一份解析逻辑到每个项目，等于把「层在哪」「怎么更新（git pull vs npm i -g）」
 * 「层装没装好怎么判」变成 N 份实现 —— 迟早分叉，而分叉的那份没人更新。
 * 薄壳里唯一重复的是**极简层定位**（十几行），因为它必须能在「层压根没装」时运行 ——
 * 那正是要给出安装提示的场景，此时无法 import 层。
 *
 * ## 用法
 *
 *   node scripts/self-improving.mjs doctor       # 层装没装好？装没装好给一条说清根因的红
 *   node scripts/self-improving.mjs install      # 装 / 更新层（clone 通道），然后跑一次自检
 *   node scripts/self-improving.mjs self-test    # 跑协议层全套判据
 *   node scripts/self-improving.mjs gate         # 协议层门禁（供 pre-commit 调用）
 *   node scripts/self-improving.mjs collect-logs # 把本项目运行期日志采到用户目录，供维护 agent 分析
 *
 * 退出码：0 = 成功 / 1 = 前置事实不满足（层没装等）/ 2 = 用法错误
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 层名 = skill 名 = 宿主目录名。 */
const LAYER_NAME = 'self-improving-like-systems'
/** npm 通道包名（与协议仓 package.json 同名）。 */
const NPM_PKG = 'self-improving-like-systems'
/** 协议层公开仓 —— 分发的唯一来源。 */
const GITHUB_URL = 'https://github.com/monsterbude123/self-improving-like-systems'
/** 覆盖层位置的显式开关。 */
const LAYER_ENV_VAR = 'SELF_IMPROVING_LAYER'

/**
 * 层的候选位置（顺序即优先级）。
 *
 * 顺序与协议层 `scripts/lib/layer-resolve.mjs` 一致：env 显式 → 宿主 clone 副本
 * → npm 全局副本 → **协议层自身**（跑在 npx 临时目录 / 源码仓里时）。
 * clone 排在 npm 前是刻意的：clone 可 `git pull` 更新，npm 副本只能 `npm i -g` ——
 * 让 npm 优先会让「更新 = git pull」在多数机器上悄悄失效，且失效时不报错。
 */
function candidates() {
  const out = []
  const raw = typeof process.env[LAYER_ENV_VAR] === 'string' ? process.env[LAYER_ENV_VAR].trim() : ''
  if (raw !== '') out.push({ from: 'env', dir: path.resolve(raw), update: 'git pull', explicit: true })
  out.push({ from: 'home', dir: path.join(os.homedir(), '.agents', 'skills', LAYER_NAME), update: 'git pull' })
  const execDir = path.dirname(process.execPath)
  const prefix = process.env.npm_config_prefix
  if (typeof prefix === 'string' && prefix.trim() !== '') {
    out.push({ from: 'npm', dir: path.join(path.resolve(prefix.trim()), 'node_modules', NPM_PKG), update: `npm i -g ${NPM_PKG}` })
  }
  out.push({ from: 'npm', dir: path.join(execDir, 'node_modules', NPM_PKG), update: `npm i -g ${NPM_PKG}` })
  out.push({ from: 'npm', dir: path.join(execDir, '..', 'lib', 'node_modules', NPM_PKG), update: `npm i -g ${NPM_PKG}` })
  return out
}

/** 判定标记：装好的层必然有它（只有空目录不算装好）。 */
const MARKER_REL = 'scripts/run-tests.mjs'

/**
 * 钩子子命令 → 层内脚本的映射。
 *
 * 宿主配置里写的是本薄壳（项目相对路径），由薄壳转发到层里的真脚本。
 * 映射写死在这儿而不是猜：猜错的后果是**钩子跑起别的脚本**（比如把普通命令当钩子跑）。
 */
const HOOK_SCRIPTS = {
  'hook-session-start': 'scripts/hook-session-start.mjs',
  'hook-tool-events': 'scripts/hook-tool-events.mjs',
  'hook-user-correction': 'scripts/hook-user-correction.mjs',
  capture: 'scripts/capture.mjs',
  distill: 'scripts/distill.mjs',
}

/** 找到装好的层；找不到返回 null。 */
function findLayer() {
  for (const c of candidates()) {
    if (existsSync(path.join(c.dir, MARKER_REL))) {
      const isNpm = c.from === 'npm' || !existsSync(path.join(c.dir, '.git'))
      return { ...c, isNpm }
    }
    if (c.explicit) return null // 显式指定却不完整 = 配置错误，不许静默换一层
  }
  return null
}

/** 层没装时的提示 —— 必须可操作（说清两条通道各怎么装）。 */
function missingHints(tried) {
  const lines = [
    '自改进协议层未安装或安装不完整。',
    '已按顺序找过：',
    ...tried.map((t) => `  · [${t.from}] ${t.dir}`),
    `判据 = 标记文件 ${MARKER_REL} 存在（只有空目录不算装好）。`,
    '装法（二选一，同一台机器上不共存）：',
    `  1. npm i -g ${NPM_PKG}          ← npm 通道（免安装试用；无 git 历史，不要 git pull）`,
    `  2. node scripts/self-improving.mjs install   ← clone 通道（装到 ~/.agents/skills/${LAYER_NAME}，更新走 git pull）`,
    `     或免安装直接用：npx ${NPM_PKG} install --project-dir . --apply`,
    `两条通道发的是同一份内容（协议仓同 tag 发布），但**同一台机器上不共存**。`,
    `或显式指定层位置：set ${LAYER_ENV_VAR}=<层根绝对路径>（Unix 用 export）。`,
  ]
  console.error(lines.join('\n'))
}

/** 转发给协议层里的某个脚本。 */
function runLayerScript(layer, rel, args = []) {
  const abs = path.join(layer.dir, rel)
  const r = spawnSync(process.execPath, [abs, ...args], { stdio: 'inherit' })
  return r.status === null ? 1 : r.status
}

/** 动态 import 协议层里的模块。 */
async function importLayer(layer, rel) {
  return import(pathToFileURL(path.join(layer.dir, rel)).href)
}

/**
 * clone 通道的安装器（层没装时用 —— 此时无法 import 层，只能自带最小实现）。
 *
 * 纪律：**装不上就明确报错，绝不留下半个目录**。安装器最坏的失败形态不是「报错」，
 * 而是「报错之后留下一个空目录」—— 下一次跑看到目录在，就以为装好了，判据其实一次都没跑过。
 */
function cloneInstall(target) {
  mkdirSync(path.dirname(target), { recursive: true })
  const r = spawnSync('git', ['clone', '--depth', '1', GITHUB_URL, target], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[install] ❌ clone 失败 —— 没有留下半个目录（git clone 失败不会建出可用的层）')
    return 1
  }
  return 0
}

async function main(argv) {
  const cmd = argv[0]
  const rest = argv.slice(1)
  const projectDir = path.resolve(process.cwd())

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`项目侧协议层入口（薄壳）：
  doctor       层装没装好？给一条说清根因的判据
  install      装 / 更新层（clone 通道），然后跑一次自检
  self-test    跑协议层全套判据
  gate         协议层门禁（供 pre-commit 调用）
  collect-logs 把本项目运行期日志采到用户目录，供维护 agent 分析

  层没装时按提示装：npm i -g ${NPM_PKG}  或  node scripts/self-improving.mjs install`)
    return 0
  }

  let layer = findLayer()

  if (cmd === 'install') {
    if (layer === null) {
      const target = path.join(os.homedir(), '.agents', 'skills', LAYER_NAME)
      const r = cloneInstall(target)
      if (r !== 0) return r
      layer = findLayer()
      if (layer === null) {
        missingHints(candidates())
        return 1
      }
    } else if (layer.from === 'home') {
      // 已存在 → 只快进更新，绝不删除/重置（只增不减）。
      const r = spawnSync('git', ['-C', layer.dir, 'pull', '--ff-only'], { stdio: 'inherit' })
      if (r.status !== 0) {
        console.error('[install] 更新失败（保留原版本，不做任何删除/重置）')
        return 1
      }
    } else {
      console.log(`[install] 层已就位（${layer.dir}，${layer.isNpm ? 'npm 副本' : 'clone 副本'}），更新方式 = ${layer.update}`)
      if (layer.isNpm) console.log(`[install]   npm 副本没有 git 历史，不要 git pull —— 更新用 ${layer.update}`)
    }
    console.log('[install] 跑一次自检确认判据在跑……')
    return runLayerScript(layer, 'scripts/run-tests.mjs')
  }

  if (layer === null) {
    missingHints(candidates())
    return 1
  }

  if (cmd === 'self-test') return runLayerScript(layer, 'scripts/run-tests.mjs')
  if (cmd === 'collect-logs') return runLayerScript(layer, 'scripts/collect-logs.mjs', ['--project-dir', projectDir, ...rest])

  // 钩子入口：宿主配置里写的是**项目相对路径**（`${ZCODE_PROJECT_DIR}/scripts/self-improving.mjs`），
  // 真正干活的脚本由本薄壳**在运行期**去层里找。
  // 为什么绕这一圈（2026-10-21）：宿主配置是**机器本地**文件，但里面若写死层的绝对路径，
  // 那份配置就既不可移植、也会把「某台机器的目录布局」写进产物；
  // 而若写成「层在项目内」（`${ZCODE_PROJECT_DIR}/.agents/skills/<层名>/scripts/…`），
  // 层装在仓外时那条路径根本不存在 —— 钩子每次失败（2026-10-21 实测的主仓就是这样哑了 25 小时）。
  // 走薄壳，两个问题同时没有：配置里只有项目相对路径（可移植），运行期按层**实际所在**去找。
  if (HOOK_SCRIPTS[cmd]) {
    return runLayerScript(layer, HOOK_SCRIPTS[cmd], rest)
  }

  if (cmd === 'doctor' || cmd === 'gate') {
    const pointerRel = readPointerRel(projectDir)
    // 层里的门禁实现可能与本薄壳**版本不对齐**（薄壳与层是两次安装）。
    // 薄壳是「感知可用性」的第一道门 —— 它**绝不能崩**：崩了用户看到的是 import 栈，
    // 而不是「层版本不匹配」这条能行动的信息。所以拿不到层里的实现就退回内置最小判据。
    let gate = null
    try {
      const mod = await importLayer(layer, 'scripts/lib/layer-gate.mjs')
      gate = mod.runLayerGate ?? null
    } catch {
      gate = null
    }
    if (gate) {
      const r = gate({ repoRoot: projectDir, pointerRel })
      for (const l of r.lines) (r.ok ? console.log : console.error)(l)
      return r.code
    }
    return builtinGate(layer, projectDir, pointerRel)
  }

  console.error(`用法错误：未知子命令 ${cmd}`)
  return 2
}

/**
 * 指针文件位置：优先用项目里已存在的指针（一个项目可能有自己的 skill 名），
 * 找不到就用协议层约定的默认名。
 */
function readPointerRel(projectDir) {
  const base = path.join(projectDir, '.agents', 'skills')
  try {
    for (const name of readdirSync(base)) {
      if (name === LAYER_NAME) continue // 层自己的目录不是指针
      const p = path.join(base, name, 'SKILL.md')
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf8')
        if (text.includes(NPM_PKG) || text.includes('self-improving')) {
          return `.agents/skills/${name}/SKILL.md`
        }
      }
    }
  } catch {
    // 目录不存在 / 读不动 → 用默认名
  }
  // 默认指针名**刻意不等于层名**：`.agents/skills/<层名>/` 在门禁里是「仓内副本」的判红位置，
  // 指针若放那儿会被自己的门禁当成副本回流判红。
  return '.agents/skills/self-improving/SKILL.md'
}

/**
 * 内置最小门禁 —— 层里的实现不可用时的兜底（层版本比薄壳旧 / 比薄壳新都可能）。
 *
 * 判两条：① 层装没装好（薄壳自己知道）；② 指针写没写全两条分发通道。
 * 这两条是「别的 agent 能不能找到层并用起来」的最小充分条件。
 */
function builtinGate(layer, projectDir, pointerRel) {
  const problems = []
  const pointerPath = path.join(projectDir, ...pointerRel.split('/'))
  if (!existsSync(pointerPath)) {
    problems.push(`指针文件不存在：${pointerRel}`)
  } else {
    let text = ''
    try { text = readFileSync(pointerPath, 'utf8') } catch { text = '' }
    if (!text.includes(GITHUB_URL)) problems.push('指针里没有 GitHub 公开仓地址')
    if (!new RegExp(`(npm i -g|npx)\\s+${NPM_PKG}`).test(text)) problems.push('指针里没有可执行的 npm 安装命令')
  }
  if (problems.length > 0) {
    console.error('FAIL: 协议层接线不完整：')
    for (const p of problems) console.error(`  · ${p}`)
    console.error('')
    console.error(`指针文件 = ${pointerRel}（别的 agent 检索时唯一会读到的地方）`)
    console.error(`重跑接入命令即可补齐：npx ${NPM_PKG} install --project-dir . --apply`)
    return 2
  }
  console.log(`PASS: 协议层已就位（${layer.dir}，${layer.isNpm ? 'npm 副本' : 'clone 副本'}，更新 = ${layer.update}）；指针两条通道齐全。`)
  console.log('      注：层里的完整门禁实现不可用（版本不匹配），本次只跑了内置最小判据。')
  console.log(`      重新接入以对齐版本：npx ${NPM_PKG} install --project-dir . --apply`)
  return 0
}

const status = await main(process.argv.slice(2))
process.exitCode = status
