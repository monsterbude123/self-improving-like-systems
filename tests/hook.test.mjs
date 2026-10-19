/**
 * hook.test.mjs —— SessionStart 接线自包含测试（node:test，零框架依赖；`node <本文件>` 直跑）
 *
 * 口径（票 07 AC 全部 fixture 化）：接线片段形态 + **命令级执行**（直接跑片段里的 argv，
 * 不以"agent 上下文出现"这种不可自动判的口径）+ 两条降级路径 + kill-switch off + 量级断言。
 * 开态一律用 env SELF_IMPROVING_CONFIG 指向 fixture 配置，**不动实例配置的 kill-switch 默认值**。
 * fixture = tests/fixtures/hook/（每用例整体拷到临时目录）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const FRAGMENT = path.join(SKILL_ROOT, 'references', 'hook-wiring.json')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'hook')

/** 每用例一份全新拷贝：audit/ 与 events/ 是写入型目录，不许跨用例共享。 */
function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hook-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** 接线片段 → argv（把 ${ZCODE_PROJECT_DIR} 与 <SKILL_DIR> 换成实际值；命令级执行的唯一来源）。 */
function hookArgv(projectDir) {
  const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8'))
  const hook = fragment.events.SessionStart[0].hooks[0]
  return {
    hook,
    argv: hook.args.map((a) => a.replace(/\$\{ZCODE_PROJECT_DIR\}/g, projectDir).replace(/<SKILL_DIR>/g, SKILL_ROOT)),
  }
}

/** 跑钩子命令（cwd=项目目录；SELF_IMPROVING_CONFIG 指向 fixture 配置；30s 超时防挂死）。 */
function runHook(projectDir, configFile, extra = []) {
  const { hook, argv } = hookArgv(projectDir)
  // 宿主同构形态：command + args 拼成一条命令行（片段里的 ${ZCODE_PROJECT_DIR} 由宿主展开）
  const r = spawnSync(hook.command, [...argv, ...extra], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: configFile },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function readAudit(dir, sub = 'audit/audit.jsonl') {
  const p = path.join(dir, sub)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

describe('接线片段形态（只增不改）', () => {
  it('片段只声明 SessionStart 一个事件键 —— 绝不夹带/改写其他事件条目', () => {
    const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8'))
    assert.deepEqual(Object.keys(fragment.events), ['SessionStart'], '片段只能新增 SessionStart 键')
    const hook = fragment.events.SessionStart[0].hooks[0]
    assert.equal(hook.type, 'process', '必须与宿主现有 process 型钩子同构')
    assert.equal(hook.command, 'node', '必须是 process 型的直接 argv（不经包管理器 run 层）')
    assert.equal(hook.enabled, true)
    assert.ok(hook.args.includes('--project-dir'), '必须把 ${ZCODE_PROJECT_DIR} 传进去')
    assert.ok(hook.args.some((a) => a.includes('${ZCODE_PROJECT_DIR}')), 'argv 必须含占位符形态')
  })

  it('量级：budget_ms ≪ timeout_ms ≤ 钩子 timeoutMs（三层超时留足余量）', () => {
    const cfg = readFileSync(path.join(FIXTURE_DIR, 'config-on.yaml'), 'utf8')
    const inj = cfg.split('injection:')[1].split('retire:')[0]
    const budgetMs = Number(/budget_ms:\s*(\d+)/.exec(inj)[1])
    const timeoutMs = Number(/timeout_ms:\s*(\d+)/.exec(inj)[1])
    assert.ok(budgetMs * 5 <= timeoutMs, `budget_ms(${budgetMs}) 必须远小于 timeout_ms(${timeoutMs})`)
    const hookTimeout = hookArgv(SKILL_ROOT).hook.timeoutMs
    assert.ok(timeoutMs <= hookTimeout, `钩子 timeoutMs(${hookTimeout}) 必须 ≥ config.timeout_ms(${timeoutMs})`)
    assert.ok(budgetMs * 10 <= hookTimeout, `钩子 timeoutMs(${hookTimeout}) 相对 budget_ms(${budgetMs}) 余量不足`)
  })
})

describe('接线命令级验收（以 ${ZCODE_PROJECT_DIR} 直接执行）', () => {
  it('正向：stdout 就是注入块（含出处与命中计数）、exit 0；域取自 config.hook.default_scopes', () => {
    const tmp = freshTmp()
    try {
      const r = runHook(tmp, path.join(tmp, 'config-on.yaml'))
      assert.equal(r.status, 0, `期望 exit 0，实得 ${r.status}\n${r.all}`)
      assert.match(r.stdout, /^## 经验注入/, `stdout 必须是注入块:\n${r.stdout}`)
      assert.match(r.stdout, /scope=infra,testing/)
      assert.match(r.stdout, /出处: entries\/LRN-20261016-010-docker-cache\.md/)
      assert.match(r.stdout, /命中 \d+ 次/)
      // 域过滤仍生效：data-ui 条目不在 default_scopes 内 → 不出现
      assert.ok(!r.stdout.includes('ERR-20261016-012-ui-cross'), '跨域条目不得进 SessionStart 块')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('kill-switch injection=off（实例当前真值）：stdout 空、exit 0、零审计副作用', () => {
    const tmp = freshTmp()
    try {
      const r = runHook(tmp, path.join(tmp, 'config-off.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', `off 态不得输出任何注入:\n${r.stdout}`)
      assert.ok(!existsSync(path.join(tmp, 'audit', 'audit.jsonl')), 'off 态不得写审计（零副作用）')
      assert.match(r.stderr, /kill_switch\.injection=false/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('降级路径（钩子级可测）', () => {
  it('超字符预算 → 标题行列表（长度 ≤ budget_chars，无出处/计数详情）', () => {
    const tmp = freshTmp()
    try {
      const r = runHook(tmp, path.join(tmp, 'config-tiny-budget.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /降级/)
      assert.ok(r.stdout.length <= 120, `降级后长度 ${r.stdout.length} > 预算 120:\n${r.stdout}`)
      assert.match(r.stdout, /^- \[LRN-/m, '降级块必须是标题行列表')
      assert.ok(!r.stdout.includes('出处:'), '降级块不得含出处详情')
      assert.ok(readAudit(tmp).some((x) => x.action === 'budget-degraded'), '字符预算降级未落审计')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('超时间预算（budget_ms=5 + 数百条目）→ 仅标题行 + 审计 time-degraded', () => {
    const tmp = freshTmp()
    try {
      // 造量：注入计算耗时必然超过 5ms（确定性触发，不赌毫秒级时序）
      for (let i = 0; i < 400; i++) {
        writeFileSync(
          path.join(tmp, 'entries', `LRN-20261016-1${String(i).padStart(3, '0')}-bulk.md`),
          `---\ntype: LRN\nstatus: active\nscope: infra\nclaim: "批量条目 ${i} docker cache 指纹"\nguard_ref: null\nrecurrence: 0\nlast_verified_at: null\n---\n\n# 批量条目 ${i}\n`,
          'utf8',
        )
      }
      const r = runHook(tmp, path.join(tmp, 'config-tiny-time.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /^## 经验注入/)
      assert.match(r.stdout, /超时间预算/, `应走时间预算降级:\n${r.stdout}`)
      assert.ok(!r.stdout.includes('出处:'), '时间降级块不得含条目详情')
      const rec = readAudit(tmp).find((x) => x.action === 'time-degraded')
      assert.ok(rec, '时间预算降级未落审计')
      assert.ok(rec.elapsed_ms > rec.budget_ms, `审计须证明超预算: ${JSON.stringify(rec)}`)
      assert.equal(rec.budget_ms, 5)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('钩子绝不能把会话启动搞失败', () => {
  it('配置损坏 → exit 0、空块、fail-open 审计', () => {
    const tmp = freshTmp()
    try {
      writeFileSync(path.join(tmp, 'config-broken.yaml'), 'version: 1\nscope: [oops\n', 'utf8')
      const r = runHook(tmp, path.join(tmp, 'config-broken.yaml'))
      assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.all}`)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /fail-open/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('hook.default_scopes 写错域 → 过滤 + 提示，不硬失败', () => {
    const tmp = freshTmp()
    try {
      const cfg = readFileSync(path.join(tmp, 'config-on.yaml'), 'utf8').replace(
        'default_scopes: [infra, testing]',
        'default_scopes: [infra, bogus]',
      )
      writeFileSync(path.join(tmp, 'config-badscope.yaml'), cfg, 'utf8')
      const r = runHook(tmp, path.join(tmp, 'config-badscope.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.match(r.stderr, /忽略非法域 bogus/)
      assert.match(r.stdout, /scope=infra/, '合法域仍应注入')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('无可注入域（default_scopes 为空）→ 空输出、exit 0（零噪音优先）', () => {
    const tmp = freshTmp()
    try {
      const cfg = readFileSync(path.join(tmp, 'config-on.yaml'), 'utf8').replace(
        'default_scopes: [infra, testing]',
        'default_scopes: []',
      )
      writeFileSync(path.join(tmp, 'config-noscope.yaml'), cfg, 'utf8')
      const r = runHook(tmp, path.join(tmp, 'config-noscope.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', '无域时不得输出噪音')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('参数用法错误 → exit 2（接线配错要响）', () => {
    const tmp = freshTmp()
    try {
      const r = runHook(tmp, path.join(tmp, 'config-off.yaml'), ['--nope'])
      assert.equal(r.status, 2, r.all)
      assert.match(r.stderr, /用法错误/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('近期触发事件并入（票 08 的并入点）', () => {
  it('已有事件 → 注入块后附「近期触发事件」小节（含 fingerprint 与累计次数）', () => {
    const tmp = freshTmp()
    try {
      mkdirSync(path.join(tmp, 'events'), { recursive: true })
      writeFileSync(
        path.join(tmp, 'events', 'events-20261016.jsonl'),
        `${JSON.stringify({
          id: 'evt-20261016-001', ts: '2026-10-16T01:00:00.000Z', first_ts: '2026-10-16T01:00:00.000Z',
          last_ts: '2026-10-16T02:00:00.000Z', count: 2, source: 'gate', kind: 'gate_block',
          severity: 'error', payload: {}, fingerprint: 'fp-deadbeefdeadbeef', codes: [], tokens: [],
          near_neighbors: [], entry_id: null,
        })}\n`,
        'utf8',
      )
      const r = runHook(tmp, path.join(tmp, 'config-on.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /## 近期触发事件/, `未并入近期事件:\n${r.stdout}`)
      assert.match(r.stdout, /fp-deadbeefdeadbeef/)
      assert.match(r.stdout, /累计 2 次/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('无事件目录 → 不输出该小节（零噪音）', () => {
    const tmp = freshTmp()
    try {
      const r = runHook(tmp, path.join(tmp, 'config-on.yaml'))
      assert.equal(r.status, 0, r.all)
      assert.ok(!r.stdout.includes('## 近期触发事件'), '无事件时不得输出该小节')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
