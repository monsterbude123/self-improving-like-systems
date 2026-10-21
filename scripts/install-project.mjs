#!/usr/bin/env node
/**
 * install-project.mjs —— **一条命令把协议层接进一个项目**（默认零写盘，`--apply` 才落）
 *
 * ## 为什么要有它（2026-10-21）
 *
 * 实测（见 .planning/02-VERIFICATION.md）：协议层本身能装、能跑判据，但「接进一个新项目」
 * 这一步**没有做完** —— 空项目里要手工做的事至少 7 步（init、hook-install、填 scope、
 * 加 gitignore、并清单脚本、写指针、抄三个项目侧脚本），而且 `init` 还会把**本机绝对路径**
 * 写进新项目的清单。装得上 ≠ 接得上，接上 ≠ 接对。
 *
 * 所以本命令把「接入」收敛成一条：装好层之后，
 *
 *   npx self-improving-like-systems install --project-dir . --apply
 *
 * 就把下面这些**一次做完**：
 *   · 实例配置 + 注册表（复用 init.mjs 的模板派生逻辑）
 *   · 项目侧薄壳 `scripts/self-improving.mjs`（层在哪、怎么跑判据、怎么判装没装好）
 *   · 指针 `<项目>/.agents/skills/<指针名>/SKILL.md`（别的 agent 检索时唯一会读到的地方）
 *   · 宿主钩子接线 `.zcode/config.json`（指向**真实层目录**，不是项目内副本）
 *   · 运行期目录进 `.gitignore`（跑完仓不干净是放弃接线的头号原因）
 *   · 清单里的 npm 脚本（`si:doctor` / `si:install` / `si:gate` / `si:self-test`）
 *
 * ## 三条纪律
 *
 *   1. **只增不覆盖**。已存在的文件一律不动 —— 人改过的 scope、路径、清单脚本原样保留。
 *   2. **清单文件只在「往返不变形」时才改**。package.json 重新序列化会重排格式，
 *      造成整份清单的 diff；检测到往返变形就**不碰**，改为打印建议片段。
 *   3. **零写盘是默认**。不带 `--apply` 只打印将要落什么。
 *
 * 退出码：0=成功 / 1=前置事实不满足（层没装等）/ 2=用法错误
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyHooks } from './hook-install.mjs'
import { applyInit, planInit, SHELL_REL, WORK_ROOT } from './init.mjs'
import { LayerMissingError, LAYER_GITHUB_URL, LAYER_NPM_PACKAGE, resolveLayerCandidate } from './lib/layer-resolve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 指针默认名（**不等于层名** —— 层名那个位置在门禁里是「仓内副本」的判红点）。 */
export const DEFAULT_POINTER_NAME = 'self-improving'

/** 接入后项目侧应当有的 npm 脚本。 */
export const PROJECT_SCRIPTS = {
  'si:doctor': 'node scripts/self-improving.mjs doctor',
  'si:install': 'node scripts/self-improving.mjs install',
  'si:gate': 'node scripts/self-improving.mjs gate',
  'si:self-test': 'node scripts/self-improving.mjs self-test',
}

/** 项目侧薄壳在项目里的相对位置（与 init.mjs 同一份定义）。 */
export { SHELL_REL } from './init.mjs'

/**
 * 指针内容 —— 必须同时含 GitHub 仓地址与**可执行的 npm 命令形态**。
 *
 * 那两条是门禁判据③钉死的：别的 agent 检索「经验系统 / self-improving」时唯一会读到的
 * 就是这个指针；少一条，它就不知道还有另一条路（于是重复造轮子，或卡在「怎么装」上问人）。
 */
export function pointerContent(pointerName) {
  return `---
name: ${pointerName}
description: 本项目的经验系统入口。触发词：learnings、教训、错误记录、特性请求、backlog、复盘、经验沉淀、自我改进、LRN、ERR、FEAT。**协议正文不在本项目** —— 本文件只写「层在哪、怎么装、怎么用」。
---

# ${pointerName} — 协议层入口（薄壳）

协议正文在**仓外安装的协议层** \`self-improving-like-systems\`（\`references/schema.md\` + \`references/stoploss.md\` + \`scripts/*.mjs\`）。本项目只保留**薄壳**，不保留协议副本 —— 副本形态等于两份事实源。

**两条通道（同一份内容 · 同 tag 发布 · 同一台机器上不共存）**：
- clone：\`git clone ${LAYER_GITHUB_URL} ~/.agents/skills/self-improving-like-systems\` → 更新 \`git pull\`
- npm：\`npm i -g ${LAYER_NPM_PACKAGE}\` → \`npx ${LAYER_NPM_PACKAGE} install --project-dir . --apply\`（无 git 历史，不要 \`git pull\`）

**本项目侧**：
- 薄壳：\`scripts/self-improving.mjs\`（层在哪、怎么跑判据、怎么判装没装好）
- 体检：\`node scripts/self-improving.mjs doctor\` —— 层没装时它给出**可操作的安装提示**，不会让调用方自己猜
- 门禁：\`node scripts/self-improving.mjs gate\`（pre-commit 可调）
- 实例：条目区 \`.self-improving/\`，运行期 \`${WORK_ROOT}/\`，配置 \`.self-improving.yaml\`

**层没装 / 装坏了怎么办**：跑 \`node scripts/self-improving.mjs doctor\`。它会告诉你层没装还是装不完整，并给出装法。
**快捷别名**：项目有 package.json 时另可用 \`npm run si:doctor\` / \`si:gate\` / \`si:install\` / \`si:self-test\`（没有 package.json 就用上面那行 node 形式，两者等价）。
**改判据去协议层仓**（本仓改判据 = 两份事实源），本文件不复述协议正文。
`
}

/** 相对路径统一成正斜杠（给人看的、也要写进配置的都要归一）。 */
function posixRel(p) {
  return p.split(path.sep).join('/')
}

/**
 * 计算要落的东西（纯函数，不碰盘）。
 * @param {string} projectDir 项目根
 * @param {string} pointerName 指针 skill 名
 */
export function planInstall(projectDir, pointerName = DEFAULT_POINTER_NAME) {
  const items = []
  const push = (rel, kind, content) => {
    const abs = path.join(projectDir, rel)
    items.push({ path: posixRel(rel), abs, kind, exists: existsSync(abs), content })
  }
  // ① 实例配置 + 注册表（复用 init 的派生逻辑，不造第二份模板）
  for (const it of planInit(projectDir)) {
    items.push({ ...it, exists: existsSync(it.abs) })
  }
  // ② 项目侧薄壳已由 init 的计划覆盖（planInit 里含它）—— 不在这里重复落一份。
  // ③ 指针
  push(path.join('.agents', 'skills', pointerName, 'SKILL.md'), 'pointer', pointerContent(pointerName))
  return items
}

/**
 * 清单文件能不能安全改：**JSON 往返不变形**才行。
 *
 * 为什么要这道闸：package.json 重新序列化会重排格式/键序，整份清单的 diff 全是噪音；
 * 而清单是全仓共享的机器可读文件，被顺手重排过一次之后，
 * 下一个人 diff 自己的改动时要多看几百行 —— 那会让人开始绕开这个工具。
 * 检测到往返变形就**不碰清单**，改为打印建议片段。
 * @returns {{safe:boolean, indent:string|null, reason:string}}
 */
export function packageJsonRoundTrip(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (e) {
    return { safe: false, indent: null, reason: `不是合法 JSON：${e.message}` }
  }
  const m = /\n([ \t]+)"/.exec(text)
  const indent = m ? m[1] : '  '
  const reser = JSON.stringify(obj, null, indent)
  const trimmed = text.replace(/\s*$/, '')
  if (reser !== trimmed) {
    return { safe: false, indent, reason: 'JSON 往返会变形（原文件的格式不是标准 JSON.stringify 产物）' }
  }
  return { safe: true, indent, reason: '' }
}

/**
 * 算出该往清单里加哪些脚本（只加缺的，绝不覆盖已有的）。
 * @returns {{add:Object<string,string>, skip:string[], reason:string|null}}
 */
export function planPackageScripts(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return { add: {}, skip: [], reason: '该项目没有 package.json —— 清单脚本无需登记' }
  }
  const text = readFileSync(pkgPath, 'utf8')
  const rt = packageJsonRoundTrip(text)
  if (!rt.safe) return { add: {}, skip: [], reason: `清单未改动（${rt.reason}）` }
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return { add: {}, skip: [], reason: '清单未改动（解析失败）' }
  }
  const scripts = obj.scripts ?? {}
  const add = {}
  const skip = []
  for (const [k, v] of Object.entries(PROJECT_SCRIPTS)) {
    if (typeof scripts[k] === 'string') skip.push(k)
    else add[k] = v
  }
  return { add, skip, reason: null }
}

/** 把缺的脚本写进清单（保持原格式；只增不改）。 */
export function applyPackageScripts(projectDir, add) {
  if (Object.keys(add).length === 0) return { written: [], changed: false }
  const pkgPath = path.join(projectDir, 'package.json')
  const text = readFileSync(pkgPath, 'utf8')
  const rt = packageJsonRoundTrip(text)
  if (!rt.safe) return { written: [], changed: false }
  const obj = JSON.parse(text)
  obj.scripts = { ...(obj.scripts ?? {}), ...add }
  writeFileSync(pkgPath, `${JSON.stringify(obj, null, rt.indent)}\n`, 'utf8')
  return { written: Object.keys(add), changed: true }
}

/**
 * 运行期目录进 .gitignore（只增一行，绝不改已有内容）。
 * @returns {{changed:boolean, note:string}}
 */
export function applyGitignore(projectDir) {
  const gi = path.join(projectDir, '.gitignore')
  const line = WORK_ROOT
  if (!existsSync(gi)) {
    writeFileSync(gi, `# 经验系统运行期数据（协议层生成，不进版本库）\n${line}/\n`, 'utf8')
    return { changed: true, note: '新建 .gitignore 并写入运行期目录' }
  }
  const text = readFileSync(gi, 'utf8')
  if (text.split(/\r?\n/).some((l) => l.trim() === `${line}/` || l.trim() === line)) {
    return { changed: false, note: '.gitignore 已含运行期目录' }
  }
  const sep = text.endsWith('\n') ? '' : '\n'
  writeFileSync(gi, `${text}${sep}\n# 经验系统运行期数据（协议层生成，不进版本库）\n${line}/\n`, 'utf8')
  return { changed: true, note: '往 .gitignore 追加运行期目录' }
}

export function main(argv) {
  let projectDir = null
  let apply = false
  let pointerName = DEFAULT_POINTER_NAME
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') { apply = true; continue }
    if (a === '--project-dir') {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) return usage('--project-dir 后须跟目录')
      projectDir = path.resolve(next)
      continue
    }
    if (a === '--pointer-name') {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) return usage('--pointer-name 后须跟名字')
      pointerName = next.trim()
      continue
    }
    if (a === '--help' || a === '-h') return usage('')
    return usage(`未知参数 ${a}`)
  }
  if (!projectDir) return usage('--project-dir 必填（本命令只在明确的接入目标上动作，不猜 cwd）')
  if (!existsSync(projectDir)) return fail(`项目目录不存在：${projectDir}`)

  // —— 层必须在场：不在场就给出装法，而不是留个半装的项目 ——
  const layer = resolveLayerCandidate()
  if (layer === null) {
    const err = new LayerMissingError([])
    console.error('[install] 前置事实不满足：协议层没装，本命令不接线。')
    console.error(err.message)
    console.error('')
    console.error('先装层，再跑本命令：')
    console.error(`  npm i -g ${LAYER_NPM_PACKAGE}`)
    console.error(`  或 git clone ${LAYER_GITHUB_URL} ~/.agents/skills/self-improving-like-systems`)
    console.error(`  或免安装直接用：npx ${LAYER_NPM_PACKAGE} install --project-dir . --apply`)
    return 1
  }

  let plan
  try {
    plan = planInstall(projectDir, pointerName)
  } catch (e) {
    return fail(e.message)
  }
  const todo = plan.filter((p) => !p.exists)
  const pkg = planPackageScripts(projectDir)
  const scriptsDir = path.join(layer.dir, 'scripts')

  if (!apply) {
    console.log(`[install] 演练模式（零写盘）。层：${layer.dir}（${layer.isNpm ? 'npm 副本' : 'clone 副本'}，更新 = ${layer.update}）`)
    console.log(`[install] 将要落 ${todo.length} 个文件：`)
    for (const p of todo) console.log(`  + ${p.path}`)
    for (const p of plan.filter((p) => p.exists)) console.log(`  · ${p.path} 已存在，保持不动`)
    console.log(`[install] 清单脚本将新增：${Object.keys(pkg.add).length ? Object.keys(pkg.add).join(', ') : '(无)'}${pkg.reason ? ` —— ${pkg.reason}` : ''}`)
    console.log(`[install] 钩子接线将指向：${scriptsDir}`)
    console.log(`[install] 运行期目录将进 .gitignore：${WORK_ROOT}/`)
    console.log('\n确认无误后加 --apply 落盘。')
    return 0
  }

  // —— 落盘：只增不覆盖 ——
  const written = []
  const kept = []
  for (const it of plan) {
    if (it.exists) { kept.push(it.path); continue }
    mkdirSync(path.dirname(it.abs), { recursive: true })
    writeFileSync(it.abs, it.content, 'utf8')
    written.push(it.path)
  }
  console.log(`[install] 已落盘 ${written.length} 个文件：`)
  for (const p of written) console.log(`  + ${p}`)
  if (kept.length) {
    console.log(`[install] 已存在、保持不动 ${kept.length} 个：`)
    for (const p of kept) console.log(`  · ${p}`)
  }

  // —— 清单脚本 ——
  const pk = applyPackageScripts(projectDir, pkg.add)
  if (pk.changed) {
    console.log(`[install] 清单新增脚本：${pk.written.join(', ')}`)
  } else if (pkg.reason) {
    console.log(`[install] ${pkg.reason}`)
    console.log(`[install]   请手工并入：${JSON.stringify(PROJECT_SCRIPTS)}`)
  }

  // —— 运行期目录进 gitignore ——
  const gi = applyGitignore(projectDir)
  console.log(`[install] .gitignore：${gi.note}`)

  // —— 钩子接线 ——
  const hr = applyHooks(projectDir, scriptsDir)
  for (const l of hr.lines) console.log(l)
  if (!hr.ok) {
    console.error('[install] ⚠️ 钩子接线未完成 —— 手工把片段并进 .zcode/config.json 的 hooks.events 下：')
    console.error(`         node ${path.join(layer.dir, 'scripts', 'hook-install.mjs')} --project-dir ${projectDir}`)
  }

  console.log('')
  console.log('[install] 还剩这几件要人做（机器做不了）：')
  console.log(`  · 填 .self-improving.yaml 的 scope.values（文件里有 TODO 标记）—— 它决定召回按哪个域命中`)
  console.log('  · 把 .zcode/config.json 提交给同事（该文件机器本地、被 exclude，各人自己跑一次本命令）')
  console.log('  · 钩子改动下个会话生效（hooks 在会话启动时读一次）')
  console.log('')
  console.log(`[install] 体检：node ${path.join(projectDir, ...SHELL_REL.split('/'))} doctor`)
  return 0
}

function fail(msg) {
  console.error(`[install] 前置事实不满足：${msg}`)
  return 1
}

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}`)
  console.error(`用法：node install-project.mjs --project-dir <项目目录> [--pointer-name <名字>] [--apply]
  不带 --apply = 演练，零写盘，只打印将要落什么
  --apply      = 只增不覆盖（已存在的文件一律不动）
  退出码：0=成功 / 1=前置事实不满足 / 2=用法错误`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
