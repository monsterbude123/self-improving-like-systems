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
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDebtGuards, renderDebtSection, renderDebtSummaryLine } from '../scripts/run-guard.mjs'

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
  /** registry 里放一条 debt-stub（不派发的桩）→ 零 spawn，也能走完整条派发路径。 */
  function writeRegistry(dir) {
    writeFileSync(path.join(dir, 'registry.yaml'), 'guards: []\n')
  }

  it('有债 → stderr 打出汇总行', () => {
    const dir = freshTmp()
    try {
      writeRegistry(dir)
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
      writeRegistry(dir)
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
