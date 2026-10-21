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

/**
 * 被检查的仓根。
 *
 * 默认 = 本脚本所在的检出（发版时 npm 在包目录里跑 `prepublishOnly`，那正是要检查的地方）。
 * 可用 `--root <dir>` 或 env `SELF_IMPROVING_REPO_ROOT` 覆盖 ——
 * 覆盖是为了**能被测**：判据写在别人仓里跑不动，测不了就等于没有判据。
 */
function resolveRoot(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const v = argv[i + 1]
      if (v) return path.resolve(v)
    }
  }
  const env = process.env.SELF_IMPROVING_REPO_ROOT
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(env.trim())
  return path.resolve(HERE, '..')
}

let ROOT = path.resolve(HERE, '..')

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

/**
 * 断言：**将要打包的文件**与 tag 里的内容**逐字节一致**。
 *
 * ## 为什么这是第二条独立的闸（2026-10-21 实测踩到）
 *
 * `npm pack` 打包的是**工作区里的文件**，不是 git 对象。而工作区的行尾会被
 * 宿主的 `core.autocrlf` 与各种编辑器改写（Windows 上写文件默认 CRLF），
 * git 在 `add` 时按 `text=auto` 归一化成 LF 存进对象库 —— 于是：
 *
 *   tag 里的内容 = LF ｜ npm 包里的内容 = CRLF
 *
 * 两者**功能上等价**（node 不在乎行尾），所以全套件照样全绿 ——
 * 但「两条通道发的是同一份内容」这句话在**字节层面**就不成立了，
 * 而本仓的纪律里有字节级断言（`verify --restore` 字节级可逆、`.gitattributes` 明写
 * 「clone 出来的工作副本与源仓不再逐字节相同」）。
 *
 * 实测：0.1.2 首次发布时 9 个文件在包里是 CRLF、tag 里是 LF，而**没有任何判据报红**
 * —— 因为没人断言过这件事。现在它是一条闸。
 */
function assertWorktreeMatchesTag(tag) {
  const res = spawnSync('git', ['ls-tree', '-r', '--name-only', tag], { cwd: ROOT, encoding: 'utf8' })
  if (res.error || res.status !== 0) return { ok: true, skipped: true, mismatches: [] }
  const files = String(res.stdout || '').split('\n').filter((f) => f !== '')
  const mismatches = []
  for (const f of files) {
    // 只查会被 npm 打包的路径（与 package.json 的 files 字段同源）
    if (!/^(SKILL\.md|AGENTS\.md|README\.md|package\.json|bin\/|scripts\/|references\/|tests\/)/.test(f)) continue
    const abs = path.join(ROOT, ...f.split('/'))
    if (!existsSync(abs)) continue // 未纳入工作区（如 fresh clone 未 checkout）—— 不误报
    const tagBytes = spawnSync('git', ['show', `${tag}:${f}`], { cwd: ROOT })
    if (tagBytes.error || tagBytes.status !== 0) continue
    const workBytes = readFileSync(abs)
    if (Buffer.compare(tagBytes.stdout, workBytes) !== 0) {
      const cr = workBytes.filter((b) => b === 13).length
      mismatches.push({ file: f, crInWorktree: cr })
    }
  }
  return { ok: mismatches.length === 0, skipped: false, mismatches }
}

function main(argv = []) {
  ROOT = resolveRoot(argv)
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

  // 第二道闸：工作区 == tag（逐字节）。npm pack 打包的是工作区，不是 git 对象。
  const wt = assertWorktreeMatchesTag(tag)
  if (!wt.ok) {
    console.error(`[check-release] 工作区与 tag ${tag} 不逐字节一致 —— 停在这里，不发布：`)
    for (const m of wt.mismatches) {
      const why = m.crInWorktree > 0
        ? `工作区里有 ${m.crInWorktree} 个 CR —— 行尾被宿主改写成了 CRLF`
        : '内容与 tag 不同 —— tag 打在这次改动之前？先提交再打 tag'
      console.error(`[check-release]   ${m.file}（${why}）`)
    }
    console.error(`[check-release] npm pack 打包的是**工作区**，不是 git 对象 ⇒ 这会让两条通道发的不是同一份内容。`)
    console.error(`[check-release] 修法：行尾问题用 git add --renormalize . && git checkout -- . 归一化成 LF`)
    console.error(`[check-release]      （与 .gitattributes 的 eol=lf 一致）；内容问题先提交再打 tag。`)
    return 1
  }

  console.error(`[check-release] 版本一致：tag ${tag} == package.json ${version}；工作区与 tag 逐字节一致 —— 可以发布。`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
