/**
 * guard-debt.test.mjs —— 守卫债的可见性（GitHub issue #2）
 *
 * ## 要守住的性质
 *
 * 1. **判定只有一份**（`collectDebtGuards`）：「是不是债」「当前坏不坏」「连挂没连挂」
 *    全部复用 `run-guard.mjs` 里既有的 `evidenceStrength` 与 `ERROR_STREAK_THRESHOLD`。
 * 2. **口径分得清**：当前还在报错的排最前（连挂多的更前），已恢复的随后按累计次数降序。
 *    —— 现场四条债里只有两条是当下真坏的，平铺成同等紧急会让人误判优先级。
 * 3. **两个出口都真的有输出**：run-guard 派发末尾的汇总行 + SessionStart 的注入小节。
 * 4. **零债 = 零噪音**：没有债时两个出口都不出声（否则每次会话都多一句废话）。
 * 5. **fail-open 纪律不变**：守卫债只是被看见，守卫坏了照样放行、不阻塞提交。
 *
 * fixture = tests/fixtures/hook/（整体拷到临时目录；状态账写在临时目录根，不碰真实账）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDebtGuards, printDebtSummary, renderDebtSection, renderDebtSummaryLine } from '../scripts/run-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'hook')
const RUN_GUARD = path.join(SKILL_ROOT, 'scripts', 'run-guard.mjs')
const SESSION_START = path.join(SKILL_ROOT, 'scripts', 'hook-session-start.mjs')

/** 每用例一份全新拷贝（写入型目录不许跨用例共享）。 */
function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'debt-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/**
 * registry 里放一条 debt-stub（不派发的桩）→ 零 spawn，也能走完整条派发路径。
 * 另有一份「会命中的 blocking 守卫」用于裁决相关的用例（见该 describe 内）。
 */
function writeRegistryStub(dir) {
  writeFileSync(path.join(dir, 'registry.yaml'), 'guards: []\n')
}

/** registry 里放一条 debt-stub 守卫（派发时被跳过、不 spawn），用于走通「单 key 派发」路径。 */
function writeDebtStubRegistry(dir) {
  writeFileSync(
    path.join(dir, 'registry.yaml'),
    ['guards:', '  - key: "debt-stub-demo"', "    args: ['scripts/gates/none.mjs']", '    when: always', '    mode: debt-stub', ''].join('\n'),
  )
}

/** 守卫状态账落在 `dirname(events_dir)/guard-state.json` = 临时目录根（配置目录的同级）。 */
function writeState(dir, guards) {
  writeFileSync(path.join(dir, 'guard-state.json'), JSON.stringify({ guards }, null, 2))
}

/** 现场实测形态：两条当前真坏（连挂 4 次）、一条已恢复（末次 pass）。 */
const DEBT_STATE = {
  'no-bare-vitest': {
    shadow_runs: 23, shadow_green: 4, error_runs: 19, error_streak: 4,
    last_result: 'error', detail: 'spawn 失败: spawnSync node ETIMEDOUT', mode: 'shadow',
  },
  'no-per-item-spawn': {
    shadow_runs: 24, shadow_green: 4, error_runs: 20, error_streak: 4,
    last_result: 'error', detail: 'spawn 失败: spawnSync bash ETIMEDOUT', mode: 'shadow',
  },
  'design-ticket-requires-draft-diff': {
    shadow_runs: 8, shadow_green: 8, error_runs: 4, error_streak: 0,
    last_result: 'pass', detail: null, mode: 'shadow',
  },
}

/** 健康的账：一条从没报过错的守卫。 */
const CLEAN_STATE = {
  'healthy-guard': {
    shadow_runs: 5, shadow_green: 5, error_runs: 0, error_streak: 0,
    last_result: 'pass', detail: null, mode: 'shadow',
  },
}

describe('collectDebtGuards · 判定与排序（判据只有一份）', () => {
  it('只认有 error 的守卫；没报过错的不是债', () => {
    const rows = collectDebtGuards({ guards: CLEAN_STATE })
    assert.deepEqual(rows, [], '没报过错的守卫不该出现在债清单里')
  })

  it('当前报错的排最前（连挂多的更前），已恢复的随后按累计次数降序', () => {
    const rows = collectDebtGuards({ guards: DEBT_STATE })
    assert.equal(rows.length, 3)
    assert.equal(rows[0].key, 'no-per-item-spawn', '连挂同为 4 次时按累计次数降序')
    assert.equal(rows[1].key, 'no-bare-vitest')
    assert.equal(rows[2].key, 'design-ticket-requires-draft-diff', '已恢复的排最后')
    assert.equal(rows[2].failing, false, '末次 pass = 已恢复')
    assert.equal(rows[2].recovered, undefined)
  })

  it('末次是 error 才算「当前还在报错」；末次 pass 但历史上报过错 = 已恢复（仍算债）', () => {
    const rows = collectDebtGuards({ guards: DEBT_STATE })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(byKey['no-bare-vitest'].failing, true)
    assert.equal(byKey['no-bare-vitest'].streak_reached, true, '连挂 ≥ 阈值就该标出来')
    assert.equal(byKey['design-ticket-requires-draft-diff'].failing, false)
    assert.equal(byKey['design-ticket-requires-draft-diff'].streak_reached, false)
  })

  it('最近一次错误详情取自已有的 detail 字段（不新增状态字段）', () => {
    const rows = collectDebtGuards({ guards: DEBT_STATE })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(byKey['no-bare-vitest'].detail, 'spawn 失败: spawnSync node ETIMEDOUT')
    assert.equal(byKey['design-ticket-requires-draft-diff'].detail, null, '已恢复的守卫没有末次错误详情 —— 不编')
  })

  it('账读不出来时返回空清单（不静默丢覆盖：调用方据此打「零债」，但不会假装有债）', () => {
    assert.deepEqual(collectDebtGuards({}), [])
    assert.deepEqual(collectDebtGuards(null), [])
    assert.deepEqual(collectDebtGuards({ guards: null }), [])
  })
})

describe('renderDebtSummaryLine · 汇总行（run-guard 派发末尾）', () => {
  it('有债时给出条数、当前坏/已恢复的拆分与各条 key', () => {
    const line = renderDebtSummaryLine(collectDebtGuards({ guards: DEBT_STATE }))
    assert.match(line, /守卫债 3 条/)
    assert.match(line, /当前报错 2/)
    assert.match(line, /已恢复 1/)
    assert.match(line, /no-bare-vitest/)
    assert.match(line, /design-ticket-requires-draft-diff/)
    assert.match(line, /fail-open/, '必须讲清「还是放行」—— 可见性不是阻断')
  })

  it('零债时返回空串（没有债就零噪音）', () => {
    assert.equal(renderDebtSummaryLine(collectDebtGuards({ guards: CLEAN_STATE })), '')
    assert.equal(renderDebtSummaryLine([]), '')
  })
})

describe('renderDebtSection · 注入小节（SessionStart 拼进上下文）', () => {
  it('当前坏的在前（含连挂次数与最近错误详情），已恢复的标注在后', () => {
    const section = renderDebtSection(collectDebtGuards({ guards: DEBT_STATE }))
    assert.match(section, /## 守卫健康度（当前报错 2 · 已恢复 1）/)
    const iFailing = section.indexOf('no-bare-vitest')
    const iRecovered = section.indexOf('已恢复 design-ticket-requires-draft-diff')
    assert.ok(iFailing >= 0 && iRecovered >= 0, '两条都要出现')
    assert.ok(iFailing < iRecovered, '当前坏的必须排在已恢复的前面')
    assert.match(section, /连续 error 4 次/)
    assert.match(section, /累计 19 次/)
    assert.match(section, /最近：spawn 失败: spawnSync node ETIMEDOUT/)
  })

  it('行数与字符有上限（SessionStart 的上下文预算是硬的）', () => {
    const many = {}
    for (let i = 0; i < 30; i++) {
      many[`guard-${i}`] = { shadow_runs: 9, error_runs: 5, error_streak: 5, last_result: 'error', detail: 'x'.repeat(200) }
    }
    const section = renderDebtSection(collectDebtGuards({ guards: many }))
    const lines = section.trim().split('\n')
    assert.ok(lines.length <= 9, `小节行数 ${lines.length} 太多（上限 5 条 + 标题 + 附注 + 省略行）`)
    assert.ok(section.length <= 900, `小节 ${section.length} 字，超出上下文预算`)
    assert.match(section, /另有 \d+ 条/, '超出上限的条数要给出来，不能静默丢')
  })

  it('零债时返回空串（调用方据此完全不输出该小节）', () => {
    assert.equal(renderDebtSection(collectDebtGuards({ guards: CLEAN_STATE })), '')
  })
})

describe('出口一 · run-guard 派发末尾的汇总行', () => {
  it('有债 → stderr 打出汇总行', () => {
    const dir = freshTmp()
    try {
      writeRegistryStub(dir)
      writeState(dir, DEBT_STATE)
      const r = spawnSync(process.execPath, [RUN_GUARD, '--all', '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0, `期望 exit 0，实得 ${r.status}\n${r.stderr}`)
      assert.match(r.stderr, /守卫债 3 条/, `汇总行没打出来：${r.stderr}`)
      assert.match(r.stderr, /no-bare-vitest/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无债 → 不打汇总行（零噪音）', () => {
    const dir = freshTmp()
    try {
      writeRegistryStub(dir)
      writeState(dir, CLEAN_STATE)
      const r = spawnSync(process.execPath, [RUN_GUARD, '--all', '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0)
      assert.doesNotMatch(r.stderr, /守卫债/, `没有债就不该出声：${r.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('出口二 · SessionStart 注入小节', () => {
  it('有债 → stdout 含「## 守卫健康度」小节', () => {
    const dir = freshTmp()
    try {
      writeState(dir, DEBT_STATE)
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0, `期望 exit 0，实得 ${r.status}\n${r.stderr}`)
      assert.match(r.stdout, /## 经验注入/, '注入块仍要在（出口二不许顶掉出口一）')
      assert.match(r.stdout, /## 守卫健康度/, `守卫健康度小节没出现：${r.stdout}`)
      assert.match(r.stdout, /no-bare-vitest/)
      assert.match(r.stdout, /已恢复 design-ticket-requires-draft-diff/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无债 → stdout 不含该小节（零噪音）', () => {
    const dir = freshTmp()
    try {
      writeState(dir, CLEAN_STATE)
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0)
      assert.match(r.stdout, /## 经验注入/)
      assert.doesNotMatch(r.stdout, /## 守卫健康度/, `没有债就不该多这一节：${r.stdout}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kill_switch.injection=false → stdout 仍严格为空（关掉注入就不许借这个出口出声）', () => {
    const dir = freshTmp()
    try {
      writeState(dir, DEBT_STATE)
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', path.join(dir, 'config-off.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-off.yaml') },
      })
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '', `kill-switch 关着时 stdout 必须严格为空：${r.stdout}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * ★ 验证轮发现的 6 条 gap 的回归（gaps_found → 回 exec 修的第一轮）
 *
 * 这几条都是「看着绿、其实没钉住」的形态：前 15 条用例全绿，变异体照样全绿。
 * 写这一节就是为了让每个变异体都变红。
 */
describe('★ 验证轮 gap 回归（G-02-1..G-02-6）', () => {
  /** 一个会命中的 blocking 守卫（exit 2 = 命中判据）。 */
  function writeBlockingGuard(dir) {
    mkdirSync(path.join(dir, 'guards'), { recursive: true })
    writeFileSync(path.join(dir, 'guards', 'block.mjs'), 'process.exit(2)\n')
    writeFileSync(
      path.join(dir, 'registry.yaml'),
      [
        'guards:',
        '  - key: "block-demo"',
        "    args: ['guards/block.mjs']",
        '    when: always',
        "    command: ['node', 'guards/block.mjs']",
        '    covered_entries: []',
        '    mode: blocking',
        '    shadow_required: 0',
        '',
      ].join('\n'),
    )
  }

  it('G-02-1 单 key 派发路径也打汇总行（接入项目 pre-commit 走的就是这条路径）', () => {
    const dir = freshTmp()
    try {
      writeDebtStubRegistry(dir)
      writeState(dir, DEBT_STATE)
      const r = spawnSync(process.execPath, [RUN_GUARD, '--key', 'debt-stub-demo', '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0, `期望 exit 0，实得 ${r.status}\n${r.stderr}`)
      assert.match(r.stderr, /守卫债 3 条/, `单 key 派发没打汇总行：${r.stderr}`)
      assert.match(r.stderr, /no-bare-vitest/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-3 汇总行不许改变裁决：阻断守卫命中时退出码仍是 2（不被汇总降级成 0）', () => {
    const dir = freshTmp()
    try {
      writeBlockingGuard(dir)
      // 拦截权在**状态账**里（不是 registry）—— mode=blocking 才真阻断，否则只警告。
      writeState(dir, {
        ...DEBT_STATE,
        'block-demo': { shadow_runs: 3, shadow_green: 3, error_runs: 0, error_streak: 0, last_result: 'pass', mode: 'blocking' },
      })
      const r = spawnSync(process.execPath, [RUN_GUARD, '--key', 'block-demo', '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 2, `阻断裁决被降级了（期望 exit 2）：${r.stderr}`)
      assert.match(r.stderr, /守卫债 3 条/, '汇总行照样要打（它只是可见性）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-2 两个出口读同一本账：账在**配置目录**，不在 cwd（不许各读各的）', () => {
    const dir = freshTmp()
    try {
      // 配置搬到子目录 ⇒ baseDir = 该子目录 ⇒ 状态账落在该子目录
      const cfgDir = path.join(dir, 'cfg')
      mkdirSync(cfgDir, { recursive: true })
      copyFileSync(path.join(dir, 'config-on.yaml'), path.join(cfgDir, 'config-on.yaml'))
      cpSync(path.join(dir, 'entries'), path.join(cfgDir, 'entries'), { recursive: true })
      writeState(cfgDir, DEBT_STATE)
      // 诱饵：cwd 目录下的另一本账（key 完全不同）
      writeState(dir, { 'decoy-in-cwd': { shadow_runs: 9, error_runs: 7, error_streak: 7, last_result: 'error' } })

      const cfg = path.join(cfgDir, 'config-on.yaml')
      const s = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', cfg], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: cfg },
      })
      assert.equal(s.status, 0, s.stderr)
      assert.match(s.stdout, /no-bare-vitest/, 'SessionStart 读的是配置目录的账')
      assert.doesNotMatch(s.stdout, /decoy-in-cwd/, '不许读 cwd 目录的账')

      writeRegistryStub(cfgDir)
      const g = spawnSync(process.execPath, [RUN_GUARD, '--all', '--config', cfg], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: cfg },
      })
      assert.equal(g.status, 0, g.stderr)
      assert.match(g.stderr, /no-bare-vitest/, 'run-guard 读的必须是同一本账')
      assert.doesNotMatch(g.stderr, /decoy-in-cwd/, '两个出口必须读同一本账')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-4 没有可注入域（模板默认 default_scopes 为空）时，守卫债照样给出去', () => {
    const dir = freshTmp()
    try {
      writeState(dir, DEBT_STATE)
      const cfgPath = path.join(dir, 'config-on.yaml')
      const cfg = readFileSync(cfgPath, 'utf8').replace('default_scopes: [infra, testing]', 'default_scopes: []')
      writeFileSync(cfgPath, cfg)
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', cfgPath], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: cfgPath },
      })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /## 守卫健康度/, `没有域不等于没有债：${r.stdout}`)
      assert.match(r.stdout, /no-bare-vitest/)
      assert.doesNotMatch(r.stdout, /## 经验注入/, '没有域就不该有注入块')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-5 状态账损坏 → stderr 必须告警（不许静默当成「零债」）', () => {
    const dir = freshTmp()
    try {
      writeFileSync(path.join(dir, 'guard-state.json'), '{ 这不是合法 JSON')
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0)
      assert.match(r.stderr, /守卫状态账读不动/, `账坏了必须告警，不能静默当零债：${r.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-6 小节长度是硬上限（给定 maxChars 就不越界；放不下就退成紧凑摘要）', () => {
    const rows = collectDebtGuards({ guards: DEBT_STATE })
    for (const maxChars of [40, 80, 200, 600]) {
      const section = renderDebtSection(rows, { maxChars })
      assert.ok(section.length <= maxChars, `maxChars=${maxChars} 时小节 ${section.length} 字，越界了`)
    }
    const tiny = renderDebtSection(rows, { maxChars: 40 })
    assert.match(tiny, /守卫债 3 个/, '放不下整节时要退成紧凑摘要（条数还在）')
  })

  it('G-02-3 汇总读不出来时不得抛（抛了会被 fail-open 吞成放行）', () => {
    // 这条是「汇总绝不影响裁决」的根：汇总自己兜住所有异常。
    // 少了它，一次汇总异常就会把真实的阻断裁决（exit 2）降级成放行（exit 0）。
    assert.doesNotThrow(() => printDebtSummary({ config: {}, baseDir: undefined }))
    assert.doesNotThrow(() => printDebtSummary({ config: { storage: { guard_state: 123 } }, baseDir: '/tmp' }))
  })

  it('G-02-7 出口一在状态账损坏时必须告警（不许静默当零债）', () => {
    const dir = freshTmp()
    try {
      writeDebtStubRegistry(dir)
      // 账损坏 ⇒ 债清单读不出来 ⇒ 汇总行为空。此时 stderr 那句「账读不动」
      // 是出口一唯一的「账不可信」信号 —— 少了它，账坏与零债长得一模一样。
      writeFileSync(path.join(dir, 'guard-state.json'), '{ 这不是合法 JSON')
      const r = spawnSync(process.execPath, [RUN_GUARD, '--all', '--config', path.join(dir, 'config-on.yaml')], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(dir, 'config-on.yaml') },
      })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stderr, /守卫状态账读不动/, `账坏了出口一必须告警：${r.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('G-02-4b 条目目录缺失（注入失败）时，守卫债仍不被吞掉', () => {
    const dir = freshTmp()
    try {
      writeState(dir, DEBT_STATE)
      const cfgPath = path.join(dir, 'config-on.yaml')
      // entries_dir 指到一个不存在的目录 ⇒ runInject 抛错 ⇒ 注入块为空
      writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace('entries_dir: entries/', 'entries_dir: no-such-dir/'))
      const r = spawnSync(process.execPath, [SESSION_START, '--project-dir', dir, '--config', cfgPath], {
        encoding: 'utf8', timeout: 30_000, cwd: dir,
        env: { ...process.env, SELF_IMPROVING_CONFIG: cfgPath },
      })
      assert.equal(r.status, 0, r.stderr)
      assert.doesNotMatch(r.stdout, /## 经验注入/, '注入块该为空')
      assert.match(r.stdout, /## 守卫健康度/, `注入失败不该把守卫债一起吞掉：${r.stdout}`)
      assert.match(r.stdout, /no-bare-vitest/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
