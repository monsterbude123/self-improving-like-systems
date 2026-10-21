#!/usr/bin/env node
/**
 * install-layer.mjs —— 把协议层装到宿主技能目录（clone 通道）/ 更新它
 *
 * ## 为什么协议层要提供「装自己」
 *
 * 接入项目需要两件事：① 装协议层 ② 接协议层。② 由 `install-project.mjs` 管，
 * ① 此前每个接入项目各写一份（`scripts/self-improving-install.mjs`）——
 * 于是「装法」「更新方式（git pull vs npm i -g）」「装坏了怎么办」在 N 个项目里各有一份，
 * 迟早分叉；而层本身的形态纪律（两条通道不共存、npm 副本没有 git 历史）
 * 只有住在层里才说得清。
 *
 * 所以本命令是**层自己的安装器**：装法与纪律的权威在这里，
 * 接入项目侧只留一行转发。
 *
 * ## 三条纪律
 *
 * 1. **装不上就明确报错，绝不留下半个目录**。安装器最坏的失败形态不是「报错」，
 *    而是「报错之后留下一个空目录」—— 下一次跑看到目录在，就以为装好了，
 *    判据其实一次都没跑过。
 * 2. **只增不减**。目标已存在时走 `pull --ff-only`，不做任何删除/重置；
 *    目标存在但**不是协议层**时直接拒绝，绝不「看着不像就删了重装」。
 * 3. **分发来源只有一条 = GitHub 公开仓**。默认源是公开仓地址，不含任何本机磁盘路径 ——
 *    同事在自己机器上跑，本机路径必然失败，而排查成本全落在他们身上。
 *
 * 退出码：0=装好且自检全绿 / 1=装不上或自检未绿 / 2=用法错误
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { LAYER_GITHUB_URL, LAYER_MARKER_REL, LAYER_NPM_PACKAGE, LAYER_SKILL_NAME } from './lib/layer-resolve.mjs'

/** 默认装到宿主技能目录，目录名与 skill 名一致 —— 宿主自动发现、无需映射。 */
export function defaultTarget() {
  return path.join(os.homedir(), '.agents', 'skills', LAYER_SKILL_NAME)
}

/** 目录是不是「装好的层」= 目录在 **且** 标记文件在（空目录不算，见纪律 1）。 */
function isInstalledLayer(dir) {
  try {
    return existsSync(dir) && existsSync(path.join(dir, LAYER_MARKER_REL))
  } catch {
    return false
  }
}

/**
 * 装 / 更新协议层。
 * @param {{target?:string, source?:string, selfCheck?:boolean}} opts
 * @returns {{status:number, lines:string[]}}
 */
export function install(opts = {}) {
  const lines = []
  const target = opts.target ? path.resolve(opts.target) : defaultTarget()
  const source = opts.source ?? LAYER_GITHUB_URL
  const selfCheck = opts.selfCheck !== false

  if (existsSync(target)) {
    if (!isInstalledLayer(target)) {
      // 目标存在但不是协议层 —— 可能是别人的目录、克隆坏了。
      // **绝不「看着不像就删了重装」**：那是拿别人的数据赌一把。
      lines.push(`[install] ✗ 目标已存在但不是协议层（缺标记文件 ${LAYER_MARKER_REL}）：${target}`)
      lines.push('[install]   **不自动删除** —— 里面可能是别人的东西。请人工确认后自行处理，或用 --target 换个位置。')
      lines.push('')
      lines.push('  另一条通道（内容与 GitHub 同 tag 发布，是同一份）：')
      lines.push(`    npx ${LAYER_NPM_PACKAGE} install --project-dir . --apply   # 免安装试用`)
      lines.push(`    npm i -g ${LAYER_NPM_PACKAGE}                         # 装成全局命令`)
      lines.push('    （npm 副本**没有 git 历史**，更新走 npm i -g，不要 git pull）')
      lines.push(`  ⚠️ 两条通道**不共存**：${target} 只能是其中一种。`)
      return { status: 1, lines, action: 'pull', alreadyUpToDate: false }
    }
    lines.push(`[install] 层已存在 → 更新（只快进，不删除/重置）：${target}`)
    const before = headSha(target)
    const pull = spawnSync('git', ['-C', target, 'pull', '--ff-only'], { stdio: 'inherit' })
    if (pull.status !== 0) {
      lines.push('[install] 更新失败 —— 保留原版本（没有任何破坏性动作），请手工处理冲突后重试。')
      return { status: 1, lines, action: 'pull', alreadyUpToDate: false }
    }
    const after = headSha(target)
    // 「已是最新」要**明说**：否则调用方无从判断「pull 跑过了」与「本来就在最新」的区别，
    // 只能靠猜 —— 而这条命令的常见用途就是「确认我装的是不是最新版」。
    if (before !== null && before === after) {
      lines.push('[install] 已是最新，无需变更。')
      return { status: 0, lines, action: 'pull', alreadyUpToDate: true }
    }
  } else {
    lines.push(`[install] 克隆协议层 → ${target}`)
    lines.push(`[install]   来源：${source}`)
    mkdirSync(path.dirname(target), { recursive: true })
    const clone = spawnSync('git', ['clone', '--depth', '1', source, target], { stdio: 'inherit' })
    if (clone.status !== 0) {
      // clone 失败时可能留下半个目录 —— 删掉它。
      // 「装了一半看着像装好了」比「装不上」危险得多：下一次跑看到目录在，
      // 就以为装好了，而判据其实一次都没跑过。
      try { if (existsSync(target)) rmSync(target, { recursive: true, force: true }) } catch { /* 删不掉也不掩盖错误 */ }
      lines.push('[install] ❌ 克隆失败 —— 没有留下半个目录（那会让下一次跑误以为装好了）。')
      return { status: 1, lines, action: 'clone', alreadyUpToDate: false }
    }
  }

  if (!selfCheck) {
    lines.push('[install] 跳过自检（--no-self-check）。')
    return { status: 0, lines, action: 'clone', alreadyUpToDate: false }
  }

  lines.push('[install] 跑一次自检确认判据在跑……')
  const t = spawnSync(process.execPath, [path.join(target, 'scripts', 'run-tests.mjs')], { stdio: 'inherit' })
  if (t.status !== 0) {
    lines.push('[install] ❌ 自检未全绿 —— 层已装上，但判据没过。请看上面的失败输出。')
    return { status: 1, lines, action: 'clone', alreadyUpToDate: false }
  }
  lines.push('[install] ✅ 层已就位且自检全绿。')
  return { status: 0, lines, action: 'clone', alreadyUpToDate: false }
}

/** 取当前 HEAD 的 sha（取不到就返回 null —— 不是判据，只是「有没有变」的辅助信息）。 */
function headSha(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  const s = String(r.stdout || '').trim()
  return s === '' ? null : s
}

export function main(argv) {
  let target = null
  let source = null
  let selfCheck = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') { const v = argv[++i]; if (!v || v.startsWith('--')) return usage('--target 后须跟目录'); target = v; continue }
    if (a === '--from') { const v = argv[++i]; if (!v || v.startsWith('--')) return usage('--from 后须跟仓地址'); source = v; continue }
    if (a === '--no-self-check') { selfCheck = false; continue }
    if (a === '--help' || a === '-h') return usage('')
    return usage(`未知参数 ${a}`)
  }
  const r = install({ target: target ?? undefined, source: source ?? undefined, selfCheck })
  for (const l of r.lines) console.log(l)
  return r.status
}

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}`)
  console.error(`用法：node install-layer.mjs [--target <目录>] [--from <仓地址>] [--no-self-check]
  协议层不存在则克隆、已存在则 pull，然后跑一次自检。
  默认装到宿主技能目录，默认源是 GitHub 公开仓。

  两条通道（内容同一份 · 同 tag 发布，**不共存**）：
    clone 通道  = ${LAYER_GITHUB_URL}
                  → 装到 ~/.agents/skills/${LAYER_SKILL_NAME}（宿主技能发现走这条，可 git pull 更新）
    npm 通道    = ${LAYER_NPM_PACKAGE}
                  → npx ${LAYER_NPM_PACKAGE} init --project-dir . --apply（免安装试用；无 git 历史，更新走 npm i -g）

  退出码：0=装好且自检全绿 / 1=装不上或自检未绿 / 2=用法错误`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
