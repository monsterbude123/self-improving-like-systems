#!/usr/bin/env node
/**
 * migrate-legacy.mjs —— 存量条目 frontmatter 迁移引擎（通用、零依赖、幂等）
 *
 * 角色：**只做机械插入**，不含任何语义判断。
 *   - 语义判断（scope / claim / status 归一）= 映射文件（项目实例数据，默认
 *     <repo根>/.self-improving/legacy-mapping.yaml）—— 换仓库只换映射，引擎不动。
 *   - 契约判据（必填键 / 枚举 / scope 合法值）= 同目录 validate.mjs —— 本文件 import
 *     它的导出做**写前自检**，不另立第二份字段表（单一归宿）。
 *
 * 不变量：
 *   1. 只在文件**最前**插入 frontmatter；正文一个字节都不改（原样保留原文与换行风格）。
 *   2. 幂等：已有合规 frontmatter 的文件跳过；二次运行零变更。
 *   3. 不改名、不删文件、不消解编号冲突。
 *   4. 映射里出现但文件不存在 / 文件存在但映射缺失 —— 都报出来，由人裁决，不静默。
 *
 * ===== 可选键回填（票 G4c：契约扩了 §1.4 可选键后的补救路径）=====
 * 迁移前旧 frontmatter 里的检索元数据（tags/date/category/resolved_*）曾被契约块整体替换掉。
 * 本引擎因此多认一份**可选键数据源**（默认 <repo根>/.self-improving/legacy-optional-meta.yaml，
 * 结构 = `entries: { <条目ID>: { <可选键>: 值 } }`），对**已带 frontmatter** 的文件补写这些键：
 *   - 只补**缺失**的键：文件里已存在的值一律保留 —— 契约块（如 status）与本数据源冲突时以文件现状为准，
 *     数据源绝不覆盖既有键（`status` 根本不在数据源的键集里，见该文件头注）。
 *   - 只改 frontmatter 块内部（在闭合 `---` 行前插入行），正文与换行风格零改动。
 *   - 写前自检仍走 validate.mjs（补写后的整块 frontmatter 必须过契约才落盘）。
 *   - 幂等：第二次运行零写入（缺失集为空 → 走 already 分支）。
 *   - 可选键类型判据不写第二份：键集与类型表 import 自 validate.mjs（契约单一归宿）。
 *
 * 用法：
 *   node migrate-legacy.mjs                       # 按配置解析链迁移（默认 entries_dir 根层）
 *   node migrate-legacy.mjs --dry-run             # 只报将要改什么，不写盘
 *   node migrate-legacy.mjs --check               # 只校验（写前自检口径），不改盘；有问题 exit 1
 *   node migrate-legacy.mjs --mapping <p>         # 指定映射文件
 *   node migrate-legacy.mjs --optional-meta <p>   # 指定可选键数据源（默认 <repo根>/.self-improving/legacy-optional-meta.yaml；缺失 = 无回填）
 *   node migrate-legacy.mjs --entries-dir <p>     # 指定条目目录（默认取 config.storage.entries_dir）
 *   node migrate-legacy.mjs --only ERR            # 只迁 id 前缀匹配的条目（LRN/FEAT 分批时用）
 *   node migrate-legacy.mjs --config <p>          # 指定实例配置（默认解析链见 validate.mjs）
 *
 * 退出码：0 = 全部目标条目已带合规 frontmatter（含本次刚写入的）；1 = 校验/映射有问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseYaml } from './lib/yaml-lite.mjs'
import {
  BUILTIN_DEFAULT_CONFIG,
  OPTIONAL_ENTRY_KEYS,
  OPTIONAL_ENTRY_KEY_TYPES,
  TYPE_ENUM,
  extractFrontmatter,
  resolveConfigPath,
  resolveRepoRoot,
  validateEntry,
} from './validate.mjs'

const MAPPING_RELPATH = path.join('.self-improving', 'legacy-mapping.yaml')
const OPTIONAL_META_RELPATH = path.join('.self-improving', 'legacy-optional-meta.yaml')

function rel(p) {
  const r = path.relative(process.cwd(), p)
  return r === '' ? '.' : r.split(path.sep).join('/')
}

function usage(msg) {
  if (msg) console.error('用法错误：', msg)
  console.error(
    [
      '用法：node migrate-legacy.mjs [--dry-run] [--check] [--mapping <p>] [--optional-meta <p>] [--entries-dir <p>] [--only <前缀>] [--config <p>]',
    ].join('\n'),
  )
  process.exit(1)
}

function parseArgs(argv) {
  const out = {
    dryRun: false,
    check: false,
    mapping: null,
    optionalMeta: null,
    entriesDir: null,
    only: null,
    config: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--check') out.check = true
    else if (a === '--mapping') out.mapping = argv[++i] ?? usage(`${a} 后须跟路径`)
    else if (a === '--optional-meta') out.optionalMeta = argv[++i] ?? usage(`${a} 后须跟路径`)
    else if (a === '--entries-dir') out.entriesDir = argv[++i] ?? usage(`${a} 后须跟路径`)
    else if (a === '--only') out.only = argv[++i] ?? usage(`${a} 后须跟前缀`)
    else if (a === '--config') out.config = argv[++i] ?? usage(`${a} 后须跟路径`)
    else usage(`未知参数：${a}`)
  }
  return out
}

/** 读实例配置：--config > env > <repo根>/.self-improving.yaml > 内置默认（解析链同 validate.mjs）。 */
function loadConfig(cliConfig) {
  const repoRoot = resolveRepoRoot(process.cwd())
  const { path: cfgPath, source } = resolveConfigPath({ cliConfig, repoRoot })
  if (!cfgPath) return { config: BUILTIN_DEFAULT_CONFIG, source, repoRoot }
  let text
  try {
    text = fs.readFileSync(cfgPath, 'utf8')
  } catch {
    console.error(`配置不可读：${cfgPath}（来源：${source}）`)
    process.exit(1)
  }
  let parsed
  try {
    parsed = parseYaml(text)
  } catch (e) {
    console.error(`配置 YAML 解析失败：${cfgPath} —— ${e.reason || e.message}`)
    process.exit(1)
  }
  const cfg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : BUILTIN_DEFAULT_CONFIG
  const scopeValues = cfg.scope && Array.isArray(cfg.scope.values) ? cfg.scope.values : BUILTIN_DEFAULT_CONFIG.scope.values
  return { config: { ...cfg, scope: { ...BUILTIN_DEFAULT_CONFIG.scope, ...cfg.scope, values: scopeValues } }, source, repoRoot }
}

/**
 * frontmatter 标量的 YAML 序列化（与 yaml-lite 可解的子集对齐）：
 *   - 含 `:` / `#` / 首尾空格 / 会被误认成别的类型的值 → 双引号包裹；
 *   - 内部双引号/反斜杠转义；中文按原样写出（不 \u 转义，便于人读与 git diff）。
 */
function scalar(v) {
  if (v === null) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const s = String(v)
  const needsQuote =
    s === '' ||
    /[:#]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^(true|false|null|~)$/i.test(s) ||
    /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s) ||
    s.startsWith('"') ||
    s.startsWith("'") ||
    s.startsWith('[') ||
    s.startsWith('{') ||
    s.startsWith('&') ||
    s.startsWith('*')
  if (!needsQuote) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 把条目 ID + 映射项渲染成 frontmatter 文本（键序固定 = 契约字段表顺序）。
 * `type` 由 ID 前缀推出（与命名前缀一一对应），映射文件不重复声明。
 *
 * 前缀取 TYPE_ENUM 里最长的匹配项而非固定 3 字符切片：`FEAT` 是 4 字符前缀，
 * `slice(0, 3)` 会推出非法值 `FEA`（票 06b 迁移 FEAT 段时暴露）。
 * 判据来源仍是 TYPE_ENUM（契约单一归宿），此处不硬编码第二份前缀表。
 */
function typeFromId(id) {
  const s = String(id)
  return TYPE_ENUM.filter((t) => s.startsWith(t)).sort((a, b) => b.length - a.length)[0] ?? s.slice(0, 3)
}

function renderFrontmatter(id, m, opt) {
  const type = typeFromId(id)
  const lines = [
    `type: ${type}`,
    `status: ${scalar(m.status)}`,
    `scope: ${scalar(m.scope)}`,
    `claim: ${scalar(m.claim)}`,
    `guard_ref: ${scalar(m.guard_ref ?? null)}`,
    `recurrence: ${typeof m.recurrence === 'number' ? m.recurrence : 0}`,
    `last_verified_at: ${scalar(m.last_verified_at ?? null)}`,
  ]
  // 可选键按契约键表顺序追加（契约 §1.4）—— 顺序稳定 = 二次运行渲染结果一致 = 幂等。
  for (const key of OPTIONAL_ENTRY_KEYS) {
    if (!opt || !(key in opt)) continue
    const rendered = renderOptionalValue(key, opt[key])
    if (rendered === null) continue // 形态非法：不写（由调用方报 problem）
    lines.push(`${key}: ${rendered}`)
  }
  return `---\n${lines.join('\n')}\n---\n`
}

/**
 * 可选键值的 YAML 序列化（键序与类型判据来自契约 OPTIONAL_ENTRY_KEY_TYPES，不在本文件写第二份类型表）：
 *   - `string[]` → 行内数组，元素逐个走 scalar()（纯数字标签自动加引号保持字符串）；
 *   - `date`     → **强制加引号**（契约 §1.4：未加引号会按 YAML 时间戳解成 Date，两条后端判定不一致）；
 *   - `string`   → 走 scalar()。
 * 形态非法返回 null（调用方负责报错，绝不静默写坏数据）。
 */
function renderOptionalValue(key, v) {
  const kind = OPTIONAL_ENTRY_KEY_TYPES[key]
  if (kind === 'string[]') {
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string')) return null
    return `[${v.map((t) => scalar(t)).join(', ')}]`
  }
  if (kind === 'date') {
    if (typeof v !== 'string') return null
    // 日期恒定带引号（契约 §1.4）；引号/反斜杠转义，形态是否合法由写前自检的 validateEntry 裁决，
    // 本文件不复制第二份日期正则。
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  if (kind === 'string') {
    return typeof v === 'string' && v.trim() !== '' ? scalar(v) : null
  }
  return null
}

/**
 * 往**已存在**的 frontmatter 块内补写缺失的可选键（票 G4c 回填路径）。
 * 不变量：只在闭合 `---` 行前插入新行；正文与换行风格逐字节不动；文件里已存在的键绝不覆盖
 * （数据源与文件现状冲突时以文件现状为准 —— 契约块的 status 等语义键归契约块所有）。
 * @returns {{ ok: true, text: string, added: string[] } | { ok: false, reason: string }}
 */
function backfillOptionalKeys(original, opt) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r\n|\n/)
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i
      break
    }
  }
  if (close === -1) return { ok: false, reason: 'frontmatter 未闭合，无法定位插入点' }
  const existing = extractFrontmatter(original)
  if (existing.error) return { ok: false, reason: existing.error }
  const added = []
  const newLines = []
  for (const key of OPTIONAL_ENTRY_KEYS) {
    if (!(key in opt)) continue
    if (key in existing.fm) continue // 已存在 → 保留现值，不覆盖
    const rendered = renderOptionalValue(key, opt[key])
    if (rendered === null) {
      return { ok: false, reason: `可选键 ${key} 形态非法，不写（${JSON.stringify(opt[key])}）` }
    }
    newLines.push(`${key}: ${rendered}`)
    added.push(key)
  }
  if (added.length === 0) return { ok: true, text: original, added }
  const out = [...lines.slice(0, close), ...newLines, ...lines.slice(close)]
  return { ok: true, text: out.join(eol), added }
}

function main(argv) {
  const args = parseArgs(argv)
  const repoRoot = resolveRepoRoot(process.cwd())
  const { config, source } = loadConfig(args.config)
  const scopeValues = config.scope.values

  const mappingPath = args.mapping ? path.resolve(args.mapping) : path.resolve(repoRoot || process.cwd(), MAPPING_RELPATH)
  let mapping
  try {
    mapping = parseYaml(fs.readFileSync(mappingPath, 'utf8'))
  } catch (e) {
    console.error(`映射不可读或解析失败：${rel(mappingPath)} —— ${e.reason || e.message}`)
    process.exit(1)
  }
  const entries = mapping && typeof mapping === 'object' && mapping.entries && typeof mapping.entries === 'object' ? mapping.entries : null
  if (!entries) {
    console.error(`映射缺 entries 映射段：${rel(mappingPath)}`)
    process.exit(1)
  }

  // ===== 可选键数据源（票 G4c 回填；文件缺失 = 本仓无回填需求，不是错误）=====
  const optionalMetaPath = args.optionalMeta
    ? path.resolve(args.optionalMeta)
    : path.resolve(repoRoot || process.cwd(), OPTIONAL_META_RELPATH)
  let optionalMeta = null
  if (args.optionalMeta || fs.existsSync(optionalMetaPath)) {
    try {
      optionalMeta = parseYaml(fs.readFileSync(optionalMetaPath, 'utf8'))
    } catch (e) {
      console.error(`可选键数据源不可读或解析失败：${rel(optionalMetaPath)} —— ${e.reason || e.message}`)
      process.exit(1)
    }
  }
  const optEntries =
    optionalMeta && typeof optionalMeta === 'object' && optionalMeta.entries && typeof optionalMeta.entries === 'object'
      ? optionalMeta.entries
      : null
  if (optionalMeta && !optEntries) {
    console.error(`可选键数据源缺 entries 映射段：${rel(optionalMetaPath)}`)
    process.exit(1)
  }
  if (optEntries) {
    // 数据源自身先过一遍契约判据：形态非法的可选键不许带进写盘流程（在报告里点名到条目）。
    for (const [id, opt] of Object.entries(optEntries)) {
      if (opt === null || typeof opt !== 'object' || Array.isArray(opt)) {
        console.error(`可选键数据源条目 ${id} 不是映射`)
        process.exit(1)
      }
      for (const key of Object.keys(opt)) {
        if (!OPTIONAL_ENTRY_KEYS.includes(key)) {
          console.error(`可选键数据源条目 ${id} 含契约外键 ${key}（契约见 references/schema.md §1.4）`)
          process.exit(1)
        }
      }
    }
  }

  const entriesDir = args.entriesDir
    ? path.resolve(args.entriesDir)
    : path.resolve(repoRoot || process.cwd(), config.storage.entries_dir)
  if (!fs.existsSync(entriesDir)) {
    console.error(`条目目录不存在：${rel(entriesDir)}`)
    process.exit(1)
  }

  const problems = []
  const stats = { migrated: 0, backfilled: 0, already: 0, unknownInDir: [], mappedMissing: [], optMissingFile: [] }
  const written = []
  const backfilled = []

  for (const [id, m] of Object.entries(entries)) {
    if (args.only && !String(id).startsWith(args.only)) continue
    const file = path.join(entriesDir, `${id}.md`)
    if (!fs.existsSync(file)) {
      stats.mappedMissing.push(id)
      continue
    }
    // 可选键回填：数据源有条目、语义映射没有 → 该条目不在本引擎的迁移面内，报出来由人裁决。
    const opt =
    optEntries && Object.prototype.hasOwnProperty.call(optEntries, id) ? optEntries[id] : {}
    // 写前自检：用契约判据（validateEntry）验证将要写入的 frontmatter。
    const fmText = renderFrontmatter(id, m, opt)
    const parsedFm = extractFrontmatter(fmText)
    if (parsedFm.error) {
      problems.push(`${id}: 渲染的 frontmatter 自身不合法 —— ${parsedFm.error}`)
      continue
    }
    const violations = validateEntry(parsedFm.fm, scopeValues)
    if (violations.length) {
      problems.push(`${id}: ${violations.join('；')}`)
      continue
    }
    const original = fs.readFileSync(file, 'utf8')
    const existing = extractFrontmatter(original)
    if (!existing.error) {
      // 幂等分支：已带 frontmatter —— 走可选键回填路径，缺失集为空则零改动。
      const bf = backfillOptionalKeys(original, opt)
      if (!bf.ok) {
        problems.push(`${id}: 可选键回填失败 —— ${bf.reason}`)
        continue
      }
      if (bf.added.length > 0) {
        // 回填后整块 frontmatter 必须仍过契约（可选键的类型判据在这次自检里生效）。
        const afterFm = extractFrontmatter(bf.text)
        if (afterFm.error) {
          problems.push(`${id}: 回填后的 frontmatter 不合法 —— ${afterFm.error}`)
          continue
        }
        const afterViolations = validateEntry(afterFm.fm, scopeValues)
        if (afterViolations.length) {
          problems.push(`${id}: 回填后的 frontmatter 违规 —— ${afterViolations.join('；')}`)
          continue
        }
        if (args.dryRun || args.check) {
          stats.backfilled += 1
        } else {
          fs.writeFileSync(file, bf.text, 'utf8')
          backfilled.push(`${id}.md +${bf.added.join('/')}`)
          stats.backfilled += 1
        }
        continue
      }
      stats.already += 1 // 幂等分支：已带合规 frontmatter 且可选键齐全，零改动
      continue
    }
    if (!args.dryRun && !args.check) {
      const eol = original.includes('\r\n') ? '\r\n' : '\n'
      fs.writeFileSync(file, (eol === '\r\n' ? fmText.replace(/\n/g, '\r\n') : fmText) + original, 'utf8')
      written.push(`${id}.md`)
      stats.migrated += 1
    }
  }

  // 可选键数据源里有、但语义映射里没有的条目 —— 报出来（引擎不越权创建 frontmatter）。
  if (optEntries) {
    for (const id of Object.keys(optEntries)) {
      if (!(id in entries)) stats.optMissingFile.push(id)
    }
  }

  // 目录内未登记在映射里的条目 —— 只报告（按批次迁移时属预期，如 LRN/FEAT 尚未登记）。
  for (const f of fs.readdirSync(entriesDir)) {
    if (!f.endsWith('.md')) continue
    const id = f.slice(0, -3)
    if (id === 'README' || id === 'index') continue
    if (!(id in entries)) {
      stats.unknownInDir.push(id)
      continue
    }
    if (args.only && !id.startsWith(args.only)) continue
    if (args.dryRun || args.check) {
      const original = fs.readFileSync(path.join(entriesDir, f), 'utf8')
      if (extractFrontmatter(original).error) stats.migrated += 1
    }
  }

  for (const id of stats.mappedMissing) problems.push(`${id}: 映射有条目，目录无同名文件（改名/消解冲突须人工裁决）`)
  for (const id of stats.optMissingFile) problems.push(`${id}: 可选键数据源有条目，语义映射无此条目（须补映射后重跑）`)

  const mode = args.dryRun ? 'dry-run' : args.check ? 'check' : 'apply'
  console.log(
    `migrate-legacy (${mode})：条目目录 ${rel(entriesDir)} · 映射 ${rel(mappingPath)} · 可选键 ${optEntries ? rel(optionalMetaPath) : '（无）'} · 配置 ${source}`,
  )
  console.log(
    `  本次写入 ${stats.migrated} 条 · 可选键回填 ${stats.backfilled} 条 · 已有 frontmatter 跳过 ${stats.already} 条 · 映射缺失文件 ${stats.mappedMissing.length} 条 · 目录未登记 ${stats.unknownInDir.length} 条`,
  )
  if (written.length) console.log(`  已写：${written.join(', ')}`)
  if (backfilled.length) {
    console.log(`  已回填可选键：${backfilled.length} 条`)
    for (const b of backfilled) console.log(`    - ${b}`)
  }
  if (stats.unknownInDir.length) console.log(`  未登记（分批迁移时属预期）：${stats.unknownInDir.join(', ')}`)

  if (problems.length) {
    console.error(`FAIL：${problems.length} 条有问题`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('PASS：迁移完成（幂等可重跑）')
}

main(process.argv.slice(2))
