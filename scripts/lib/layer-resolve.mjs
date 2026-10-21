/**
 * layer-resolve.mjs —— **协议层自己所在位置**的解析（唯一权威）
 *
 * ## 为什么它必须住在协议层里
 *
 * 接入项目需要知道协议层在哪（才能接线、跑判据、调用门禁）。这件事过去由**每个项目各写一份**
 * 解析脚本，于是「层在哪」有 N 份实现、N 份更新纪律（有的说 `git pull`，有的说 `npm i -g`），
 * 迟早分叉。本文件把解析收进协议层：项目侧只留**薄壳**，薄壳调用本文件，不复制逻辑。
 *
 * ## 四条纪律
 *
 *   1. **候选不含项目内**。顺序：`SELF_IMPROVING_LAYER`（显式）→ 宿主 `~/.agents/skills/<name>`
 *      （clone 副本）→ npm 全局目录（npm 副本）→ **协议层自身**（跑在 npx 临时目录 / 源码仓里时）。
 *      刻意**不**把「项目内 `.agents/skills/<name>`」列为候选：那份是**副本**，
 *      一旦被优先选中就回到「两份事实源」——改了一份忘了另一份，门禁判的和提交里跑的不是同一份。
 *   2. **判定标记是文件不是目录**。`scripts/run-tests.mjs` 存在才算装好 ——
 *      只有个空壳目录是「装了一半看着像装好了」的降级路径，拿它当判据等于把那个坑固化下来。
 *   3. **找不到时的信息必须可操作**：说清「层没装 + 已找过哪几个位置 + 两条通道各自怎么装」。
 *   4. **clone 候选排在 npm 候选之前**。两条通道内容同一份（同 tag 发布），但更新方式不同：
 *      clone 走 `git pull`，npm 副本**没有 git 历史**只能 `npm i -g`。
 *      让 npm 优先会让「更新 = git pull」这条纪律在多数机器上悄悄失效 —— 失效时**不报错**，
 *      只是更新方式被换掉了。
 */
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 层名 = skill 名 = 宿主目录名（宿主自动发现、无需映射）。 */
export const LAYER_SKILL_NAME = 'self-improving-like-systems'

/** npm 通道的包名 —— 与协议仓 `package.json` 同名。 */
export const LAYER_NPM_PACKAGE = 'self-improving-like-systems'

/** 协议层公开仓 —— 分发的来源（写给别人的信息里不许出现本机盘符）。 */
export const LAYER_GITHUB_URL = 'https://github.com/monsterbude123/self-improving-like-systems'

/**
 * npm 全局安装根目录的**候选**（按可能性排序）。
 *
 * ⚠️ 刻意**不**跑 `npm root -g`：实测本机要 5.5 秒，而本文件在 pre-commit 的
 * 模块加载点上会被调 —— 每次提交白等 5.5 秒是不可接受的（门禁必须廉价）。
 * 代价是要覆盖多种 node 安装形态，用**多候选 + 存在性判定**兜住：
 *   · Windows（nodejs.org 安装器 / nvm-windows）：`<node.exe 所在目录>/node_modules`
 *   · POSIX（nvm / homebrew / 官方包）：`<node.exe 所在目录>/../lib/node_modules`
 */
export function npmGlobalRootCandidates(opts = {}) {
  if (Array.isArray(opts.npmRoots)) return opts.npmRoots.map((p) => path.resolve(p))
  const execDir = path.dirname(opts.execPath ?? process.execPath)
  const out = []
  const prefix = typeof opts.npmPrefix === 'string' ? opts.npmPrefix : (opts.env ?? process.env).npm_config_prefix
  if (typeof prefix === 'string' && prefix.trim() !== '') {
    const p = path.resolve(prefix.trim())
    out.push(path.join(p, 'node_modules'))
    out.push(path.join(p, 'lib', 'node_modules'))
  }
  out.push(path.join(execDir, 'node_modules'))
  out.push(path.join(execDir, '..', 'lib', 'node_modules'))
  return [...new Set(out.map((p) => path.resolve(p)))]
}

/** 判定标记：装好的层必然有它（自检入口就在这儿）。 */
export const LAYER_MARKER_REL = 'scripts/run-tests.mjs'

/** 覆盖层位置的显式开关（开发期 / CI 用）。 */
export const LAYER_ENV_VAR = 'SELF_IMPROVING_LAYER'

/**
 * 项目内**不该存在**的协议层副本的相对路径 —— 存在的项目侧门禁据此判红。
 * 副本回来 = 两份事实源 = 门禁判的和提交里跑的悄悄分叉。
 */
export const LAYER_REPO_COPY_REL = `.agents/skills/${LAYER_SKILL_NAME}`

/**
 * 层的运行时状态目录（相对层根）—— 日志等产物，按设计 gitignored，不是协议正文。
 * 判「仓内副本回来没有」时豁免它：git 删掉被跟踪文件后会把它原地留下。
 */
export const LAYER_RUNTIME_STATE_REL = '.self-improving'

/** 本文件所在协议层根（`scripts/lib/` 的上一级）。 */
export const PROTOCOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 装不上层时抛这个 —— 调用方要能分辨「层没装」与「层的某个脚本坏了」。 */
export class LayerMissingError extends Error {
  constructor(tried, cause = undefined) {
    const lines = [
      '自改进协议层未安装或安装不完整。',
      '已按顺序找过：',
      ...tried.map((t) => `  · [${t.from}] ${t.dir}`),
      `判据 = 标记文件 ${LAYER_MARKER_REL} 存在（只有空目录不算装好）。`,
      '装法（二选一，同一台机器上不共存）：',
      `  1. npm i -g ${LAYER_NPM_PACKAGE}          ← npm 通道（免安装试用；无 git 历史，不要 git pull）`,
      `  2. git clone ${LAYER_GITHUB_URL} ~/.agents/skills/${LAYER_SKILL_NAME}   ← clone 通道（更新走 git pull）`,
      `     或免安装直接用：npx ${LAYER_NPM_PACKAGE} install --project-dir . --apply`,
      `两条通道发的是同一份内容（协议仓同 tag 发布），但**同一台机器上不共存**。`,
      `或显式指定层位置：set ${LAYER_ENV_VAR}=<层根绝对路径>（Unix 用 export）。`,
    ]
    if (cause) lines.push(`底层原因：${cause.message || String(cause)}`)
    super(lines.join('\n'))
    this.name = 'LayerMissingError'
    this.tried = tried
    if (cause) this.cause = cause
  }
}

/**
 * 候选层，**顺序即优先级**。opts 可注入 env/home 供测试用（不注入 = 真实进程环境）。
 * @returns {{from:'env'|'home'|'npm'|'self', dir:string, explicit:boolean, update:string}[]}
 */
export function candidateLayers(opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const out = []
  const raw = typeof env[LAYER_ENV_VAR] === 'string' ? env[LAYER_ENV_VAR].trim() : ''
  if (raw !== '') out.push({ from: 'env', dir: path.resolve(raw), explicit: true, update: 'git pull' })
  out.push({
    from: 'home',
    dir: path.join(home, '.agents', 'skills', LAYER_SKILL_NAME),
    explicit: false,
    update: 'git pull',
  })
  for (const root of npmGlobalRootCandidates(opts)) {
    out.push({
      from: 'npm',
      dir: path.join(root, LAYER_NPM_PACKAGE),
      explicit: false,
      update: `npm i -g ${LAYER_NPM_PACKAGE}`,
    })
  }
  // 协议层自身（源码仓 / npx 临时目录）—— 排最后：真实安装优先于「我刚好在这儿」。
  out.push({ from: 'self', dir: opts.selfRoot ?? PROTOCOL_ROOT, explicit: false, update: 'git pull' })
  return out
}

/**
 * 某个目录是不是 **npm 副本**（而不是 clone 副本）。
 * 判据：**没有 `.git`** —— npm 装的东西不带 git 历史。
 * @returns {boolean}
 */
export function isNpmCopy(dir) {
  try {
    return !existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/** 目录是否「装好了层」= 目录在 **且** 标记文件在（纪律 2）。 */
export function isInstalledLayer(dir) {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
    const marker = path.join(dir, LAYER_MARKER_REL)
    return existsSync(marker) && statSync(marker).isFile()
  } catch {
    return false // 读不动（权限/竞态）一律按「没装」处理：宁可报错让人装，不猜。
  }
}

/**
 * 解析层根 + 命中的是哪个候选（**不抛**）。找不到返回 null。
 * 比 `resolveLayerOrNull()` 多给「命中形态」（clone / npm），调用方要据此说清**怎么更新**。
 * @returns {{dir:string, from:'env'|'home'|'npm'|'self', update:string, isNpm:boolean}|null}
 */
export function resolveLayerCandidate(opts = {}) {
  for (const c of candidateLayers(opts)) {
    if (isInstalledLayer(c.dir)) {
      return {
        dir: c.dir,
        from: c.from,
        update: c.update,
        isNpm: c.from === 'npm' || isNpmCopy(c.dir),
      }
    }
    // 显式指定了却装不完整 —— 那是配置错误，必须报出来，不许悄悄换一层判据继续判。
    if (c.explicit) return null
  }
  return null
}

/**
 * 解析层根，**不抛**。找不到返回 null。
 *
 * ⚠ 纪律 4（**显式指定不可被静延顶替**）：`SELF_IMPROVING_LAYER` 一旦被设成非空值，
 * 它就是权威 —— 该候选过不了判据就直接判未装，不顺延到 home 候选。
 * 理由：你以为自己让提交按 A 层判据判红，实际判的是 B 层 —— 与「副本被静默优先使用」
 * 是同一个失效形态，只是从路径换成了环境变量。
 * @returns {string|null}
 */
export function resolveLayerOrNull(opts = {}) {
  const hit = resolveLayerCandidate(opts)
  return hit === null ? null : hit.dir
}

/**
 * 解析层根，找不到则抛 {@link LayerMissingError}。
 * @returns {string}
 */
export function resolveLayer(opts = {}) {
  const hit = resolveLayerOrNull(opts)
  if (hit !== null) return hit
  throw new LayerMissingError(candidateLayers(opts))
}

/** 层内某个文件的绝对路径。 */
export function layerScript(rel, opts = {}) {
  return path.join(resolveLayer(opts), rel)
}

/**
 * 动态导入层内某个模块。判据只保证**标记文件**在，具体脚本缺失（半装/裁剪过的层）
 * 在这里失败 —— 这正是要的：证明判据不是「目录在就算装好」。
 * @param {string} rel 相对层根的路径
 */
export async function importLayer(rel, opts = {}) {
  const abs = layerScript(rel, opts)
  try {
    return await import(pathToFileURL(abs).href)
  } catch (e) {
    const err = new Error(`协议层内脚本不可用：${abs}\n层根 = ${path.dirname(abs)}\n底层原因：${e.message}`)
    err.cause = e
    err.code = 'LAYER_SCRIPT_UNAVAILABLE'
    throw err
  }
}
