#!/usr/bin/env node
/**
 * check-release.mjs —— 发版前的一致性断言
 *
 * 存在理由（2026-10-21）：协议层有**两条分发通道**（GitHub clone / npm），
 * 而「两条通道发的是同一份内容」这件事**不能靠自觉** —— 它的失效形态极其安静：
 * npm 上是 0.1.0，git 里 tag 却是 0.1.1，两边都「能装」，都能跑，
 * 没有任何报错，只是内容悄悄分叉。分叉之后的每一个 bug 报告都要先花半天
 * 搞清楚「他装的是哪一份」—— 这个成本全落在接盘的人身上。
 *
 * 所以断言必须在**发布那一刻**跑，且必须**硬失败**：
 *   · `package.json` 的 `version` 必须与 `git describe --tags` 给出的 tag 一致（允许 `v` 前缀）；
 *   · 不一致 ⇒ **停**。不得改 version 去迁就 tag，也不得带着不一致发布。
 *     改 version 去迁就 tag 是把问题推给未来（tag 已经是发布过的事实）；
 *     带着不一致发布则是让两条通道当场分叉。
 *
 * 这条断言是「发布前最后一道闸」，不是「发布后自查」——
 * 它由 npm 的 `prepublishOnly` 钩子自动触发（见 package.json）。
 * 注意：**没有** `postinstall` —— 装到别人家目录这类动作绝不能自动发生。
 *
 * 零依赖：只读 git 与 package.json，不写任何东西。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 读 package.json 的 version。 */
function readVersion() {
  const p = path.join(ROOT, 'package.json')
  if (!existsSync(p)) {
    console.error(`[check-release] 找不到 package.json：${p} —— 这不是一个可发布的协议层检出`)
    return null
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`[check-release] package.json 解析失败：${e.message}`)
    return null
  }
  if (!pkg.version) {
    console.error('[check-release] package.json 缺 version')
    return null
  }
  return String(pkg.version)
}

/** 取当前检出指向的 tag（无 tag 时返回 null）。 */
function readTag() {
  const res = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' })
  if (res.error || res.status !== 0) return null
  const t = String(res.stdout || '').trim()
  return t === '' ? null : t
}

/** 去掉 tag 的 `v` 前缀后比较（`v0.1.0` 与 `0.1.0` 视作同一个版本）。 */
function normalize(v) {
  return String(v).replace(/^v/, '')
}

function main() {
  const version = readVersion()
  if (version === null) return 2
  const tag = readTag()
  if (tag === null) {
    console.error(`[check-release] 当前检出没有 tag —— 发版前先打 tag（如 git tag v${version}）并推送。`)
    console.error(`[check-release] package.json 的 version = ${version}`)
    return 1
  }
  if (normalize(tag) !== normalize(version)) {
    console.error(`[check-release] 版本不一致 —— 停在这里，不发布：`)
    console.error(`[check-release]   git tag       = ${tag}`)
    console.error(`[check-release]   package.json = ${version}`)
    console.error(`[check-release] 两条分发通道发同一份内容的前提就是这两个数相等。`)
    console.error(`[check-release] 修法：改 version 去迁就 tag（tag 是已发布的事实），或重打 tag —— 二选一，别绕。`)
    return 1
  }
  console.error(`[check-release] 版本一致：tag ${tag} == package.json ${version} —— 可以发布。`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
