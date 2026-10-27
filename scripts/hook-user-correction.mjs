#!/usr/bin/env node
/**
 * hook-user-correction.mjs —— 用户纠正信号捕获（UserPromptSubmit 接线层）
 *
 * ## 它解决什么问题
 *
 * 自进化系统此前只看得到**工具失败**（PostToolUseFailure）和**门禁拦截**（gate_block）。
 * 但用户指出「你又在犯同样的错」时，没有任何工具失败、没有任何门禁变红 ——
 * 事件库对这类反馈**完全失明**。于是下一次会话重犯，纠正一次也不沉淀。
 *
 * 用户在纠正时有一套稳定的口头禅（本仓实例，见 SIGNALS）。这套词是**唯一的、
 * 免费的、高信噪比**的「我做错了」信号。本钩子把它变成事件，
 * 使纠正能累积成 recurrence、经 distill 聚成失效模式簇、最终落成经验条目 + 守卫。
 *
 * ## 为什么指纹文本必须是 ASCII（踩过的坑，写在这里防止重犯）
 *
 * capture.mjs 的 `buildSkeleton` 有一句
 *   `.replace(/[^A-Za-z0-9#/._~|-]+/g, ' ')`
 * ——它会把**中文字符全部抹成空格**。若 `--text` 用中文写「用户纠正信号·挤牙膏式追问」，
 * 骨架会塌成空串，于是**六类信号共用同一个 fingerprint**，
 * 复发计数全部堆到一行、类别维度彻底丢失 —— 而这正是本功能存在的理由。
 * 故规范文本一律 ASCII（`user-correction signal=drip-feed`），中文原文放进
 * payload 的 `excerpt` 字段（不参与指纹计算，纯粹给人看）。
 *
 * ## 注入必须极短
 *
 * `UserPromptSubmit` 的 `additionalContext` 每轮都往消息历史里**追加**（累积，不覆盖）。
 * 命中才输出、未命中零输出；命中时正文压在几行内。宁可少说，不可每轮刷屏。
 *
 * ## 命中时除了记事件，还回收存量条目
 *
 * capture 默认会做检索并把**命中条目的注入块**打到 stdout。本钩子把它并进
 * additionalContext —— 于是纠正发生的那一刻，本来能防住这次失误的经验条目
 * 被重新推到眼前。这是本功能真正的闭环：**不是为了统计，是为了让下次不重犯**。
 *
 * ## 零信号一律静默
 *
 * 没命中 → 不输出、不写事件、不起子进程，exit 0。理由同族：钩子绝不搞失败会话。
 *
 * ## 子进程的 cwd 与配置链（GitHub issue #1 的修法）
 *
 * capture 子进程**用自己进程的 cwd** 解析配置链（`--config` > env > 仓根 > 内置默认）。
 * 若把它设成**层自己的目录**，层目录不是接入项目的仓根 ⇒ 仓根那条找不到 ⇒ 回落内置默认值
 * （`kill_switch.capture=false`）⇒ capture 提前 return ⇒ **零事件、零检索、且完全静默**
 * （capture 只往 stderr 打一句，而钩子当时把子进程 stderr 吞了）。
 * 这就是 issue #1：纠正信号一条都没落库，注入块里的「已命中的存量经验条目」恒空。
 *
 * 修法：**先在调用方 cwd 上把配置链解析一次**（复用 `inject.mjs` 的 `loadContext` ——
 * 配置链只有这一份实现），再把解析到的实例配置用 `--config` **钉死**传给子进程，
 * 子进程的 cwd 设为配置所在目录。钉死之后子进程的解析结果与自己的 cwd 无关
 * （也不必再跑一次 `resolveRepoRoot`）。
 *
 * ## 「有信号但没记账」≠「没有纠正信号」
 *
 * 事件没落库时（配置链解析失败 / `kill_switch.capture` 关着 / 子进程异常），钩子往 **stderr**
 * 打一行说明。**stdout 不动** —— stdout 是 additionalContext 通道（每轮往消息历史累积，
 * 形状不能变）。stderr 经项目侧薄壳的 `stdio: 'inherit'` 原样透到宿主的钩子日志，人看得见。
 *
 * 用法：
 *   node hook-user-correction.mjs            # 接线层（stdin = 钩子载荷 JSON）
 *   node hook-user-correction.mjs --probe    # 探测：只报告「提示词取自哪个键 + 命中哪些信号」，零写盘
 *   node hook-user-correction.mjs --text "..."  # 手工验证识别逻辑（零写盘）
 * 退出码：0 = 一切正常（含零信号与所有 fail-open）。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadContext } from './inject.mjs'

const SELF = path.dirname(fileURLToPath(import.meta.url))

/**
 * 纠正信号表。`id` 决定指纹（必须 ASCII，见文件头），`re` 只认用户明说的那几种说法。
 *
 * 刻意**窄**：宁可漏判也不误判 —— 误判的代价是每轮往消息历史里追加噪音块，
 * 而漏判的代价只是少记一次事件（纠正本身仍然发生在对话里，不会丢）。
 */
export const SIGNALS = [
  {
    id: 'repeat-stop',
    re: /不要再|别再|停止[^\n]{0,4}行为|住嘴/i,
    label: '用户已叫停的行为又出现了',
    lesson: '上一轮用户明确叫停过，先复盘那条指令再动手，不要重跑被否定的做法。',
  },
  {
    id: 'still-failing',
    re: /怎么还是|怎么又|为啥还|还是不行|又出现|又来了/i,
    label: '同一问题反复出现',
    lesson: '这不是第一次犯。查清上一次为什么没修掉（是没验证、还是修错了地方），不要只重跑一遍。',
  },
  {
    id: 'rule-violated',
    re: /违反规则|违规|不遵守规则|规则呢|规则在哪/i,
    label: '违反了明写规则',
    lesson: '规则已写在案上却没被遵守：说明它没有被触发或没有生效。查触发路径，不是补一句道歉。',
  },
  {
    id: 'not-read',
    re: /你看过吗|看过了吗|理解过吗|你懂了吗|读过吗/i,
    label: '没读已有材料就动手',
    lesson: '动手前把相关规则/文档/学习条目读完再写。这次是跳过了前置阅读。',
  },
  {
    id: 'make-me-repeat',
    re: /还要讲一遍|不要挤牙膏|挤牙膏|我说过了|还要我再说/i,
    label: '用户在被迫重复或嫌汇报分批',
    lesson: '一次把话说完：先给完整结论再展开，不要挤牙膏式分批汇报，也不要让用户重复你本该知道的事。',
  },
  {
    id: 'unexpected',
    re: /咋回事|怎么回事|什么情况/i,
    label: '结果出意外，用户在问原因',
    lesson: '先定位再回答，别先猜一个原因讲出来。承认不确定比编一个解释便宜。',
  },
]

/** 提示词在载荷里可能落在哪个键。按优先级取第一个非空字符串 —— 键名各宿主版本不一。 */
const PROMPT_KEYS = ['prompt', 'userPrompt', 'user_prompt', 'message', 'text', 'content']

/** 注入块硬上限（字符）。UserPromptSubmit 每轮累积，宁可截断不可刷屏。 */
const MAX_CONTEXT = 900

/**
 * 从载荷里取用户提示词。取不到返回 ''（调用方按零信号处理）。
 * @param {any} payload 已解析的载荷对象
 * @returns {{text:string, key:string|null}}
 */
export function promptFrom(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { text: '', key: null }
  for (const key of PROMPT_KEYS) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim() !== '') return { text: v, key }
  }
  return { text: '', key: null }
}

/**
 * 识别命中的纠正信号。同一条提示词命中多类时**全部保留**：
 * 一句话里「怎么还是…你看过吗」确实是两件不同的事，合并会丢掉可行动的差异。
 * @param {string} text 用户提示词
 * @returns {{id:string,label:string,lesson:string,matched:string}[]}
 */
export function detectSignals(text) {
  const s = String(text ?? '')
  if (s.trim() === '') return []
  const hits = []
  for (const sig of SIGNALS) {
    const m = sig.re.exec(s)
    if (m) hits.push({ id: sig.id, label: sig.label, lesson: sig.lesson, matched: m[0] })
  }
  return hits
}

/**
 * 解析「这次纠正要写进哪份配置、写到哪个基目录」——**一次钩子调用只解析一次**
 * （每条命中各解析一次 = 每次都重跑一遍 `git rev-parse` 找仓根）。
 *
 * 解析在**调用方 cwd** 上做（钩子是被宿主在项目里起的，那才是项目的位置），
 * 复用 `inject.mjs` 导出的 `loadContext` —— 配置链只有这一份实现，自己重写一份就是第二份真相。
 *
 * 失败不抛：返回 `{error}`，由调用方走 fail-open（不写事件，但要说清楚为什么没写）。
 *
 * @returns {{config:object|null, baseDir:string|null, configPath:string|null, error:Error|null}}
 */
export function resolveCaptureContext() {
  try {
    const loaded = loadContext({ env: process.env, cwd: process.cwd() })
    // configPath 归一成绝对路径：env 通道给相对路径时（相对**本进程**的 cwd 解释），
    // 子进程拿到绝对路径才不会在自己的 cwd 上重新解释一遍。
    const configPath = loaded.configPath ? path.resolve(loaded.configPath) : null
    const baseDir = configPath ? path.dirname(configPath) : loaded.baseDir
    return { config: loaded.config, baseDir, configPath, error: null }
  } catch (e) {
    return { config: null, baseDir: null, configPath: null, error: e }
  }
}

/**
 * 把一次命中写成事件。复用 capture.mjs 的 CLI 而不是自己写事件行 ——
 * 指纹计算 / 按日分片 / 同指纹归并 / kill-switch / 审计全在那边，
 * 这里自己实现一遍就是第二份真相（本仓最忌讳的形态）。
 *
 * 子进程数 = 命中的信号类别数（≤ SIGNALS.length，定值上界，与数据规模无关），
 * 符合 O(1) spawn 纪律：这里的 N 不是「文件数 / 条目数」这种会随仓库增长的量。
 *
 * @param {object} ctx `resolveCaptureContext()` 的结果（一次调用共用一份）
 */
function captureSignal(sig, payload, ctx) {
  // ===== 没落库的三种情形，一律 stderr 说清楚（stdout 形状不许变）=====
  if (ctx.error) {
    console.error(`[hook-user-correction] 配置链解析失败（${ctx.error.message}）—— 纠正信号未落库`)
    return ''
  }
  if (!ctx.config || ctx.config.kill_switch.capture !== true) {
    // 两种「没记账」的原因不同，说法也不同：没有实例配置（配置链落到内置默认值，
    // 内置默认值的 capture 开关本来就是关的）≠ 项目显式把开关关了。
    const why = ctx.configPath === null
      ? '没有实例配置（配置链落到内置默认值，内置的 capture 开关是关的）'
      : 'kill_switch.capture=false'
    console.error(`[hook-user-correction] ${why} —— 纠正信号未落库（事件捕获开关是关的）`)
    return ''
  }

  const cap = path.join(SELF, 'capture.mjs')
  const args = [
    cap,
    '--source', 'hook',
    '--kind', 'manual',
    '--payload', JSON.stringify({
      // ASCII 规范文本 → 骨架稳定 → 同类别跨会话归并成同一条、复发计数累积
      message: `user-correction signal=${sig.id}`,
      // 中文原文与上下文留在 excerpt，不参与指纹（指纹只吃 message/code/path/command）
      excerpt: (payload?.excerpt ?? '').slice(0, 200),
      signal: sig.id,
      hook_event: 'UserPromptSubmit',
      session_id: payload?.session_id ?? null,
    }),
  ]
  // 实例配置钉死传给子进程 —— issue #1 的修法本体：子进程此后与自己的 cwd 无关。
  if (ctx.configPath) args.push('--config', ctx.configPath)
  try {
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 15_000,
      // cwd = 配置所在目录（= capture 自己的 baseDir 语义），**不是层目录**。
      cwd: ctx.baseDir || process.cwd(),
    })
    if (r.error || r.status !== 0) {
      console.error(`[hook-user-correction] capture 子进程异常（exit=${r.status}${r.error ? ` · ${r.error.message}` : ''}）—— 纠正信号未落库`)
      return ''
    }
    return typeof r.stdout === 'string' ? r.stdout.trim() : ''
  } catch (e) {
    console.error(`[hook-user-correction] capture 子进程起不来（${e.message}）—— 纠正信号未落库`)
    return '' // 钩子永不因子进程失败而失败
  }
}

/**
 * 组装注入文本。**极短**：UserPromptSubmit 每轮累积进消息历史。
 * 存量条目块（capture 的检索输出）追加在后面，超长即截断。
 */
export function renderContext(hits, recalled) {
  const lines = ['【纠正信号】用户在纠正时用了下列表达 —— 这次纠正必须沉淀成可复用结论，不能只道歉：']
  for (const h of hits) lines.push(`· ${h.id}：${h.label} → ${h.lesson}`)
  const trimmed = (recalled || '').trim()
  if (trimmed !== '') lines.push('已命中的存量经验条目（先按它们执行，别重复犯错）：', trimmed)
  let out = lines.join('\n')
  if (out.length > MAX_CONTEXT) out = out.slice(0, MAX_CONTEXT) + '\n（注入块已截断）'
  return out
}

/** 只输出 additionalContext 通道；无命中时零输出。 */
function emitContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    }) + '\n',
  )
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let s = ''
  for await (const c of process.stdin) s += c
  return s
}

async function main() {
  const argv = process.argv.slice(2)
  const probe = argv.includes('--probe')

  // 手工验证路径：--text 直接喂提示词，零写盘
  const tIdx = argv.indexOf('--text')
  if (tIdx >= 0) {
    const hits = detectSignals(argv[tIdx + 1] ?? '')
    process.stdout.write(JSON.stringify({ mode: 'text', hits }, null, 1) + '\n')
    return 0
  }

  const raw = await readStdin()
  let payload = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  const { text, key } = promptFrom(payload)

  if (probe) {
    process.stdout.write(
      JSON.stringify(
        { mode: 'probe', payloadIsJson: payload !== null, promptKey: key, promptChars: text.length, hits: detectSignals(text) },
        null,
        1,
      ) + '\n',
    )
    return 0
  }

  // 零信号（无载荷 / 没取到提示词 / 没命中）→ 静默，零副作用
  const hits = detectSignals(text)
  if (hits.length === 0) return 0

  const excerpt = text.replace(/\s+/g, ' ').trim()
  // 配置链只解析一次（每条命中各解析一次 = 每次都重跑一遍 git 找仓根）
  const ctx = resolveCaptureContext()
  const recalled = hits.map((h) => captureSignal(h, { excerpt, session_id: payload?.session_id }, ctx)).join('\n')
  emitContext(renderContext(hits, recalled))
  return 0
}

/**
 * 仅当被直接执行时运行 CLI（导出供测试复用）。
 *
 * ⚠️ 这道守卫不是形式主义（2026-10-18 实测踩到）：少了它，测试 `import` 本模块
 * 就会执行 `main()` → `readStdin()` → 而 `node --test` 给子进程的 stdin 是永不关闭的
 * 管道 → **整个测试文件挂死到被 SIGTERM 掐掉**，症状是「断言全过但进程不退出」，
 * 完全看不出是这里。CLI 直跑时一切正常，所以只在跑测试时才暴露。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch(() => process.exit(0))
}
