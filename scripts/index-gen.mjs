#!/usr/bin/env node
/**
 * index-gen.mjs —— 经验/自进化系统 · 条目索引再生器（通用技能，零项目耦合）
 *
 * 用法：
 *   node index-gen.mjs              从条目实况再生 <entries_dir>/index.md（幂等）
 *   node index-gen.mjs --check      只验不写：① 现存索引 == 重新生成内容（含链接目标可达）
 *   node index-gen.mjs --link-check 只验链接：索引内每个相对链接目标 ∈ `git ls-files`
 *   node index-gen.mjs --config <p> 指定配置（最高优先）
 * 退出码：0 = 通过 / 1 = 违规或过期 / 2 = 用法错误
 *
 * 设计约束：
 * - 本文件是**引擎**：所有路径取自配置（配置解析链与 validate.mjs 相同：
 *   --config > env SELF_IMPROVING_CONFIG > <repo根>/.self-improving.yaml > 技能内置默认）。
 *   索引文件位置 = <repo根>/<storage.entries_dir>/index.md；条目 = 该目录根层 *.md
 *   （不递归；README.md / index.md 自身排除；命名以 LRN|ERR|FEAT- 开头者才入索引）。
 * - frontmatter 有则用 scope/status；无则回退 文件名 + 首行标题（存量条目普遍无 frontmatter，
 *   索引必须对存量可用 —— 缺 status 显示「存量」占位而非报错）。
 * - 输出必须**确定性**（无时间戳、按 (类型 ERR→LRN→FEAT, 文件名码点序) 排序）——
 *   幂等即验收断言：连跑两次，第二次后 git diff 为空。
 * - 链接目标 = 条目文件相对索引所在目录的文件名（同目录），link-check 以
 *   `git ls-files -z`（单次 spawn）判定可达：不在索引里的链接 = clone 后死链。
 * - O(1) spawn 纪律：目录枚举 readdirSync（零子进程）；git 只在 link-check 时单次调用。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { atomicWrite } from './lib/atomic-file.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// YAML 统一走双后端降级层（js-yaml 优先 / 宿主钩子缺依赖时自动降级）：不许直接 import js-yaml
import { parseYaml as yamlLoad } from './lib/yaml-lite.mjs'
import { resolveRepoRoot, resolveConfigPath, BUILTIN_DEFAULT_CONFIG } from './validate.mjs'

const ENTRY_ID_RE = /^(LRN|ERR|FEAT)-[0-9]{8}-(?:[0-9]{6}|[0-9]{3})/
const TYPE_ORDER = ['ERR', 'LRN', 'FEAT']

/** 载入配置并返回 { config, configLabel, repoRoot }；失败抛 Error（CLI 层转 exit 1）。 */
function loadConfig(cliConfig) {
  const repoRoot = resolveRepoRoot()
  if (!repoRoot) throw new Error('无法定位仓库根（git rev-parse 失败且上溯无 .git）')
  const { path: cfgPath, source } = resolveConfigPath({ cliConfig, repoRoot })
  if (!cfgPath) return { config: BUILTIN_DEFAULT_CONFIG, configLabel: source, repoRoot }
  if (!existsSync(cfgPath)) throw new Error(`配置不存在: ${cfgPath}（来源 ${source}）`)
  const cfg = yamlLoad(readFileSync(cfgPath, 'utf8'))
  if (!cfg || typeof cfg !== 'object' || !cfg.storage || !cfg.storage.entries_dir) {
    throw new Error(`配置缺 storage.entries_dir: ${cfgPath}`)
  }
  return { config: cfg, configLabel: `${source} (${cfgPath})`, repoRoot }
}

/** 解析单个条目 → { file, id, type, title, scope, status }。无 frontmatter 走回退。 */
function parseEntry(absPath, fileName) {
  const id = fileName.replace(/\.md$/, '')
  // 注意：FEAT 是 4 字母前缀 —— 不能 slice(0,3)（会得 'FEA'，FEAT 组被静默丢空）
  const type = (id.match(/^(LRN|ERR|FEAT)-/) || [])[1] || ''
  const text = readFileSync(absPath, 'utf8')
  let fm = null
  const lines = text.split(/\r?\n/)
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      try {
        const parsed = yamlLoad(lines.slice(1, end).join('\n'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fm = parsed
      } catch {
        fm = null // frontmatter 损坏不阻断索引：回退模式（校验器 validate.mjs 负责报违规）
      }
    }
  }
  // 标题回退链：首行 `# ID · 标题` / `# ID 标题` 剥掉 ID 后取余量 → 为空则用文件名 ID- 后段
  let title = ''
  const h = (lines.find((l) => l.startsWith('# ')) || '').replace(/^#\s*/, '')
  if (h.startsWith(id)) title = h.slice(id.length).replace(/^[·\-:\s]+/, '').trim()
  if (!title) {
    const m = id.match(/^(?:LRN|ERR|FEAT)-[0-9]{8}-(?:[0-9]{6}|[0-9]{3})-(.+)$/)
    title = m ? m[1] : id
  }
  return {
    file: fileName,
    id,
    type,
    title,
    scope: fm && typeof fm.scope === 'string' ? fm.scope : null,
    status: fm && typeof fm.status === 'string' ? fm.status : null,
  }
}

/** 生成索引全文（确定性；不含时间戳 —— 时间戳会破坏幂等）。 */
export function renderIndex(entries, entriesDir) {
  const out = []
  out.push('# 经验条目索引')
  out.push('')
  out.push('> 本文件由 `index-gen.mjs` 从条目实况生成（`--check` 只验不写）。**勿手改** ——')
  out.push('> 新增/改名条目后重跑生成器即可，手改会被 --check 判红。')
  out.push(`> 条目目录：\`${entriesDir}\`（仅根层协议命名文件入索引；archive/ 等子目录不在范围）。`)
  out.push('> 事件/提案暂存（本地 gitignored 目录）为本机附录，未入库，故不在本索引、不提供链接。')
  out.push('')
  for (const type of TYPE_ORDER) {
    const group = entries.filter((e) => e.type === type)
    if (group.length === 0) continue
    out.push(`## ${type}（${group.length}）`)
    out.push('')
    for (const e of group) {
      const meta = e.status ? `status:${e.status}` : 'status:存量'
      const scope = e.scope ? ` scope:${e.scope}` : ''
      out.push(`- [${e.id}](${e.file}) — ${e.title}（${meta}${scope}）`)
    }
    out.push('')
  }
  out.push(`---`)
  out.push('')
  out.push(`**合计**：${entries.length} 条（ERR/LRN/FEAT 按类型分组，组内按（日期,层代,序号数值）排序）。`)
  return out.join('\n') + '\n'
}

/** 收集条目（readdirSync，零 spawn）。 */
export function collectEntries(entriesAbsDir) {
  const seen = new Map() // 文件名 → entry；重复 ID（历史撞号）各自成行，按文件名排序保证稳定
  for (const name of readdirSync(entriesAbsDir).sort()) {
    if (!name.endsWith('.md')) continue
    if (name === 'README.md' || name === 'index.md') continue
    if (!ENTRY_ID_RE.test(name)) continue
    seen.set(name, parseEntry(path.join(entriesAbsDir, name), name))
  }
  return [...seen.values()].sort((a, b) => {
    const ta = TYPE_ORDER.indexOf(a.type)
    const tb = TYPE_ORDER.indexOf(b.type)
    if (ta !== tb) return ta - tb
    // 同类型内排序(01-01 编号方案):同日按(层代,序号数值)——存量三位层整体在前、
    // 新六位层在后,层内数值比较。纯数值比较修不了倒挂(新号 000001=1 < 旧号 999),
    // 003 与 000003 数值并列也丢确定性;不可解析文件名的按原名排最后(稳定兜底)。
    const ra = idRank(a.file)
    const rb = idRank(b.file)
    if (ra && rb) {
      if (ra[0] !== rb[0]) return ra[0] < rb[0] ? -1 : 1
      if (ra[1] !== rb[1]) return ra[1] - rb[1]
      if (ra[2] !== rb[2]) return ra[2] - rb[2]
    } else if (ra !== rb) return ra ? -1 : 1
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  })
}

/** 条目文件名 → (日期, 层代, 序号数值);层代:存量三位=0,新六位=1。不可解析返回 null。 */
function idRank(file) {
  const m = /^(?:LRN|ERR|FEAT)-([0-9]{8})-([0-9]{6}|[0-9]{3})(?:-|\.md$)/.exec(file)
  if (!m) return null
  return [m[1], m[2].length === 3 ? 0 : 1, parseInt(m[2], 10)]
}

/** link-check：索引全文中相对链接目标（排除 http/mailto/# 锚）须 ∈ git ls-files。返回违规行数组。 */
export function checkLinks(indexText, indexAbsPath, repoRoot) {
  const tracked = new Set(
    execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean),
  )
  const bad = []
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g
  const lines = indexText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    let m
    while ((m = re.exec(lines[i])) !== null) {
      const target = m[1]
      if (/^(https?:|mailto:|#)/.test(target)) continue
      const rel = path.relative(repoRoot, path.resolve(path.dirname(indexAbsPath), target))
      const relPosix = rel.split(path.sep).join('/')
      if (!tracked.has(relPosix)) bad.push(`  行 ${i + 1}: (${target}) → ${relPosix} 不在 git ls-files（clone 后即死链）`)
    }
  }
  return bad
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node index-gen.mjs               再生索引（幂等）
  node index-gen.mjs --check       只验不写（内容新鲜 + 链接可达）
  node index-gen.mjs --link-check  只验索引链接目标 ∈ git ls-files
  node index-gen.mjs --config <p>  指定配置（最高优先）`)
  return 2
}

function main(argv) {
  let mode = 'write'
  let cliConfig = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') mode = 'check'
    else if (a === '--link-check') mode = 'link'
    else if (a === '--config') {
      cliConfig = argv[++i]
      if (!cliConfig) return usage('--config 缺参数')
    } else if (a === '--help' || a === '-h') return usage('帮助')
    else return usage(`未知参数 ${a}`)
  }

  let ctx
  try {
    ctx = loadConfig(cliConfig)
  } catch (e) {
    console.error(`FAIL: ${e.message}`)
    return 1
  }
  const { config, configLabel, repoRoot } = ctx
  const entriesDir = String(config.storage.entries_dir).replace(/\\/g, '/').replace(/\/+$/, '')
  const entriesAbsDir = path.join(repoRoot, ...entriesDir.split('/'))
  const indexAbsPath = path.join(entriesAbsDir, 'index.md')

  if (!existsSync(entriesAbsDir)) {
    console.error(`FAIL: 条目目录不存在 ${entriesDir}（配置 ${configLabel}）`)
    return 1
  }

  if (mode === 'link') {
    if (!existsSync(indexAbsPath)) {
      console.error(`FAIL: 索引不存在 ${entriesDir}/index.md —— 先跑生成器`)
      return 1
    }
    const bad = checkLinks(readFileSync(indexAbsPath, 'utf8'), indexAbsPath, repoRoot)
    if (bad.length > 0) {
      console.error(`FAIL: 索引链接 ${bad.length} 个不可达：`)
      for (const b of bad) console.error(b)
      return 1
    }
    console.log(`PASS: ${entriesDir}/index.md 全部链接目标 ∈ git ls-files（配置 ${configLabel}）`)
    return 0
  }

  const entries = collectEntries(entriesAbsDir)
  if (entries.length === 0) {
    console.error(`FAIL: ${entriesDir} 下无协议命名条目（LRN|ERR|FEAT-*.md）—— 索引无从生成`)
    return 1
  }
  const rendered = renderIndex(entries, entriesDir)

  if (mode === 'check') {
    if (!existsSync(indexAbsPath)) {
      console.error(`FAIL: 索引不存在 ${entriesDir}/index.md —— 跑一次生成器再生`)
      return 1
    }
    const onDisk = readFileSync(indexAbsPath, 'utf8').replace(/\r\n/g, '\n')
    if (onDisk !== rendered) {
      console.error(`FAIL: ${entriesDir}/index.md 与条目实况不一致（过期）—— 重跑 index-gen.mjs 再生`)
      return 1
    }
    const bad = checkLinks(onDisk, indexAbsPath, repoRoot)
    if (bad.length > 0) {
      console.error(`FAIL: 索引链接 ${bad.length} 个不可达：`)
      for (const b of bad) console.error(b)
      return 1
    }
    console.log(`PASS: 索引新鲜（${entries.length} 条）且全部链接 ∈ git ls-files（配置 ${configLabel}）`)
    return 0
  }

  atomicWrite(indexAbsPath, rendered, 'utf8') // 原子写：重生成期间读者不会看到半截索引（票 H2）
  // 写后自证：链接可达才报 PASS（生成器自产链接理应全部可达，判红 = 生成器缺陷）
  const bad = checkLinks(rendered, indexAbsPath, repoRoot)
  if (bad.length > 0) {
    console.error(`FAIL: 生成的索引有 ${bad.length} 个链接不在 git ls-files（条目未被 git 跟踪？）：`)
    for (const b of bad) console.error(b)
    return 1
  }
  console.log(`PASS: 已再生 ${entriesDir}/index.md（${entries.length} 条，配置 ${configLabel}）`)
  return 0
}

// 仅当被直接执行时运行 CLI（导出供测试复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
