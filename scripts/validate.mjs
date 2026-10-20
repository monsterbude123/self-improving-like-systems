#!/usr/bin/env node
/**
 * validate.mjs —— 经验/自进化系统 · schema 校验器 CLI（通用技能，零项目耦合）
 *
 * 用法：
 *   node validate.mjs <file...>          校验条目 frontmatter
 *   node validate.mjs --all [<dir>]      目录扫描（默认 <repo根>/<config.storage.entries_dir> 根层 *.md）
 *   node validate.mjs --config <p> ...   指定配置文件
 * 退出码：0 = 全部合规 / 1 = 存在违规（逐条打印条目名 + 违规原因）/ 2 = 用法错误
 *
 * 配置解析链（高优先 → 低优先）：
 *   --config 参数 > 环境变量 SELF_IMPROVING_CONFIG > <repo根>/.self-improving.yaml > 技能内置默认值
 * repo 根判定 = `git rev-parse --show-toplevel`（容错：git 不可用/非仓库时从 cwd 上溯找 .git）。
 * 本项目实例配置位置 = 仓库根 `.self-improving.yaml`（项目实例数据，技能只带 config.example.yaml）。
 *
 * 契约权威：references/schema.md（四实体字段）+ 配置文件（scope 枚举 / kill-switch 等参数）。
 * 本文件的导出（validateEntry / validateConfig / validateRegistryEntry / validateGuardBinding /
 * extractFrontmatter / NON_ENTRY_BASENAMES）供测试与后续消费方（门禁 / 注入 / 蒸馏等接线阶段）
 * 复用 —— 同一条规则只允许一份判据（单一归宿），禁止下游再写第二版。
 *
 * ===== YAML 双后端（宿主钩子可跑性）=====
 * YAML 一律经 ./lib/yaml-lite.mjs 的 parseYaml 读取：js-yaml 可用时优先 js-yaml（容器/全量），
 * 缺失时自动降级零依赖实现（宿主侧钩子跑宿主、宿主 node_modules 为空的实测教训）。
 * 禁止本文件直接 import js-yaml —— 静态 import 会让宿主端模块加载即炸。
 *
 * ===== O(1) spawn 纪律（本系统自身的反身约束）=====
 * 校验器必须保持**单进程**：目录枚举用 readdirSync（零子进程），逐文件读取用 readFileSync，
 * 全部判定在本进程内完成。禁止改成「按文件 spawn node/grep」—— 实测前科：48 个条目
 * 逐文件起子进程 ≈ 200 次 spawn、98 秒（Windows/Git Bash 每次 fork ~0.5s），瓶颈是 spawn
 * 不是算法。本文件出生就把这条禁令写在头上，后续加规则时不得改回循环 spawn。
 * （repo 根判定允许**每次 CLI 运行**一次 git rev-parse spawn —— 那是 O(1) 常数，不是每文件循环。）
 *
 * ===== kill-switch 职责边界 =====
 * 本校验器保证：三开关存在、类型为布尔（配置损坏/写错类型时识别并 exit 1）。
 * 「默认 false」断言 = config.example + 测试；「off 时对应功能零副作用」的功能级断言
 * 归各自接线阶段：injection / capture / distill 落地时分别断言。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseYaml } from './lib/yaml-lite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const CONFIG_ENV = 'SELF_IMPROVING_CONFIG'
const INSTANCE_CONFIG_NAME = '.self-improving.yaml'

// ===== 契约常量（schema.md §1 的可执行化；改这里必须同批改 schema.md + fixtures + 测试）=====

/** Entry frontmatter 必填键（全部必须**存在**；可空值的键写 null 占位）。 */
export const REQUIRED_ENTRY_KEYS = [
  'type',
  'status',
  'scope',
  'claim',
  'guard_ref',
  'recurrence',
  'last_verified_at',
]
/**
 * 可选键（检索元数据，schema.md §1.4）：**缺失不违规，类型错即红**。
 * 键集来自存量条目迁移前 frontmatter 的实况统计，不是臆造清单 —— 每个键都有真实检索价值
 * （tags=主题/工具检索、date=时间序检索、category=粗分类、resolved_*=闭环溯源）。
 * 新增可选键必须先在存量语料里找到实际出现的样本，否则不进契约。
 * 日期类键（date/resolved_date）强制字符串形态，理由见 isDateLiteral 注释（跨 YAML 后端判定必须同向）。
 *
 * ⚠ 唯一例外 = `skill_ref`（2026-10-17 裁决）：存量语料零先例，是为「这类经验的真实现位是
 * 一个 skill 章节、不是可执行守卫」而**新造**的键。放宽它而不是收紧 `guard_ref` 的理由见
 * references/schema.md §1.4 专段（一句话：塞进 `guard_ref` 等于在 trace 拍3/拍4/D13/verify 四处
 * 静默开口子；单开一键 + 双挂互斥，迁移面为 0）。
 */
export const OPTIONAL_ENTRY_KEYS = ['tags', 'date', 'category', 'resolved_date', 'resolved_by', 'event_ids', 'skill_ref']
/**
 * 事件 ID 形态判据（`evt-YYYYMMDD-NNN`）—— 条目 `event_ids` 与事件自身 `id` 共用。
 *
 * 之所以要有形态守卫：条目声明的来源事件会直接进拍1 的证据账（trace.mjs 据此判绿），
 * 一个手滑写错的字符串会变成一条**永不报错**的假关联 —— 拍1 看着绿，其实指向不存在的证据。
 */
export const EVENT_ID_RE = /^evt-\d{8}-\d{3}$/

/** 可选键类型判据表（校验器读它，不在分支里硬编码第二份）。 */
export const OPTIONAL_ENTRY_KEY_TYPES = {
  tags: 'string[]',
  date: 'date',
  category: 'string',
  resolved_date: 'date',
  resolved_by: 'string',
  // 拍1「事件」的来源事件 ID（`evt-YYYYMMDD-NNN`）。**方向是条目 → 事件，不是事件 → 条目**：
  // 事件库是只增不改的证据账（stoploss.md §2「事件是纯事实，只增不改、天然 append」），
  // 回写它的 `entry_id` 就破坏这条纪律；条目是人工裁决后的产物，声明「我由哪些事件学来」
  // 是它的本职。事件侧的 `entry_id` 字段保留在契约内（事件自身形态），但**拍1 判定以条目侧的
  // `event_ids` 为准**（trace.mjs）—— 两份事实源互相覆盖是最坏的一种漂移，宁可只留一个方向。
  event_ids: 'event-id[]',
  // 规程出处（2026-10-17）：`<skill-dir>#<章节标题>`，如 `example-skill#测试范围由影响面决定`。
  // **与 guard_ref 语义互斥**（见 validateEntry 的双挂判据）：guard_ref = 机器判据（registry 成员），
  // skill_ref = 人读的规程（无派发、无消费方）。两者形态刻意不同 —— skill-dir 段与 registry key
  // 共用小写连字符形态，章节标题自由文本（可含空格、不含 `#`），故 `#` 本身即分界符。
  skill_ref: 'skill-ref',
}
/**
 * `id` / `title` **刻意不在契约内**：ID 取自文件名（`<ID>-<slug>.md`）、标题取自正文 H1 ——
 * 在 frontmatter 里再存一份就等于开了第二份事实源，迟早与文件名/正文漂移（与「未知键即违规」同源）。
 * 旧 frontmatter 里曾有的这两个键在迁移时按此丢弃，不属于本次回填范围。
 */

/** type 枚举：与条目命名前缀（LRN|ERR|FEAT）一一对应。 */
export const TYPE_ENUM = ['LRN', 'ERR', 'FEAT']
/**
 * status 枚举：协议三台状态机的并集（schema.md §1.2）。
 * v0 不强制 type↔status 耦合 —— 蒸馏提案文件要用 LRN/ERR + proposed 组合。
 */
export const STATUS_ENUM = [
  'pending',
  'active',
  'resolved',
  'open',
  'investigating',
  'proposed',
  'approved',
  'shipped',
]
/** 配置必填段（scope/top-K/注入预算/retire/存储/白名单/kill-switch 缺一即红）。 */
export const REQUIRED_CONFIG_KEYS = [
  'version',
  'scope',
  'injection',
  'retire',
  'storage',
  'event_sources',
  'kill_switch',
]
/** kill-switch 三开关（缺一不可、必须布尔；默认 false 的断言在测试）。 */
export const KILL_SWITCH_KEYS = ['injection', 'capture', 'distill']

/**
 * 协议自身的配置版本。`config.version` 与之不符即**硬失败**，不静默按新协议解释旧配置。
 *
 * 为什么必须 fail-closed（2026-10-19 加固）：静默解释是这类系统最难查的失效形态 ——
 * 它不报错、不红、不掉帧，只是按你以为的语义跑；等某个字段被按新语义解读、经验召回悄悄变了样，
 * 只能从「结果不对」这个最外层的现象倒推回来。宁可让接入方升级时看到一条明确的「请迁移」，
 * 也不要它安静地半兼容。
 */
export const PROTOCOL_CONFIG_VERSION = 1

/**
 * 小写连字符名片段（**无锚点**，供组合成完整正则）。
 * registry key（guard_ref）与 skill 目录名（skill_ref 的 `#` 左侧）同属这一形态，
 * 只有一处定义 —— 两处形态若各写一份，迟早漂移（而 skill_ref 的左侧一旦放宽，
 * 「规程出处伪装成 registry key」的口子就又开了）。
 */
const LOWER_HYPHEN_NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*'
/** guard_ref 形态 = registry key（小写连字符），如 entry-guard-binding。存在性校验归门禁层。 */
const GUARD_KEY_RE = new RegExp(`^${LOWER_HYPHEN_NAME}$`)
/**
 * skill_ref 形态 = `<skill-dir>#<章节标题>`（规程出处，人读的章节，非机器判据）。
 *
 * 章节标题段自由文本：非空、不含 `#`（`#` 是分界符，出现两次就没法解析），允许空格与 CJK。
 *
 * 故意**不宽松**的三种形态（各对应一种真实手滑，缺判据即静默降级）：
 *   `Example-skill#x`（大写）—— skill 目录名是小写的，大写必是笔误；
 *   `example-skill`（缺 `#`）—— 分不清是 skill 名还是章节，解析不出来；
 *   `a--b#c`（连续连字符）—— 与 registry key 同判据，skill 名不可能这么写。
 */
const SKILL_REF_RE = new RegExp(`^${LOWER_HYPHEN_NAME}#[^#]+$`)
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** --all 扫描时豁免的目录级说明文件（无 frontmatter 也不算违规）。导出供绑定门禁复用。 */
export const NON_ENTRY_BASENAMES = new Set(['README.md', 'index.md'])

/**
 * 技能内置默认配置（配置链最后一环）：仓库根既无实例配置、也未传 --config / env 时使用。
 * 语义与 scripts/config.example.yaml 一致（两处同批改）；scope 枚举是项目接入时
 * 最常替换的键 —— 内置值只保证校验器开箱可跑，不代表任何项目的主题分组。
 */
export const BUILTIN_DEFAULT_CONFIG = {
  version: 1,
  scope: { values: ['infra', 'testing', 'git', 'data-ui', 'model', 'kb', 'other'], default: 'other' },
  injection: { top_k: 5, budget_chars: 2000, budget_ms: 300, timeout_ms: 3000 },
  retire: { cycle_days: 90 },
  storage: {
    entries_dir: '.self-improving/entries/',
    events_dir: '.self-improving/events/',
    proposals_dir: '.self-improving/proposals/',
    registry: '.self-improving/registry.yaml',
  },
  event_sources: ['gate', 'hook', 'tool', 'manual'],
  kill_switch: { injection: false, capture: false, distill: false },
}

function isValidDate(s) {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * `date` 类键的值判据：**必须是字符串** `YYYY-MM-DD`（不加引号的 YAML 时间戳形态不解）。
 *
 * 为什么强制字符串而不是兼容 YAML 时间戳（解成 Date）：两条 YAML 后端对非法时间戳的
 * 处理**不一致** —— yaml-lite 把 `2026-13-45` 留成字符串（可判红），js-yaml 按 `Date.UTC`
 * 进位成 `2027-02-14`（合法 Date，会判绿）。「同一条语料在容器内判绿、宿主钩子里判红」
 * 比「必须加引号」危险得多，故本契约只认字符串形态，要求写方加引号。
 * @param {unknown} v
 * @returns {boolean}
 */
function isDateLiteral(v) {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && isValidDate(v)
}

/** 日期类键：源码级强制带引号形态。 */
export const DATE_LITERAL_KEYS = ['date', 'resolved_date']
const QUOTED_DATE_LINE_RE = /^(date|resolved_date):\s*(?:"(\d{4}-\d{2}-\d{2})"|'(\d{4}-\d{2}-\d{2})')\s*$/
const DATE_KEY_LINE_RE = /^(date|resolved_date):/

/**
 * 日期类键的**源码级**判据：必须写成带引号的 `"YYYY-MM-DD"`。
 *
 * 为什么不在解析后的值上判：两条 YAML 后端对未加引号的日期处理**方向相反** ——
 * js-yaml 默认 schema 把它留成字符串（判绿），yaml-lite 强制转时间戳；而非法时间戳
 * `2026-13-45` 在 js-yaml 下会被 `Date.UTC` 进位成合法 Date 判绿、在 yaml-lite 下留成
 * 字符串判红。于是「解析后是不是字符串」「日期有效吗」两条判据**都可能两处异色**。
 * 唯一后端无关的落点是源码形态：同一段文本两个后端怎么解都不影响判定结果。
 *
 * @param {string} [rawText] 条目原文（CLI 传入；缺省时跳过此检查）
 * @returns {string[]} 违规原因
 */
export function checkDateLiteralSource(rawText) {
  if (typeof rawText !== 'string') return []
  const lines = rawText.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return []
  const out = []
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break
    const q = lines[i].match(QUOTED_DATE_LINE_RE)
    if (q) {
      const v = q[2] || q[3]
      if (!isValidDate(v)) out.push(`${q[1]} 非法: "${v}" 不是有效日历日期`)
      continue
    }
    if (DATE_KEY_LINE_RE.test(lines[i])) {
      out.push(`${lines[i].split(':')[0]} 非法（源码形态）: ${lines[i].trim()} 须写成带引号的 "YYYY-MM-DD"（schema.md §1.4：两后端对未加引号日期的解法不同，只有源码判定能保证同色）`)
    }
  }
  return out
}

/** 单个可选键的类型违规原因；合规返回 null。 */
function checkOptionalEntryValue(key, v) {
  const kind = OPTIONAL_ENTRY_KEY_TYPES[key]
  if (kind === 'string[]') {
    if (!Array.isArray(v)) return `${key} 非法: ${JSON.stringify(v)}（须为字符串数组）`
    if (v.some((t) => typeof t !== 'string')) {
      return `${key} 非法: 含非字符串元素（${JSON.stringify(v)}）—— 纯数字/日期类标签须加引号保持字符串`
    }
    return null
  }
  // 拍1 关联专用形态：不是"任意字符串数组"就够 —— 元素必须是能对上事件库的事件 ID，
  // 否则正文里随口提的字符串会被当成来源事实混进六拍链的证据账，且永不报错。
  if (kind === 'event-id[]') {
    if (!Array.isArray(v)) return `${key} 非法: ${JSON.stringify(v)}（须为事件 ID 数组）`
    const bad = v.filter((t) => typeof t !== 'string' || !EVENT_ID_RE.test(t))
    if (bad.length > 0) {
      return `${key} 非法: ${JSON.stringify(bad)}（元素须为 ${EVENT_ID_RE.source} 形态的事件 ID）`
    }
    return null
  }
  if (kind === 'date') {
    return isDateLiteral(v) ? null : `${key} 非法: ${JSON.stringify(v)}（须为带引号的 "YYYY-MM-DD" 字符串）`
  }
  if (kind === 'string') {
    return typeof v === 'string' && v.trim() !== '' ? null : `${key} 非法: 须为非空字符串`
  }
  // 规程出处：`<skill-dir>#<章节标题>`。**与 guard_ref 形态刻意不同** —— guard_ref 只收 registry key，
  // 收到 `skill#section` 即红（那是把规程出处伪装成机器判据，下游五处会静默查无此守卫）。
  if (kind === 'skill-ref') {
    if (typeof v !== 'string') return `${key} 非法: ${JSON.stringify(v)}（须为 "<skill-dir>#<章节标题>" 字符串）`
    if (!SKILL_REF_RE.test(v.trim())) {
      return `${key} 形态非法: ${JSON.stringify(v)}（须为 ${SKILL_REF_RE.source} —— skill-dir 小写连字符 + "#" + 非空章节标题；规程出处不得塞进 guard_ref）`
    }
    return null
  }
  return `${key} 类型未在契约中定义（OPTIONAL_ENTRY_KEY_TYPES 缺项）`
}

// ===== 纯函数（供测试与后续消费方复用）=====

/**
 * 校验 Entry frontmatter 对象。
 * @param {Record<string, unknown>} fm
 * @param {string[]} scopeValues 合法 scope 枚举（来自 config.scope.values，不在这里硬编码第二份）
 * @returns {string[]} 违规原因列表，空数组 = 合规
 */
export function validateEntry(fm, scopeValues, rawText) {
  const out = []
  // 日期类键先走源码级判定（后端无关）；rawText 缺省时跳过（纯对象调用的消费方）。
  out.push(...checkDateLiteralSource(rawText))
  for (const key of REQUIRED_ENTRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(fm, key)) out.push(`缺必填字段: ${key}`)
  }
  for (const key of Object.keys(fm)) {
    // 未知键仍红（单一归宿的严格性不因可选键的引入而松动）：契约内 = 7 必填 + OPTIONAL_ENTRY_KEYS。
    if (!REQUIRED_ENTRY_KEYS.includes(key) && !OPTIONAL_ENTRY_KEYS.includes(key)) {
      out.push(`未知字段: ${key}（契约见 references/schema.md §1）`)
    }
  }
  for (const key of OPTIONAL_ENTRY_KEYS) {
    if (!(key in fm)) continue
    const v = checkOptionalEntryValue(key, fm[key])
    if (v !== null) out.push(v)
  }
  if ('type' in fm && (typeof fm.type !== 'string' || !TYPE_ENUM.includes(fm.type))) {
    out.push(`type 非法: ${JSON.stringify(fm.type)}（可选 ${TYPE_ENUM.join(' | ')}）`)
  }
  if ('status' in fm && (typeof fm.status !== 'string' || !STATUS_ENUM.includes(fm.status))) {
    out.push(`status 非法: ${JSON.stringify(fm.status)}（可选 ${STATUS_ENUM.join(' | ')}，词表见 schema.md §1.2）`)
  }
  if ('scope' in fm && (typeof fm.scope !== 'string' || !scopeValues.includes(fm.scope))) {
    out.push(`scope 非法: ${JSON.stringify(fm.scope)}（合法值取自 config scope.values: ${scopeValues.join(', ')}）`)
  }
  if ('claim' in fm && (typeof fm.claim !== 'string' || fm.claim.trim() === '')) {
    out.push('claim 非法: 须为非空字符串（可证伪断言，schema.md §1.1）')
  }
  if ('guard_ref' in fm && fm.guard_ref !== null && (typeof fm.guard_ref !== 'string' || !GUARD_KEY_RE.test(fm.guard_ref))) {
    out.push(`guard_ref 形态非法: ${JSON.stringify(fm.guard_ref)}（须为 null 或 registry key 小写连字符形态；规程出处请写 skill_ref，不得用 "skill#section" 形态塞进本键）`)
  }
  // guard_ref（机器判据）与 skill_ref（规程出处）**双挂即红**：一条经验要么有可执行的判据、
  // 要么有规程出处。双挂会让条目同时持有「有覆盖者」与「规程章节永远派发不出判据」两种身份 ——
  // 观测账只认真执行过判据的派发，于是这条条目会拿着一个永远攒不到证据的覆盖者去参与退役判定。
  if (fm.guard_ref !== null && fm.guard_ref !== undefined && fm.skill_ref !== null && fm.skill_ref !== undefined) {
    out.push(
      `guard_ref 与 skill_ref 双挂: ${JSON.stringify(fm.guard_ref)} + ${JSON.stringify(fm.skill_ref)}` +
        `（机器判据与规程出处互斥 —— 一条经验要么有 guard、要么有规程出处；契约见 schema.md §1.4）`,
    )
  }
  if ('recurrence' in fm && (!Number.isInteger(fm.recurrence) || fm.recurrence < 0)) {
    out.push(`recurrence 非法: ${JSON.stringify(fm.recurrence)}（须为 ≥0 的整数）`)
  }
  if (
    'last_verified_at' in fm &&
    fm.last_verified_at !== null &&
    (typeof fm.last_verified_at !== 'string' || !ISO_DATE_RE.test(fm.last_verified_at) || !isValidDate(fm.last_verified_at))
  ) {
    out.push(`last_verified_at 非法: ${JSON.stringify(fm.last_verified_at)}（须为 null 或 YYYY-MM-DD）`)
  }
  return out
}

/**
 * 校验配置结构（schema.md 契约的可执行化）。
 * kill-switch 只认「存在 + 布尔」；默认 false 的断言在测试（改 true 不是结构违规，属行为开关）。
 * @param {unknown} config
 * @returns {string[]} 违规原因列表
 */
export function validateConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return ['config 不是 YAML 映射']
  const out = []
  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!(key in config)) out.push(`config 缺必填段: ${key}`)
  }
  // 版本 fail-closed：缺 version 由上面的必填段判红；这里管**在但对不上**。
  // 严格相等（不做字符串/数字互认）—— 半兼容比不兼容更难查。
  if ('version' in config && config.version !== PROTOCOL_CONFIG_VERSION) {
    out.push(`config.version ${JSON.stringify(config.version)} 与协议版本 ${PROTOCOL_CONFIG_VERSION} 不一致`
      + ` —— 拒绝按新协议解释旧配置，请先迁移该配置`)
  }
  if ('scope' in config) {
    const s = config.scope
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      out.push('config.scope 须为映射')
    } else {
      const values = s.values
      if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) {
        out.push('config.scope.values 须为非空字符串数组')
      } else if (typeof s.default !== 'string' || !values.includes(s.default)) {
        out.push(`config.scope.default ${JSON.stringify(s.default)} 不在 scope.values 内`)
      }
    }
  }
  if ('kill_switch' in config) {
    const ks = config.kill_switch
    if (ks === null || typeof ks !== 'object' || Array.isArray(ks)) {
      out.push('config.kill_switch 须为映射')
    } else {
      for (const k of KILL_SWITCH_KEYS) {
        if (!(k in ks)) out.push(`config.kill_switch 缺开关: ${k}（三开关必须显式存在，默认 false）`)
        else if (typeof ks[k] !== 'boolean') out.push(`config.kill_switch.${k} 必须是布尔值（当前: ${JSON.stringify(ks[k])}）`)
      }
      for (const k of Object.keys(ks)) {
        if (!KILL_SWITCH_KEYS.includes(k)) out.push(`config.kill_switch 未知开关: ${k}（三开关之外的键不被任何消费方读取）`)
      }
    }
  }
  return out
}

/**
 * 校验 registry.yaml 单条守卫条目与宿主 commit 钩子守卫数组的同构三键（key/args/when）。
 * v0 不拒绝附加键（shadow 语义元数据允许扩展），但三键缺一不可。
 * @param {unknown} entry
 * @returns {string[]} 违规原因列表
 */
export function validateRegistryEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return ['registry 条目须为映射']
  const out = []
  if (typeof entry.key !== 'string' || !GUARD_KEY_RE.test(entry.key)) {
    out.push(`key 形态非法: ${JSON.stringify(entry.key)}（须为小写连字符 registry key）`)
  }
  if (!Array.isArray(entry.args) || entry.args.length === 0 || entry.args.some((a) => typeof a !== 'string')) {
    out.push('args 须为非空字符串数组（同构守卫数组的 args：直调，不经包管理器脚本层）')
  }
  if (typeof entry.when !== 'string' || entry.when.trim() === '') {
    out.push('when 须为非空字符串（always 或 plan 字段谓词；翻译规则见 registry.example.yaml 注释）')
  }
  return out
}

/** covered_entries 条目 ID 形态（schema.md §3：`LRN|ERR|FEAT-YYYYMMDD-NNN`；不含随机后缀段）。 */
export const COVERED_ENTRY_ID_RE = /^(?:LRN|ERR|FEAT)-\d{8}-\d{3}$/

/**
 * registry 守卫条目 `covered_entries` 的存在性判据（schema.md §3「门禁校验每条在 entries_dir 存在」）。
 *
 * **为什么必须有这条**（2026-10-17 补洞）：此前 schema 声称门禁校验存在性，但全仓零实现 ——
 * 而退役机制（verify.mjs）恰恰靠 covered_entries 决定「哪些条目攒到了退役证据」：
 * 填错一个 ID 不会红，只会让那条目静默地永远攒不到证据、永不退役。
 * 同一 ID 命中多个文件也判违规：观测账按 ID 记账，歧义命中 = 退役证据张冠李戴
 * （与 verify.mjs 撞号显式拒绝、D13 编号唯一性同款纪律）。
 *
 * 纯函数：文件名列表由调用方一次 readdir 传入（判据本体不做 IO，守住 O(1) spawn 纪律；
 * staged 模式下调用方必须传**全量**枚举而非本次暂存子集，否则对上周已入库条目误报不存在）。
 * @param {unknown} coveredEntries registry 条目的 covered_entries 字段（缺省/空 = 无覆盖声明，合法 —— 债务桩即此形态）
 * @param {string[]} entryFileNames entries_dir 根层 *.md 文件名列表（调用方过滤好）
 * @returns {string[]} 违规原因列表，空数组 = 合规
 */
export function validateCoveredEntries(coveredEntries, entryFileNames) {
  if (coveredEntries === undefined || coveredEntries === null) return []
  if (!Array.isArray(coveredEntries)) {
    return [`covered_entries 须为字符串数组或缺省（当前: ${JSON.stringify(coveredEntries)}）`]
  }
  const names = Array.isArray(entryFileNames) ? entryFileNames : []
  const out = []
  for (const [i, id] of coveredEntries.entries()) {
    if (typeof id !== 'string' || !COVERED_ENTRY_ID_RE.test(id)) {
      out.push(`covered_entries[${i}] 形态非法: ${JSON.stringify(id)}（须为 ${COVERED_ENTRY_ID_RE.source}）`)
      continue
    }
    const hits = names.filter((n) => n === `${id}.md` || n.startsWith(`${id}-`))
    if (hits.length === 0) {
      out.push(`covered_entries[${i}] 引用的条目不存在: ${id}（entries_dir 内无 ${id}-*.md；该条目的退役证据将永远攒不到）`)
    } else if (hits.length > 1) {
      out.push(`covered_entries[${i}] 引用的条目歧义: ${id} 命中 ${hits.length} 个文件（${hits.join(' / ')}）—— 观测账按 ID 记账，歧义即证据张冠李戴`)
    }
  }
  return out
}

/**
 * G2 条目↔守卫绑定判据（schema.md §0「不在校验器内」的四条里，唯一回写到本文件的一条：
 * 由绑定门禁 import 本导出 —— 判据不写第二版；门禁只负责扫描、baseline 豁免与 Tier 0 路由）。
 * 规则：frontmatter `status === 'resolved'` ⇒ 必须有非空 `guard_ref`，且该 key 存在于
 * registry 的 guards[].key 集合；frontmatter 缺 `status` 无法判定绑定 → 也报违规
 * （未知状态不许静默通过 —— 「没有判据的 entry 是愿望不是教训」）。
 * @param {Record<string, unknown>} fm
 * @param {string[]} guardKeys registry 中已登记的守卫 key 集合（可为空数组）
 * @param {{entryId?: string, coveredEntriesByKey?: Record<string, string[]|undefined>}} [coverage]
 *   **反向账**（2026-10-17 补洞 · evt-20261017-031）：正向「guard_ref 的 key 存在」不等于
 *   「这个守卫真的声明覆盖了本条目」。trace 拍3 判的是 covered_entries，所以 key 存在但
 *   covered_entries 漏登记时，六拍对**每一个**这样的条目都结构性不可完成，而本判据此前全绿
 *   （实测：approve 同 key 已存在时整段跳过 registry 写入，第二个条目永远进不了 covered_entries，
 *   trace exit 1 的同时 D13 通过）。缺省不传 = 只跑正向（旧调用方零影响）。
 * @returns {string[]} 违规原因列表，空数组 = 合规
 */
export function validateGuardBinding(fm, guardKeys, coverage) {
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return ['frontmatter 不是映射，无法判定绑定']
  const keys = Array.isArray(guardKeys) ? guardKeys : []
  if (!('status' in fm)) return ['frontmatter 缺 status，无法判定绑定（契约见 references/schema.md §1）']
  if (fm.status !== 'resolved') return []
  const out = []
  if (!('guard_ref' in fm)) {
    out.push('resolved 条目缺 guard_ref —— 没有判据的 entry 是愿望不是教训（契约见 references/schema.md §0）')
    return out
  }
  const ref = fm.guard_ref
  if (ref === null || ref === '') {
    out.push('resolved 条目 guard_ref 为 null：绑定缺失（尚未在 registry 登记守卫）')
    return out
  }
  if (typeof ref !== 'string') {
    out.push(`guard_ref 非字符串: ${JSON.stringify(ref)}（应为 registry key）`)
    return out
  }
  if (coverage && typeof coverage === 'object' && coverage.entryId) {
    if (Array.isArray(coverage.exemptKeys) && coverage.exemptKeys.includes(ref)) {
      // debt-stub 按契约不声明覆盖（它指向绑定门禁自身），反向账对它不适用 —— 直接放行
    } else {
      const declared = Array.isArray(coverage.coveredEntriesByKey?.[ref]) ? coverage.coveredEntriesByKey[ref] : null
      if (declared === null) {
        out.push(`守卫 ${ref} 未声明 covered_entries：本条目 ${coverage.entryId} 自称绑定了它，反向账上没有它 —— 六拍拍3（守卫登记）必判红`)
      } else if (!declared.includes(coverage.entryId)) {
        out.push(
          `守卫 ${ref} 的 covered_entries 未含本条目 ${coverage.entryId}` +
            `（现有: ${declared.length ? declared.join(', ') : '空'}）—— 六拍拍3（守卫登记）必判红`,
        )
      }
    }
  }
  if (!keys.includes(ref)) {
    out.push(
      `guard_ref 指向 registry 中不存在的守卫: ${ref}` +
        (keys.length > 0 ? `（已登记: ${keys.join(', ')}）` : '（registry 尚无任何守卫）'),
    )
  }
  return out
}

// ===== 配置解析链 =====

/**
 * 判定仓库根：`git rev-parse --show-toplevel`（容错：git 不可用或非仓库时从 cwd 上溯找 .git）。
 * 找不到返回 null（随后配置链落到技能内置默认值）。
 * @param {string} cwd
 * @returns {string | null}
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) return out
  } catch {
    /* 非 git 仓库或 git 不可用 → 走 .git 上溯兜底 */
  }
  let dir = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 配置解析链：--config > env SELF_IMPROVING_CONFIG > <repo根>/.self-improving.yaml > 内置默认。
 * 只解析**路径**；文件不存在/解析失败的报错归 CLI 层（exit 1，与条目违规区分）。
 * @param {{ cliConfig?: string|null, env?: NodeJS.ProcessEnv, repoRoot?: string|null }} opts
 * @returns {{ path: string|null, source: string }} path=null 表示用技能内置默认值
 */
export function resolveConfigPath({ cliConfig = null, env = process.env, repoRoot = null } = {}) {
  if (cliConfig) return { path: cliConfig, source: '--config' }
  const envPath = env[CONFIG_ENV]
  if (envPath) return { path: envPath, source: `env ${CONFIG_ENV}` }
  if (repoRoot) {
    const inst = path.join(repoRoot, INSTANCE_CONFIG_NAME)
    if (existsSync(inst)) return { path: inst, source: 'repo-root instance' }
  }
  return { path: null, source: 'built-in defaults' }
}

// ===== CLI =====

/**
 * 解析 frontmatter：{fm} 成功 / {error} 失败原因。
 * 导出供绑定门禁复用 —— 「什么样的文本算有 frontmatter」也只允许这一份判据。
 * @param {string} text
 * @returns {{ fm?: Record<string, unknown>, error?: string }}
 */
export function extractFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return { error: '缺 frontmatter（首行必须是 ---）' }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break }
  }
  if (end === -1) return { error: 'frontmatter 未闭合（缺结束 --- 行）' }
  const body = lines.slice(1, end).join('\n')
  if (body.trim() === '') return { error: 'frontmatter 为空' }
  let parsed
  try {
    parsed = parseYaml(body)
  } catch (e) {
    return { error: `YAML 解析失败: ${e.reason || e.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'frontmatter 不是 YAML 映射' }
  return { fm: parsed }
}

function rel(p) {
  const r = path.relative(process.cwd(), p)
  return r || path.basename(p)
}

function usage(msg) {
  console.error(`用法错误：${msg}
  node validate.mjs <file...>             校验条目 frontmatter
  node validate.mjs --all [<dir>]         目录扫描（默认 <repo根>/<config.storage.entries_dir> 根层 *.md，不递归子目录）
  node validate.mjs --config <path> ...   指定配置（最高优先）
  配置链：--config > env ${CONFIG_ENV} > <repo根>/${INSTANCE_CONFIG_NAME} > 技能内置默认值
  退出码：0=合规 / 1=违规 / 2=用法错误`)
  return 2
}

function main(argv) {
  let cliConfig = null
  let allDir = null
  let allWanted = false
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') {
      const next = argv[i + 1]
      if (!next) return usage('--config 后须跟路径')
      i++
      cliConfig = path.resolve(next)
    } else if (a === '--all') {
      allWanted = true
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        i++
        allDir = path.resolve(next)
      }
    } else if (a.startsWith('-')) {
      return usage(`未知参数 ${a}`)
    } else {
      files.push(path.resolve(a))
    }
  }
  if (!allWanted && files.length === 0) return usage('缺校验目标：传 <file...> 或 --all [<dir>]')

  // ===== 配置链（先于条目校验：scope 枚举与 kill-switch 的判据都来自它）=====
  const repoRoot = resolveRepoRoot(process.cwd())
  const { path: configPath, source } = resolveConfigPath({ cliConfig, env: process.env, repoRoot })
  let config = null
  let configLabel = '<内置默认值>'
  if (configPath) {
    configLabel = rel(configPath)
    if (!existsSync(configPath)) {
      console.error(`FAIL config: 配置文件不存在 ${configPath}（来源 ${source}）`)
      return 1
    }
    try {
      config = parseYaml(readFileSync(configPath, 'utf8'))
    } catch (e) {
      console.error(`FAIL config: YAML 解析失败 ${configLabel}: ${e.reason || e.message}`)
      return 1
    }
    const cfgViolations = validateConfig(config)
    if (cfgViolations.length > 0) {
      console.error(`FAIL config: ${configLabel}`)
      for (const v of cfgViolations) console.error(`  - ${v}`)
      return 1
    }
  } else {
    config = BUILTIN_DEFAULT_CONFIG
    // 内置默认值是代码不是数据，结构由测试守（validateConfig 必须空）；这里只兜底实现 bug。
    const cfgViolations = validateConfig(config)
    if (cfgViolations.length > 0) {
      console.error('FAIL config: 技能内置默认值不合法（实现 bug，请检查 BUILTIN_DEFAULT_CONFIG）')
      for (const v of cfgViolations) console.error(`  - ${v}`)
      return 1
    }
  }
  const scopeValues = config.scope.values

  let targets = files
  if (allWanted) {
    // --all 缺目录时回落 <repo根>/config.storage.entries_dir（条目库是项目实例数据，路径取自配置）。
    if (allDir === null) {
      const entriesDir = config.storage && typeof config.storage.entries_dir === 'string' ? config.storage.entries_dir : null
      if (!repoRoot || !entriesDir) {
        console.error('用法错误：--all 缺 <dir>，且无法确定条目库位置（非 git 仓库或 config.storage.entries_dir 缺失）')
        return 2
      }
      allDir = path.resolve(repoRoot, entriesDir)
    }
    if (!existsSync(allDir) || !statSync(allDir).isDirectory()) {
      console.error(`用法错误：--all 目录不存在 ${allDir}`)
      return 2
    }
    // 零 spawn：readdirSync 一次枚举；不递归（archive/ 等子目录不在协议管辖内）。
    targets = readdirSync(allDir)
      .filter((f) => f.endsWith('.md') && !NON_ENTRY_BASENAMES.has(f))
      .sort()
      .map((f) => path.join(allDir, f))
    if (targets.length === 0) {
      console.error(`FAIL: ${rel(allDir)} 下无可校验条目（README/index 之外一个 *.md 都没有）`)
      return 1
    }
  }

  let bad = 0
  for (const file of targets) {
    const name = rel(file)
    let violations
    if (!existsSync(file)) {
      violations = ['文件不存在']
    } else {
      const raw = readFileSync(file, 'utf8')
      const { fm, error } = extractFrontmatter(raw)
      violations = error ? [error] : validateEntry(fm, scopeValues, raw)
    }
    if (violations.length > 0) {
      bad++
      console.error(`FAIL ${name}`)
      for (const v of violations) console.error(`  - ${v}`)
    }
  }
  if (bad > 0) {
    console.error(`FAIL: ${bad}/${targets.length} 个文件违规（契约 = ${path.join(SKILL_ROOT, 'references/schema.md')}）`)
    return 1
  }
  console.log(`PASS: ${targets.length} 个条目全部合规（配置 ${configLabel}；scope=${scopeValues.join(',')}）`)
  return 0
}

// 仅当被直接执行时运行 CLI（导出供测试复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
