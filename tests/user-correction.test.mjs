/**
 * user-correction.test.mjs —— 用户纠正信号捕获
 *
 * ## 要守住的性质（按重要性排序）
 *
 * 1. **同类别跨会话必须同一 fingerprint** —— 这是整套功能唯一的根据：
 *    指纹不稳定 = 复发计数归零 = 蒸馏看不到重复 = 永远沉淀不下来。
 * 2. **不同类别必须不同 fingerprint** —— 否则六类塌成一条，类别维度丢失。
 * 3. **零信号零输出** —— 钩子每轮都跑，误判一次的代价是往消息历史里追加噪音。
 * 4. **fail-open** —— 载荷坏掉 / 载荷里没有提示词，都必须 exit 0 且不抛。
 *
 * fixture = tests/fixtures/capture/（整体拷到临时目录，事件不落真实事件账）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { SIGNALS, detectSignals, promptFrom, renderContext } from '../scripts/hook-user-correction.mjs'
import { computeFingerprint } from '../scripts/capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'capture')
const HOOK = path.join(HERE, '..', 'scripts', 'hook-user-correction.mjs')

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'uc-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** 跑钩子；stdin 喂 payload。零写盘模式（--probe/--text）不会碰事件账。 */
function runHook(dir, payload, extra = []) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return spawnSync(process.execPath, [HOOK, ...extra], {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    cwd: dir,
    env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
  })
}

function eventLines(dir) {
  const eventsDir = path.join(dir, 'events')
  if (!existsSync(eventsDir)) return []
  return readdirSync(eventsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(path.join(eventsDir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
}

describe('detectSignals · 纠正信号识别', () => {
  it('六类信号各能被用户实际说法命中', () => {
    const cases = [
      ['不要再', 'repeat-stop'],
      ['怎么还是不行', 'still-failing'],
      ['为啥违反规则', 'rule-violated'],
      ['你看过吗，理解过吗', 'not-read'],
      ['还要讲一遍吗', 'make-me-repeat'],
      ['咋回事', 'unexpected'],
    ]
    for (const [phrase, id] of cases) {
      const hits = detectSignals(phrase)
      assert.ok(
        hits.some((h) => h.id === id),
        `「${phrase}」应命中 ${id}，实得 ${hits.map((h) => h.id).join(',') || '（无）'}`,
      )
    }
  })

  it('信号表恰好六类且 id 互不重复（删掉一条必红 = 破坏测试）', () => {
    const ids = SIGNALS.map((s) => s.id)
    assert.equal(ids.length, 6, '信号表被增删会让本断言变红 —— 增删信号必须同步这里')
    assert.equal(new Set(ids).size, ids.length, 'id 重复会让两类塌成同一 fingerprint')
    assert.deepEqual(
      [...ids].sort(),
      ['make-me-repeat', 'not-read', 'repeat-stop', 'rule-violated', 'still-failing', 'unexpected'],
    )
  })

  it('每条信号都带可行动的 lesson（只有标签、没有下一步的信号没有价值）', () => {
    for (const s of SIGNALS) {
      assert.ok(s.lesson && s.lesson.length >= 10, `${s.id} 缺少可行动的下一步`)
    }
  })

  it('普通业务提问不得误判（误判的代价是每轮往消息历史里塞噪音块）', () => {
    const neutral = [
      '把上面的代码跑一下',
      '这个功能怎么实现',
      '合并你的代码到my_dev',
      '合并到my_dev了吗',
      '继续处理剩下的内容',
      '处理完剩下的内容',
      '不要主动去主工作区操作',
    ]
    for (const t of neutral) {
      assert.deepEqual(detectSignals(t), [], `「${t}」不该命中任何纠正信号`)
    }
  })

  it('空输入零信号', () => {
    assert.deepEqual(detectSignals(''), [])
    assert.deepEqual(detectSignals('   '), [])
    assert.deepEqual(detectSignals(null), [])
  })
})

describe('★ fingerprint 稳定性（整套功能的根据）', () => {
  // 我们传给 capture 的规范文本。这一段拼法就是实现，改它必须同步这里。
  const canonical = (id) => `user-correction signal=${id}`

  it('同类别、不同原话 → 同一 fingerprint（复发计数才能累积）', () => {
    const a = computeFingerprint({ kind: 'manual', text: canonical('still-failing') })
    const b = computeFingerprint({ kind: 'manual', text: canonical('still-failing') })
    assert.equal(a.fingerprint, b.fingerprint)
    assert.ok(a.fingerprint, '必须算出指纹')
  })

  it('不同类别 → 不同 fingerprint（类别维度不塌陷）', () => {
    const fps = SIGNALS.map((s) => computeFingerprint({ kind: 'manual', text: canonical(s.id) }).fingerprint)
    assert.equal(new Set(fps).size, fps.length, '六类塌成同一 fingerprint = 类别维度丢失')
  })

  it('★ 规范文本必须是 ASCII：buildSkeleton 会把中文抹成空串', () => {
    // 这是本功能最大的一个隐蔽坑，必须钉死：
    // capture 的骨架归一化 `[^A-Za-z0-9#/._~|-]+ → 空格` 会删光中文字符，
    // 若规范文本写成中文，六类信号的骨架全塌成同一个空串 → 指纹全同。
    const cn = computeFingerprint({ kind: 'manual', text: '用户纠正信号：挤牙膏式追问' })
    const cn2 = computeFingerprint({ kind: 'manual', text: '用户纠正信号：违反了明写规则' })
    assert.equal(cn.fingerprint, cn2.fingerprint, '中文规范文本确实会塌成同一指纹 —— 这正是必须用 ASCII 的原因')

    // 而我们实际用的 ASCII 文本不会塌：
    const en = computeFingerprint({ kind: 'manual', text: canonical('make-me-repeat') })
    const en2 = computeFingerprint({ kind: 'manual', text: canonical('rule-violated') })
    assert.notEqual(en.fingerprint, en2.fingerprint, 'ASCII 规范文本保持了类别区分度')
    assert.ok(en.tokens.length > 0, '骨架必须有 token，否则蒸馏拿不到抓手')
  })
})

describe('promptFrom · 载荷取词', () => {
  it('按优先级取第一个非空字符串', () => {
    assert.equal(promptFrom({ prompt: 'a' }).key, 'prompt')
    assert.equal(promptFrom({ userPrompt: 'b' }).key, 'userPrompt')
    assert.equal(promptFrom({ user_prompt: 'c' }).key, 'user_prompt')
    assert.equal(promptFrom({ message: 'd' }).key, 'message')
  })

  it('取不到返回空（键名对不上就安静退化成零信号，不猜）', () => {
    assert.equal(promptFrom({}).text, '')
    assert.equal(promptFrom(null).text, '')
    assert.equal(promptFrom([1, 2]).text, '')
    assert.equal(promptFrom({ prompt: '   ' }).text, '')
  })
})

describe('renderContext · 注入块必须极短', () => {
  it('UserPromptSubmit 每轮累积 → 注入块必须压在上限内', () => {
    const hits = detectSignals('咋回事')
    const out = renderContext(hits, 'x'.repeat(5000))
    assert.ok(out.length <= 960, `注入块 ${out.length} 字，每轮累积会刷屏`)
    assert.match(out, /纠正信号/)
  })

  it('recall 为空时不留空段', () => {
    const out = renderContext(detectSignals('咋回事'), '   ')
    assert.doesNotMatch(out, /^\s*$/m)
    assert.match(out, /unexpected/)
  })
})

describe('端到端 · 接线层行为', () => {
  it('命中 → 输出 additionalContext 且事件落进沙箱事件账', () => {
    const dir = freshTmp()
    try {
      const r = runHook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'sess-x', prompt: '怎么还是不行' })
      assert.equal(r.status, 0)
      const out = JSON.parse(r.stdout.trim())
      assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
      assert.match(out.hookSpecificOutput.additionalContext, /still-failing/)

      const evs = eventLines(dir)
      assert.equal(evs.length, 1, `应恰好一条事件，实得 ${evs.length}`)
      assert.match(evs[0].payload.message, /^user-correction signal=still-failing$/)
      assert.equal(evs[0].kind, 'manual')
      assert.match(evs[0].payload.excerpt, /怎么还是不行/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('★ 同类别第二次纠正 → 事件仍是同一条且 count+1（归并，不是新增）', () => {
    const dir = freshTmp()
    try {
      runHook(dir, { prompt: '怎么还是不行' })
      runHook(dir, { prompt: '怎么又出这个问题' })
      const evs = eventLines(dir)
      assert.equal(evs.length, 1, '同类别必须归并成一行，否则复发计数无法累积')
      assert.equal(evs[0].count, 2, '第二次应累加到 count')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('零信号 → 零输出零事件（每轮都跑，不能每轮都出声）', () => {
    const dir = freshTmp()
    try {
      const r = runHook(dir, { prompt: '把上面的代码跑一下' })
      assert.equal(r.status, 0)
      assert.equal(r.stdout.trim(), '', '零信号必须连 stdout 都不写')
      assert.equal(eventLines(dir).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('载荷坏掉 / 不是 JSON / 载荷里没提示词 → exit 0 且不抛（钩子绝不搞失败会话）', () => {
    const dir = freshTmp()
    try {
      for (const bad of ['not json at all', '[]', 'null', '{}', '']) {
        const r = runHook(dir, bad)
        assert.equal(r.status, 0, `载荷 ${JSON.stringify(bad)} 应 exit 0`)
        assert.equal(r.stdout.trim(), '', `载荷 ${JSON.stringify(bad)} 不该有输出`)
      }
      assert.equal(eventLines(dir).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--probe 只报告不写盘（用来确认载荷键名，一次性排查用）', () => {
    const dir = freshTmp()
    try {
      const r = runHook(dir, { userPrompt: '咋回事' }, ['--probe'])
      assert.equal(r.status, 0)
      const out = JSON.parse(r.stdout.trim())
      assert.equal(out.promptKey, 'userPrompt')
      assert.equal(out.hits.length, 1)
      assert.equal(eventLines(dir).length, 0, 'probe 模式零写盘')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kill_switch 关掉捕获时不得写事件（开关语义由 capture 负责，本钩子不绕过）', () => {
    const dir = freshTmp()
    try {
      const r = spawnSync(process.execPath, [HOOK], {
        encoding: 'utf8',
        input: JSON.stringify({ prompt: '咋回事' }),
        timeout: 30_000,
        cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-off.yaml') },
      })
      assert.equal(r.status, 0)
      assert.equal(eventLines(dir).length, 0, '关闭捕获开关后不得留下事件')
      // 「有信号但没记账」必须与「没有纠正信号」长得不一样 —— stderr 说清楚，stdout 形状不变。
      assert.match(r.stderr, /kill_switch\.capture=false/, '没记账要在 stderr 讲清楚原因')
      assert.match(r.stderr, /未落库/)
      const out = JSON.parse(r.stdout.trim())
      assert.match(out.hookSpecificOutput.additionalContext, /unexpected/, '信号块仍要输出（stdout 形状不变）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * ★ 仓根实例配置路径（GitHub issue #1 的回归）
 *
 * ## 为什么上面那些用例全都测不到这个 bug
 *
 * 本文件原有的端到端用例**一律显式传 `SELF_IMPROVING_CONFIG`**。env 通道在配置链里
 * 优先级高于「仓根实例」，于是子进程的 cwd 是什么**根本不影响结果** —— bug 被完美遮住，
 * 在真实接入里已经半年没人发现。
 *
 * 真实的接入形态是：项目根有一份 `.self-improving.yaml`（仓根实例），钩子由宿主在项目目录里起。
 * 本块按那个形态跑：**不设** env 覆盖，临时目录 `git init` 出仓根。
 */
describe('★ 仓根实例路径（issue #1 回归）', () => {
  /**
   * 造一个「项目」：临时目录 + git init + 仓根实例配置 `.self-improving.yaml`
   * + 一条能被检索命中的存量条目。
   *
   * 条目正文含 `signal=still-failing`（纠正信号规范文本的骨架 token），
   * scope=infra（= fixture 配置的 hook.default_scopes）⇒ 检索能命中它。
   */
  function freshRepoInstance() {
    const dir = freshTmp()
    copyFileSync(path.join(dir, 'config-on.yaml'), path.join(dir, '.self-improving.yaml'))
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(
      path.join(dir, 'entries', 'LRN-20261027-001-correction-signal-not-captured.md'),
      [
        '---',
        'type: LRN',
        'status: active',
        'scope: infra',
        'claim: "纠正信号 signal=still-failing 没落库：先查 capture 子进程的 cwd 与配置链"',
        'guard_ref: null',
        'recurrence: 1',
        'last_verified_at: "2026-10-27"',
        '---',
        '',
        '# 纠正信号没落库时先查配置链',
        '',
        'capture 子进程若把 cwd 设成层自己的目录，配置链会落到内置默认值，纠正信号一条都不落库。',
        '',
      ].join('\n'),
    )
    return dir
  }

  /** 不设 SELF_IMPROVING_CONFIG —— 逼出「仓根实例」这条配置链路径。 */
  function runHookWithoutEnvOverride(dir, payload) {
    const env = { ...process.env }
    delete env.SELF_IMPROVING_CONFIG
    return spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      timeout: 30_000,
      cwd: dir,
      env,
    })
  }

  it('纠正信号落进仓根实例的事件库，且命中过的存量条目被检索回来', () => {
    const dir = freshRepoInstance()
    try {
      const r = runHookWithoutEnvOverride(dir, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-y',
        prompt: '怎么还是不行',
      })
      assert.equal(r.status, 0, `钩子不得失败：${r.stderr}`)

      const evs = eventLines(dir)
      assert.equal(evs.length, 1, `纠正信号应落进仓根实例的事件账，实得 ${evs.length} 条（issue #1：曾恒为 0）`)
      assert.equal(evs[0].source, 'hook')
      assert.match(evs[0].payload.message, /^user-correction signal=still-failing$/)

      const out = JSON.parse(r.stdout.trim())
      const ctx = out.hookSpecificOutput.additionalContext
      assert.match(ctx, /still-failing/)
      // 闭环：不止落库，还要把命中过的存量条目捞回来（issue #1 的第二个症状：检索结果恒空）
      assert.match(ctx, /已命中的存量经验条目/, '检索结果恒空是 issue #1 的第二个症状')
      assert.match(ctx, /LRN-20261027-001/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有仓根实例配置时：不得静默假装记账（stderr 讲清，事件仍为零，stdout 形状不变）', () => {
    const dir = freshRepoInstance()
    try {
      rmSync(path.join(dir, '.self-improving.yaml'))
      const r = runHookWithoutEnvOverride(dir, { prompt: '怎么还是不行' })
      assert.equal(r.status, 0)
      assert.equal(eventLines(dir).length, 0, '没有实例配置就不得落库（内置默认值的 capture 开关是关的）')
      assert.match(r.stderr, /没有实例配置/, '「没记账」必须在 stderr 讲清原因，别让它长得像「没发生」')
      const out = JSON.parse(r.stdout.trim())
      assert.match(out.hookSpecificOutput.additionalContext, /still-failing/, '信号块仍要输出（stdout 形状不变）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
