/**
 * yaml-lite.mjs —— 经验系统 YAML 读取的双后端降级层（通用技能，零项目耦合）
 *
 * 存在理由：宿主侧钩子（提交钩子 / 会话钩子）跑在宿主，宿主 node_modules 为空（js-yaml 不可用）；
 * 凡会被宿主钩子调用的脚本（validate 门禁路径 / inject / 未来 capture/distill）都必须零外部
 * 依赖可跑。本模块是唯一的 YAML 入口 —— 调用方一律 import 这里，禁止直接 import js-yaml：
 *   - js-yaml 可用（容器 / 装了依赖的新项目）→ 优先 js-yaml，全量能力不减；
 *   - js-yaml 缺失（宿主钩子路径）→ 自动降级本文件的极简实现，链路永不断。
 *
 * 降级实现覆盖面（本系统配置与 frontmatter 形态承诺）：
 *   - 扁平 frontmatter：`key: value`、双/单引号剥离、null / ~ / bool / 整数 / 浮点 / YYYY-MM-DD 日期
 *   - 嵌套映射（按缩进递归）、块序列 `- item` 与 `- key: value`（守卫注册表 guards 形态）
 *   - 行内数组 `[a, b]`、行内映射 `{k: v}`、块标量 `|` / `>`（含 `|-` / `>-`）
 *   - 整行注释与行内 ` #` 注释（引号内不剥离）
 * 降级实现不支持（遇到即抛错，调用方按「YAML 解析失败」处理 —— 装上 js-yaml 后自动恢复全量）：
 *   锚点/别名（& / *）、多文档（--- 分隔）、复杂键、tab 缩进；块标量内部的空行/注释行会被预处理
 *   折叠（降级路径的已知让步，真实语料不依赖该形态）。
 *
 * 与 js-yaml 的行为对齐点：重复键抛错；`2026-10-16` 形态标量解析为 Date（与 js-yaml timestamp
 * 类型一致 —— validateEntry 对非字符串的 last_verified_at 报违规，两条后端必须同向）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 当前后端标识：'js-yaml' | 'yaml-lite'（测试与排障用）。 */
let backend = 'yaml-lite'
/** js-yaml 的 load；缺失为 null。 */
let jsYamlLoad = null
try {
  const mod = require('js-yaml')
  if (mod && typeof mod.load === 'function') {
    jsYamlLoad = mod.load
    backend = 'js-yaml'
  }
} catch {
  /* 宿主 node_modules 为空 → 保持 yaml-lite 降级后端 */
}

/** 当前后端标识（'js-yaml' | 'yaml-lite'）。 */
export function yamlBackend() {
  return backend
}

/**
 * 首选解析入口：有 js-yaml 用 js-yaml，否则降级极简实现。
 * 解析失败抛 Error（带 `.reason`，与 js-yaml YAMLException 的读取口径一致）。
 * @param {string} text
 * @returns {unknown}
 */
export function parseYaml(text) {
  if (jsYamlLoad) return jsYamlLoad(text)
  return parseYamlLite(text)
}

// ===== 降级实现（零依赖；覆盖面见文件头注）=====

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const INT_RE = /^[+-]?\d+$/
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/

class YamlLiteError extends Error {
  constructor(message, lineNo) {
    super(lineNo ? `${message}（第 ${lineNo} 行）` : message)
    this.reason = this.message
    this.name = 'YamlLiteError'
  }
}

/** 去掉行内注释（引号内不识别 #；`#` 须位于行首或空白之后才构成注释）。 */
function stripInlineComment(s) {
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inD) {
      if (c === '\\') i++
      else if (c === '"') inD = false
      continue
    }
    if (inS) {
      if (c === "'") {
        if (s[i + 1] === "'") i++
        else inS = false
      }
      continue
    }
    if (c === '"') inD = true
    else if (c === "'") inS = true
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '')
  }
  return s.replace(/\s+$/, '')
}

/** 找到引号外的 `key:` 分隔符（冒号后须为空白或行尾）；返回索引或 -1。 */
function findKeySep(s) {
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inD) {
      if (c === '\\') i++
      else if (c === '"') inD = false
      continue
    }
    if (inS) {
      if (c === "'") {
        if (s[i + 1] === "'") i++
        else inS = false
      }
      continue
    }
    if (c === '"') inD = true
    else if (c === "'") inS = true
    else if (c === ':' && (i + 1 === s.length || /\s/.test(s[i + 1]))) return i
  }
  return -1
}

/**
 * 双引号标量的反转义 —— **单趟左到右扫描**，不是一串 `.replace()`。
 *
 * 2026-10-20 实测修掉的真实数据损坏：原实现按 `\n` → `\t` → `\"` → `\\` 的顺序
 * 连做四次全局替换。顺序错了就会吃掉本该保留的字符：`"C:\\nodejs"` 里第二个反斜杠
 * 恰好和 `n` 组成 `\n`，被第一条规则先换成真换行，于是 Windows 路径 `C:\nodejs`
 * 读出来变成 `C:<换行>odejs`。Windows 宿主上任何提到绝对路径的条目 claim 都会中招，
 * 而注入出来的半句话比不注入更糟（人会照着读错的内容行动）。
 * 一串全局替换的通病：每条规则都在**已经改写过的字符串**上再扫一遍，
 * 上一条规则的输出会成为下一条的输入 —— 顺序敏感且无法自证正确。
 * 单趟扫描则是「每个源字符恰好被读一次」，转义语义与 YAML 规范一致。
 */
const DQ_UNESCAPE = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v',
  f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xa0', L: ' ', P: ' ',
}

function unescapeDoubleQuoted(body, lineNo) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') { out += c; continue }
    const n = body[i + 1]
    if (n === undefined) throw new YamlLiteError(`双引号标量以孤立的反斜杠结尾: ${body}`, lineNo)
    if (n === 'x' || n === 'u' || n === 'U') {
      const width = n === 'x' ? 2 : n === 'u' ? 4 : 8
      const hex = body.slice(i + 2, i + 2 + width)
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new YamlLiteError(`\\${n} 转义需要 ${width} 位十六进制: ${body.slice(i, i + 8)}`, lineNo)
      }
      out += String.fromCodePoint(parseInt(hex, 16))
      i += 1 + width
      continue
    }
    if (Object.hasOwn(DQ_UNESCAPE, n)) { out += DQ_UNESCAPE[n]; i++; continue }
    // 未知转义：YAML 规范判错，但宽松放行更安全 —— 收紧会让既有条目突然读不出来，
    // 而「原样保留」是本协议对用户正文的承诺。
    out += c
  }
  return out
}

/** 解析标量：引号剥离 / null / bool / 数值 / 日期，其余按字符串。 */
function parseScalar(s, lineNo) {
  const t = s.trim()
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null
  if (t[0] === '"') {
    if (t.length < 2 || t[t.length - 1] !== '"') throw new YamlLiteError(`双引号标量未闭合: ${t}`, lineNo)
    return unescapeDoubleQuoted(t.slice(1, -1), lineNo)
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new YamlLiteError(`单引号标量未闭合: ${t}`, lineNo)
    return t.slice(1, -1).replace(/''/g, "'")
  }
  if (t === 'true' || t === 'True' || t === 'TRUE') return true
  if (t === 'false' || t === 'False' || t === 'FALSE') return false
  if (INT_RE.test(t)) return Number(t)
  if (FLOAT_RE.test(t)) return Number(t)
  if (DATE_RE.test(t)) {
    const d = new Date(`${t}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return t
}

/** 按顶层逗号切分流式内容（深度与引号感知）。 */
function splitFlow(inner, lineNo, open, close) {
  const parts = []
  let depth = 0
  let inS = false
  let inD = false
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (inD) {
      cur += c
      if (c === '\\') {
        cur += inner[i + 1] ?? ''
        i++
      } else if (c === '"') inD = false
      continue
    }
    if (inS) {
      cur += c
      if (c === "'") {
        if (inner[i + 1] === "'") {
          cur += "'"
          i++
        } else inS = false
      }
      continue
    }
    if (c === '"') inD = true
    else if (c === "'") inS = true
    else if (c === open) depth++
    else if (c === close) depth--
    else if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts
}

/** 行内流式序列 `[a, "b, c", 3]` → 数组。 */
function parseFlowSeq(s, lineNo) {
  if (!s.endsWith(']')) throw new YamlLiteError(`行内数组未闭合: ${s}`, lineNo)
  const inner = s.slice(1, -1).trim()
  if (inner === '') return []
  return splitFlow(inner, lineNo, '[', ']').map((p) => {
    const t = p.trim()
    if (t.startsWith('[')) return parseFlowSeq(t, lineNo)
    return parseScalar(t, lineNo)
  })
}

/** 行内流式映射 `{k: v, k2: v2}` → 对象。 */
function parseFlowMap(s, lineNo) {
  if (!s.endsWith('}')) throw new YamlLiteError(`行内映射未闭合: ${s}`, lineNo)
  const inner = s.slice(1, -1).trim()
  const out = {}
  if (inner === '') return out
  for (const p of splitFlow(inner, lineNo, '{', '}')) {
    const sep = findKeySep(p)
    if (sep < 0) throw new YamlLiteError(`行内映射项缺冒号: ${p}`, lineNo)
    out[String(parseScalar(p.slice(0, sep), lineNo))] = parseScalar(p.slice(sep + 1), lineNo)
  }
  return out
}

const BLOCK_INDICATORS = new Set(['|', '|-', '|+', '>', '>-', '>+'])

/**
 * 极简文档解析器：预处理为显著行（过滤空行/注释）后按缩进递归，单游标线性扫描。
 * 非法形态一律抛 YamlLiteError（带 `.reason`）。
 */
class Parser {
  constructor(text) {
    const raw = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    this.lines = []
    for (let n = 0; n < raw.length; n++) {
      const line = raw[n]
      if (/^\s*\t/.test(line)) throw new YamlLiteError('tab 缩进不支持（YAML 规范禁止，降级后端不猜语义）', n + 1)
      const trimmed = line
      if (trimmed.trim() === '' || trimmed.trimStart().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      const text = stripInlineComment(trimmed.trim())
      if (text === '') continue
      this.lines.push({ indent, text, lineNo: n + 1 })
    }
    this.pos = 0
  }

  peek() {
    return this.lines[this.pos]
  }

  parseDocument() {
    if (this.lines.length === 0) return null
    const first = this.lines[0]
    if (first.text === '---' || first.text.startsWith('--- ')) {
      throw new YamlLiteError('多文档流（---）不属降级覆盖面，请安装 js-yaml', first.lineNo)
    }
    if (first.indent !== 0) throw new YamlLiteError(`顶层缩进不为 0: ${first.text}`, first.lineNo)
    const value = this.parseNode(0)
    if (this.pos < this.lines.length) {
      const left = this.lines[this.pos]
      throw new YamlLiteError(`文档尾部残留: ${left.text}`, left.lineNo)
    }
    return value
  }

  parseNode(indent) {
    const line = this.peek()
    if (line && line.indent === indent && (line.text === '-' || line.text.startsWith('- '))) return this.parseSequence(indent)
    return this.parseMapping(indent)
  }

  parseMapping(indent) {
    const out = {}
    for (;;) {
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) throw new YamlLiteError(`缩进意外（期望 ${indent}，实际 ${line.indent}）: ${line.text}`, line.lineNo)
      if (line.text === '-' || line.text.startsWith('- ')) break
      const sep = findKeySep(line.text)
      if (sep < 0) throw new YamlLiteError(`缺冒号的映射行: ${line.text}`, line.lineNo)
      const key = String(parseScalar(line.text.slice(0, sep), line.lineNo))
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlLiteError(`重复键: ${key}`, line.lineNo)
      const rest = line.text.slice(sep + 1).trim()
      this.pos++
      if (rest === '') {
        const next = this.peek()
        if (next && next.indent > line.indent) out[key] = this.parseNode(next.indent)
        else out[key] = null
        continue
      }
      if (BLOCK_INDICATORS.has(rest)) out[key] = this.consumeBlockScalar(rest, line)
      else if (rest.startsWith('[')) out[key] = parseFlowSeq(rest, line.lineNo)
      else if (rest.startsWith('{')) out[key] = parseFlowMap(rest, line.lineNo)
      else out[key] = parseScalar(rest, line.lineNo)
    }
    return out
  }

  /** 块标量：消费所有比锚行更深缩进的显著行（预处理已折叠空行/注释行，见文件头注）。 */
  consumeBlockScalar(indicator, anchorLine) {
    const parts = []
    while (this.pos < this.lines.length && this.lines[this.pos].indent > anchorLine.indent) {
      parts.push(this.lines[this.pos].text)
      this.pos++
    }
    const folded = indicator[0] === '>'
    let s = folded ? parts.join(' ') : parts.join('\n')
    if (!indicator.includes('-')) s += '\n'
    return s
  }

  parseSequence(indent) {
    const out = []
    for (;;) {
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) throw new YamlLiteError(`序列缩进意外: ${line.text}`, line.lineNo)
      if (!(line.text === '-' || line.text.startsWith('- '))) break
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      if (rest === '') {
        this.pos++
        const next = this.peek()
        if (next && next.indent > indent) out.push(this.parseNode(next.indent))
        else out.push(null)
        continue
      }
      const sep = findKeySep(rest)
      if (sep >= 0) {
        // `- key: value`：把当前行改写为映射首行（内容起始列 = indent + 2），随后行按同列续写
        const contentCol = line.indent + (line.text.length - line.text.replace(/^-+\s*/, '').length)
        this.lines[this.pos] = { indent: contentCol, text: rest, lineNo: line.lineNo }
        out.push(this.parseMapping(contentCol))
        continue
      }
      out.push(rest.startsWith('[') ? parseFlowSeq(rest, line.lineNo) : rest.startsWith('{') ? parseFlowMap(rest, line.lineNo) : parseScalar(rest, line.lineNo))
      this.pos++
      continue
    }
    return out
  }
}

/**
 * 降级解析入口（零依赖）。空文本 → null；非映射/序列文档按原样返回；
 * 非法形态抛错（`.reason` 携带原因，供 validate.mjs 报「YAML 解析失败: <reason>」）。
 * @param {string} text
 * @returns {unknown}
 */
export function parseYamlLite(text) {
  return new Parser(text).parseDocument()
}
