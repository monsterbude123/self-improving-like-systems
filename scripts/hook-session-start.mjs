#!/usr/bin/env node
/**
 * hook-session-start.mjs —— SessionStart 预加载接线（通用技能，零项目耦合，宿主可跑）
 *
 * 角色：会话启动 / 恢复时把 top-K 相关经验条目的摘要块打到 stdout，由 ZCode 的
 * SessionStart 钩子原样拼进 agent 上下文（出处在 `../references/hook-wiring.md`，
 * 片段是 `../references/hook-wiring.json`，两者由 tests/hook.test.mjs 直接执行验收）。
 *
 * 用法：
 *   node hook-session-start.mjs [--project-dir <目录>] [--scopes <域>[,<域>]]
 *                              [--max-events <n>] [--config <p>]
 *   --project-dir  会话所属项目目录（钩子传 ${ZCODE_PROJECT_DIR}）。配置链以它为仓根基准解析。
 *   --scopes       显式指定域（缺省取 config.hook.default_scopes）
 *   --max-events   附带的「近期触发事件」条数，0 = 不附带（缺省 3）
 *   --config       配置链同 inject.mjs：--config > env SELF_IMPROVING_CONFIG > 仓根 > 内置默认
 *
 * 为什么 hook 无法从用户 prompt 推断域、于是要一个"保守默认"：
 *   SessionStart 时还没有 prompt，域无从推断。可选默认有三类 —— ①空（不注入，等
 *   用户 prompt 走别的注入点）；②全量域（噪音最大，等于把知识库整页塞进上下文）；
 *   ③配置声明的少数几个"会话期最常踩"域。本实现取 ③：`config.hook.default_scopes`，
 *   取值由项目按自己的语料主题分组填，模板默认 `[]`（零注入）；本仓实例填 infra/testing
 *   （启动期最常命中的两类：环境/构建与测试/门禁）。取舍：宁可漏注入也不噪音 ——
 *   漏掉的域还有 UserPromptSubmit 侧的兜底路径，而噪音进上下文是不可逆的上下文预算损耗。
 *
 * 输出（stdout 单块，供钩子拼进上下文）：
 *   ① 注入块（scope 过滤 + top_k + 预算降级，渲染逻辑 import inject.mjs 的 runInject，不复制第二份）
 *   ② 「近期触发事件」小节（票 08 事件捕获的并入点；无事件 = 零噪音，不输出）
 *   ③ 「守卫健康度」小节（GitHub issue #2 的可见性出口；有守卫债才输出，零债 = 零噪音）
 *
 * ## ③ 为什么要有守卫健康度
 *
 * 守卫自己报错时按设计 fail-open（放行、不阻塞提交）—— 这条纪律没错，但**没人看得见**：
 * 接入项目的 pre-commit 把层的输出收进每守卫日志文件、成功时不回显。
 * 于是「判据根本没在跑」可以累计几十次而全程零报错。本小节把这件事抬到会话开头，
 * 让 agent 与人第一眼就知道「这几条守卫不拦你」。
 * **只可见性，不改放行行为**：守卫坏了照样放行（fail-open 纪律不变）。
 * 判定与渲染复用 `run-guard.mjs` 的 `collectDebtGuards` / `renderDebtSection`（判据只此一份）。
 *
 * 退出码：0 = 一切正常（含 kill-switch off、fail-open、零命中）；2 = 参数用法错误。
 * **任何内部异常 fail-open**：stdout 空 + 审计一条 + exit 0 —— 钩子绝不能把会话启动搞失败。
 * 时间预算（config.injection.budget_ms）只约束注入计算本身：超预算降级为仅标题行，
 * 保证外层钩子超时（须满足 budget_ms ≪ timeout_ms，量级断言在 tests/hook.test.mjs）。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadContext, runInject, flushAudit, failOpen } from './inject.mjs'
import { readRecentEvents, renderRecentSection } from './capture.mjs'
import { DEBT_MAX_CHARS, readDebtGuards, renderDebtSection } from './run-guard.mjs'

/** 守卫债小节在预算被吃光时的紧凑摘要长度上限（「有几条在报错」这句话本身要放得下）。 */
const DEBT_COMPACT_CHARS = 60

function usage(msg) {
  console.error(`用法错误：${msg}
  node hook-session-start.mjs [--project-dir <目录>] [--scopes <域>,...] [--max-events <n>] [--config <p>]
  退出码：0=正常（含 fail-open 与 kill-switch off） / 2=用法错误`)
  return 2
}

export function main(argv) {
  // ===== 1. 参数（纯接线错误 → exit 2；argv 来自固定钩子配置，人不可填）=====
  let cliConfig = null
  let projectDir = process.cwd()
  let scopesArg = null
  let maxEvents = 3
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config' || a === '--project-dir' || a === '--scopes' || a === '--max-events') {
      const next = argv[i + 1]
      if (next === undefined) return usage(`${a} 后须跟值`)
      i++
      if (a === '--config') cliConfig = path.resolve(next)
      else if (a === '--project-dir') projectDir = path.resolve(next)
      else if (a === '--scopes') scopesArg = next
      else {
        maxEvents = Number.parseInt(next, 10)
        if (!Number.isInteger(maxEvents) || maxEvents < 0) return usage('--max-events 须为 ≥0 整数')
      }
    } else {
      return usage(`未知参数 ${a}`)
    }
  }

  // ===== 2. 配置链（与 inject.mjs 同一份 loadContext；失败 fail-open，绝不阻塞会话）=====
  let config = null
  let baseDir = null
  try {
    const loaded = loadContext({ cliConfig, env: process.env, cwd: projectDir })
    config = loaded.config
    baseDir = loaded.baseDir
  } catch (e) {
    return failOpen(e, (e && e.config) || null, (e && e.baseDir) || null, 'hook')
  }

  // ===== 3. kill-switch off：零输出零副作用（接线存在 ≠ 功能开启）=====
  if (config.kill_switch.injection !== true) {
    console.error('[hook-session-start] kill_switch.injection=false，SessionStart 不注入（零输出、零副作用）')
    return 0
  }

  // ===== 4. 守卫健康度小节（issue #2）：**与注入路径解耦**，先算出来 =====
  // 它读的是**守卫状态账**，不是条目库 —— 所以「无可注入域」「条目目录缺失」「注入超时降级」
  // 都不该把它一起吞掉。模板默认 `hook.default_scopes` 为空（scripts/config.example.yaml），
  // 若把它挂在注入块后面，接进来的项目默认就看不到守卫债 —— 而「会话开头看得见」
  // 正是这个出口存在的理由。
  const debt = readDebtGuards({ config, baseDir })
  if (debt.read === 'invalid' || debt.read === 'error') {
    // 账读不动 ≠ 零债：静默说「一切正常」等于把「看不见」换了个说法。
    console.error(`[hook-session-start] ⚠ 守卫状态账读不动（${debt.path}）—— 守卫债清单可能不完整，别当「零债」看`)
  }
  /** 注入块之外还能给小节多少字符（配置的总预算减去已用掉的）。 */
  const debtBudget = (used) => {
    const budget = Number.isInteger(config.injection.budget_chars) && config.injection.budget_chars > 0 ? config.injection.budget_chars : 2000
    const remaining = Math.max(0, budget - used)
    // 至少给「紧凑摘要」留位置：守卫债有几句在报错，不该因为注入块吃满预算就整段消失。
    return Math.min(DEBT_MAX_CHARS, Math.max(remaining, DEBT_COMPACT_CHARS))
  }

  // ===== 5. 域解析：--scopes > config.hook.default_scopes > []（空 = 不注入）=====
  // 非法域一律**过滤掉并提示**（而不是 exit 2）：配置写错时钩子仍要能给出其余合法域的注入，
  // 硬失败等于让一次配置笔误废掉整条会话预加载。
  const configured = config.hook && Array.isArray(config.hook.default_scopes) ? config.hook.default_scopes : []
  const rawScopes = scopesArg !== null ? scopesArg.split(',') : configured
  const scopes = []
  for (const s of rawScopes) {
    const v = String(s).trim()
    if (v === '') continue
    if (!config.scope.values.includes(v)) {
      console.error(`[hook-session-start] 忽略非法域 ${v}（合法值: ${config.scope.values.join(', ')}）`)
      continue
    }
    if (v === config.scope.default) {
      console.error(`[hook-session-start] 忽略默认桶 ${v}（fail-safe：该桶永不注入）`)
      continue
    }
    if (!scopes.includes(v)) scopes.push(v)
  }
  if (scopes.length === 0) {
    console.error('[hook-session-start] 无可注入域（hook.default_scopes 为空或全被过滤），零注入')
    // 没有域只是「没有经验要注入」，**不是**「没有债要说」：守卫债照样给出去。
    const only = renderDebtSection(debt.rows, { maxChars: debtBudget(0) })
    if (only !== '') process.stdout.write(only)
    return 0
  }

  // ===== 6. 注入计算（带时间预算）+ 近期事件并入=====
  const auditRecords = []
  try {
    const budgetMs = Number.isInteger(config.injection.budget_ms) && config.injection.budget_ms > 0 ? config.injection.budget_ms : 300
    const startedAt = Date.now()
    let block = runInject(config, scopes, [], baseDir, auditRecords)
    const elapsed = Date.now() - startedAt

    // ===== 超时间预算降级：仅标题行（不再追加条目正文，保住外层钩子超时余量）=====
    if (elapsed > budgetMs) {
      const budgetChars = Number.isInteger(config.injection.budget_chars) && config.injection.budget_chars > 0 ? config.injection.budget_chars : 2000
      // 条目目录从 config.storage.entries_dir 派生（2026-10-16 · 架构审计 F5）：
      // 此前此处硬编码本仓的 `.learnings/`，而这段是**用户可见**的注入上下文 ——
      // 第二个项目接线时，降级提示会把 agent 指向一个根本不存在的目录。
      const entriesDir = typeof config.storage?.entries_dir === 'string' ? config.storage.entries_dir.trim() : ''
      const header = `## 经验注入（scope=${scopes.join(',')} · 超时间预算(${elapsed}ms>${budgetMs}ms)降级为仅标题行 · 条目见 ${entriesDir || '（条目目录未在配置中声明）'} 或重试注入）`
      auditRecords.push({ action: 'time-degraded', elapsed_ms: elapsed, budget_ms: budgetMs, scopes: [...scopes] })
      block = `${header.slice(0, Math.max(1, budgetChars - 1))}\n`
    }

    if (maxEvents > 0) {
      const recent = readRecentEvents(config, baseDir, maxEvents)
      block += renderRecentSection(recent)
    }

    // ===== 守卫健康度小节（issue #2）：有守卫债才输出，零债 = 零噪音 =====
    // 只读状态账（不 spawn、不写盘）。判定与渲染在 run-guard.mjs 里（判据只此一份）。
    const debtSection = renderDebtSection(debt.rows, { maxChars: debtBudget(block.length) })
    if (debtSection !== '') block += debtSection

    flushAudit(config, baseDir, auditRecords)
    if (block !== '') process.stdout.write(block)
    return 0
  } catch (e) {
    // 注入失败（条目目录缺失 / 条目不可读）→ 注入块为空，但**守卫债不能被一起吞掉**：
    // 它读的是另一本账，与注入失败无关。
    const code = failOpen(e, config, baseDir, 'hook')
    const only = renderDebtSection(debt.rows, { maxChars: debtBudget(0) })
    if (only !== '') process.stdout.write(only)
    return code
  }
}

// 仅当被直接执行时运行 CLI（导出供测试复用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
