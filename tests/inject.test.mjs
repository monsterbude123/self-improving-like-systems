/**
 * inject.test.mjs —— 注入引擎自包含测试（node:test，零测试框架依赖；`node <本文件>` 直接跑）
 *
 * 口径（票 05 AC 全部 fixture 化）：exit code + stdout 块内容 + 审计落盘三向断言；
 * 每个行为类各有红向（拒绝/降级/fail-open 必须真的发生），「只会通过的测试等于没有测试」。
 * kill-switch：off 态断言 = stdout 空 + 零审计副作用（本文件即该功能级断言的归宿）。
 * fixture = tests/fixtures/inject/（每次用例整体拷到临时目录，审计写入不污染 fixture）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreEntry, resolveRanking } from '../scripts/inject.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const CLI = path.join(SKILL_ROOT, 'scripts', 'inject.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'inject')
const RANK_FIXTURE_DIR = path.join(HERE, 'fixtures', 'inject-rank')
// 配置缺失 audit_log 时引擎的兜底审计路径（fail-open case 用前先清、用后断言）
const FALLBACK_AUDIT = path.join(tmpdir(), 'self-improving-injection-audit.jsonl')

/** 每用例一份全新拷贝：audit/ 是写入型目录，不许跨用例共享。 */
function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'inject-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/**
 * 跑注入 CLI（cwd = 协议层根；30s 超时防挂死；清环境变量防外部配置泄漏）。
 * cwd 刻意**不**用「技能上溯若干级得到的仓库根」：那假设技能部署在某个业务仓的固定深度，
 * 且会让 CLI 沿 cwd 上溯捡到宿主仓的实例配置，使断言随宿主布局漂移。本文件全部用例都显式
 * `--config` 指向 fixture，cwd 只影响那四级解析链的兜底分支。可移植性判据见 tests/portability.test.mjs。
 */
function runInject(args, { cwd = SKILL_ROOT } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 排序 fixture（票 H1）独立一份拷贝：top_k/预算与主 fixture 不同，不许共用。 */
function freshRankTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'inject-rank-test-'))
  cpSync(RANK_FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** 从注入块里按出现顺序抽出条目 ID（顺序本身就是被断言对象）。 */
function injectedIds(stdout) {
  // 六位在前、双形态:三位的旧写法会把六位夹具静默截断成三位幻影 ID(混进断言里假绿/假红)
  return [...stdout.matchAll(/\[((?:LRN|ERR|FEAT)-\d{8}-(?:\d{6}|\d{3}))/g)].map((m) => m[1])
}

/** 读 fixture 目录里的审计 JSONL → 记录数组（文件不存在返回 []）。 */
function readAudit(dir, sub = 'audit/audit.jsonl') {
  const p = path.join(dir, sub)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
}

describe('注入引擎 · 正向与 scope 过滤', () => {
  it('正向：命中条目进块，含出处（条目 ID + 文件路径）与命中计数；top_k=1 封顶生效', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra', '--keywords', 'docker,cache'])
      assert.equal(r.status, 0, `期望 exit 0，实得 ${r.status}\n${r.all}`)
      assert.match(r.stdout, /^## 经验注入/)
      // 出处：块内同时含条目 ID 与配置 entries_dir 相对路径
      assert.match(r.stdout, /\[LRN-20261016-001-docker-cache\]/)
      assert.match(r.stdout, /出处: entries\/LRN-20261016-001-docker-cache\.md/)
      // 命中计数：关键词 docker/cache 在该条目内 ≥1 次
      assert.match(r.stdout, /命中 [1-9]\d* 次/)
      // top_k=1：infra 命中 2 条（001 与 004），封顶后 004 不得出现
      assert.ok(!r.stdout.includes('LRN-20261016-004-infra-mount'), `top_k 封顶失效:\n${r.stdout}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('反向：跨 scope 与 default 桶条目不进块，且拒绝动作逐条落审计', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra', '--keywords', 'docker'])
      assert.equal(r.status, 0, r.all)
      for (const id of ['ERR-20261016-001-cross-ui', 'LRN-20261016-003-other-archive', 'LRN-20261016-002-testing-flaky']) {
        assert.ok(!r.stdout.includes(id), `${id} 不得出现在注入输出:\n${r.stdout}`)
      }
      const records = readAudit(tmp)
      const byEntry = (id) => records.find((x) => x.action === 'scope-rejected' && x.entry === id)
      const cross = byEntry('ERR-20261016-001-cross-ui')
      assert.ok(cross, `跨 scope 拒绝未落审计: ${JSON.stringify(records)}`)
      assert.equal(cross.reason, 'cross-scope')
      assert.equal(cross.scope, 'data-ui')
      assert.deepEqual(cross.requested, ['infra'])
      const other = byEntry('LRN-20261016-003-other-archive')
      assert.ok(other, 'default 桶拒绝未落审计')
      assert.equal(other.reason, 'default-bucket')
      assert.ok(byEntry('LRN-20261016-002-testing-flaky'), 'testing 跨 scope 拒绝未落审计')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('无关键词时 scope 过滤仍生效（recurrence 排序，块内仍含出处与 0 次计数）', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra'])
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /出处: entries\//)
      assert.match(r.stdout, /命中 0 次/)
      assert.ok(!r.stdout.includes('ERR-20261016-001-cross-ui'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('注入排序 · 信号非全平（票 H1：排序不再退化为常量字典序）', () => {
  it('SessionStart 口径（无关键词）：已闭环条目沉底，未闭环按 recurrence/status 排', () => {
    const tmp = freshRankTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra'])
      assert.equal(r.status, 0, r.all)
      const ids = injectedIds(r.stdout)
      // recurrence desc（5 > 0）→ status 权重 desc（active > resolved）→ ID 收口。
      // 000 的 ID 字典序最靠前：若排序退化成字典序它会排第一，这里必须沉到末位。
      assert.deepEqual(ids, ['LRN-20261016-005', 'LRN-20261016-004', 'LRN-20261016-000'], `实际顺序:\n${r.stdout}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('不同上下文（SessionStart 无 prompt vs 带 keywords）输出可不同，且与相关性正相关', () => {
    const tmp = freshRankTmp()
    try {
      const bare = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra'])
      const keyed = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra', '--keywords', 'regression-drift'])
      const a = injectedIds(bare.stdout)
      const b = injectedIds(keyed.stdout)
      assert.notDeepEqual(a, b, `同一 scope、不同上下文的输出必须可不同：\n无词=${a.join('>')}\n有词=${b.join('>')}`)
      // 关键词只命中已闭环那条：命中数是最强信号，相关性正相关 = 它必须被顶到第一位
      assert.equal(b[0], 'LRN-20261016-000', `关键词命中应压过 status 权重：\n${keyed.stdout}`)
      assert.match(keyed.stdout, /命中 [1-9]\d* 次/)
      assert.match(bare.stdout, /命中 0 次/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('排序键在无关键词时仍能区分开条目（断言「非全平」，不是碰巧同序）', () => {
    const tmp = freshRankTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra'])
      const ids = injectedIds(r.stdout)
      assert.equal(new Set(ids).size, ids.length, '注入集合本身须无重复')
      // 排序键全平时输出恒等于 ID 字典序 —— 显式断言它**不等于**字典序，即信号确实在起作用
      assert.notDeepEqual(ids, [...ids].sort(), `输出退化成字典序了（排序键全平）:\n${r.stdout}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('排序键全平 → 降级为零注入 + rank-degenerate 审计（宁可零注入也不注常量噪音）', () => {
    const tmp = freshRankTmp()
    try {
      // 把三条 infra 条目的 status/recurrence/last_verified_at 抹平成完全一样
      // —— 排序就只剩 ID 字典序在起作用，这时注入的那份与本次会话毫无关系。
      for (const [name, status] of [
        ['LRN-20261016-000-infra-resolved.md', 'active'],
        ['LRN-20261016-004-infra-mount.md', 'active'],
        ['LRN-20261016-005-infra-recurred.md', 'active'],
      ]) {
        const p = path.join(tmp, 'entries', name)
        writeFileSync(p, readFileSync(p, 'utf8')
          .replace(/^status: .*$/m, `status: ${status}`)
          .replace(/^recurrence: .*$/m, 'recurrence: 0')
          .replace(/^last_verified_at: .*$/m, 'last_verified_at: null'), 'utf8')
      }
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra'])
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', `排序键全平时必须零注入（否则就是一份与上下文无关的常量）:\n${r.stdout}`)
      const rec = readAudit(tmp).find((x) => x.action === 'rank-degenerate')
      assert.ok(rec, `须落 rank-degenerate 审计:\n${JSON.stringify(readAudit(tmp))}`)
      assert.equal(rec.candidates, 3)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('注入引擎 · 预算与 kill-switch', () => {
  it('超预算：降级为标题行（长度 ≤ 预算、无出处/计数详情），并落 budget-degraded 审计', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-tiny-budget.yaml'), '--scope', 'infra', '--keywords', 'docker'])
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /降级/)
      assert.ok(r.stdout.length <= 120, `降级后长度 ${r.stdout.length} > 预算 120:\n${r.stdout}`)
      assert.match(r.stdout, /^- \[LRN-/m, '降级块必须是标题行列表')
      assert.ok(!r.stdout.includes('出处:'), '降级块不得含出处详情行')
      assert.ok(!r.stdout.includes('命中'), '降级块不得含命中计数行')
      const degraded = readAudit(tmp).find((x) => x.action === 'budget-degraded')
      assert.ok(degraded, '超预算降级未落审计')
      assert.equal(degraded.budget, 120)
      assert.ok(degraded.kept >= 1 && degraded.kept + degraded.dropped === 2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('kill-switch off：exit 0、stdout 全空、零审计副作用（off 态断言）', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-off.yaml'), '--scope', 'infra', '--keywords', 'docker,cache'])
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', `off 态不得输出任何注入内容:\n${r.stdout}`)
      assert.ok(!existsSync(path.join(tmp, 'audit', 'audit.jsonl')), 'off 态不得写审计（零副作用）')
      assert.match(r.stderr, /kill_switch\.injection=false/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('注入引擎 · fail-open（绝不阻塞调用方）', () => {
  it('配置损坏（YAML 解析失败）→ exit 0、空块、审计落兜底路径', () => {
    rmSync(FALLBACK_AUDIT, { force: true })
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-broken.yaml'), '--scope', 'infra', '--keywords', 'docker'])
      assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.all}`)
      assert.equal(r.stdout, '', 'fail-open 必须输出空块')
      assert.match(r.stderr, /fail-open/)
      assert.ok(existsSync(FALLBACK_AUDIT), '配置损坏时审计必须落兜底路径')
      const rec = readFileSync(FALLBACK_AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop()
      assert.equal(rec.action, 'fail-open')
      // 错误文案随 YAML 后端（js-yaml / yaml-lite）不同，只断言携带了非空原因
      assert.ok(typeof rec.error === 'string' && rec.error.length > 0, 'fail-open 审计必须携带错误原因')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      rmSync(FALLBACK_AUDIT, { force: true })
    }
  })

  it('配置结构违规（缺 kill_switch）→ exit 0、空块、审计落配置 audit_log', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-bad-structure.yaml'), '--scope', 'infra'])
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '')
      const rec = readAudit(tmp).find((x) => x.action === 'fail-open')
      assert.ok(rec, '结构违规必须落 fail-open 审计到配置 audit_log')
      assert.match(rec.error, /kill_switch/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('条目不可读（目录占位 .md）→ exit 0、空块、fail-open 审计', () => {
    const tmp = freshTmp()
    try {
      mkdirSync(path.join(tmp, 'entries', 'broken.md'), { recursive: true })
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'infra', '--keywords', 'docker'])
      assert.equal(r.status, 0, `条目不可读必须 fail-open exit 0，实得 ${r.status}\n${r.all}`)
      assert.equal(r.stdout, '')
      assert.match(r.stderr, /fail-open/)
      const rec = readAudit(tmp).find((x) => x.action === 'fail-open')
      assert.ok(rec, '条目不可读必须落 fail-open 审计')
      assert.match(rec.error, /EISDIR|broken\.md/, '审计须指明不可读原因')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('注入引擎 · 用法错误（exit 2 与 fail-open 分开）', () => {
  it('缺 --scope → exit 2', () => {
    const r = runInject(['--keywords', 'docker'])
    assert.equal(r.status, 2, r.all)
    assert.match(r.stderr, /用法错误/)
  })
  it('未知参数 → exit 2', () => {
    const r = runInject(['--scope', 'infra', '--nope'])
    assert.equal(r.status, 2, r.all)
  })
  it('scope 取值不在 config.scope.values → exit 2', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'bogus'])
      assert.equal(r.status, 2, r.all)
      assert.match(r.stderr, /取值非法/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('点名 default 桶（永不注入）→ exit 2', () => {
    const tmp = freshTmp()
    try {
      const r = runInject(['--config', path.join(tmp, 'config-ok.yaml'), '--scope', 'other'])
      assert.equal(r.status, 2, r.all)
      assert.match(r.stderr, /不得点名默认桶/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ===== 召回排序：加权打分（业界标准三因子 relevance / importance / recency）=====
describe('scoreEntry · 召回加权打分', () => {
  const W = { weights: { relevance: 0.55, importance: 0.3, recency: 0.15 }, relevance_saturation: 3, importance_saturation: 8, recency_half_life_days: 30 }
  const e = (over) => ({ count: 0, recurrence: 0, statusWeight: 0, ageDays: 0, ...over })

  it('红向：relevance 按 saturation 饱和 —— 命中 1 次得 1/3，命中 3 次及以上封顶不加分', () => {
    assert.equal(scoreEntry(e({ count: 1 }), W).relevance, 1 / 3)
    assert.equal(scoreEntry(e({ count: 3 }), W).relevance, 1)
    assert.equal(scoreEntry(e({ count: 99 }), W).relevance, 1, '超过饱和点不得继续加分')
    assert.equal(scoreEntry(e({ count: 0 }), W).relevance, 0, '无查询/未命中 → 0，让位给另两因子')
  })

  it('红向：importance 里 recurrence 压过 status（硬证据 > 流程位）', () => {
    // 复发 5 次但已 resolved：0.6·norm(5) + 0.4·0
    const recurredResolved = scoreEntry(e({ recurrence: 5, statusWeight: 0 }), W).importance
    // 从未复发但 active：0.6·0 + 0.4·(3/4)
    const activeOnly = scoreEntry(e({ recurrence: 0, statusWeight: 3 }), W).importance
    assert.ok(recurredResolved > activeOnly, `复发多次的已闭环条目应高于零复发的活跃条目（${recurredResolved} vs ${activeOnly}）`)
  })

  it('红向：recency 指数半衰 —— 30 天减半，60 天四分之一，无日期取 0.5 中位而非 0', () => {
    assert.ok(Math.abs(scoreEntry(e({ ageDays: 30 }), W).recency - 0.5) < 1e-9, '半衰期处应恰为 0.5')
    assert.ok(Math.abs(scoreEntry(e({ ageDays: 60 }), W).recency - 0.25) < 1e-9, '两个半衰期应四分之一')
    assert.equal(scoreEntry(e({ ageDays: null }), W).recency, 0.5, '「不知道多老」= 中位，不得当最旧沉底')
  })

  it('红向：权重真的参与计算 —— 把 recency 权重独占，总分随新近度单调', () => {
    const onlyRecency = { ...W, weights: { relevance: 0, importance: 0, recency: 1 } }
    const fresh = scoreEntry(e({ ageDays: 1 }), onlyRecency).score
    const old = scoreEntry(e({ ageDays: 100 }), onlyRecency).score
    assert.ok(fresh > old, `新条目应得分更高（${fresh} vs ${old}）`)
    assert.ok(Math.abs(fresh - old - (scoreEntry(e({ ageDays: 1 }), onlyRecency).recency - scoreEntry(e({ ageDays: 100 }), onlyRecency).recency)) < 1e-9)
  })

  it('破坏测试：把 importance 权重改成 0，recurrence 高的条目就必须不再领先', () => {
    // 判据权重表若被"改成看起来合理"的值，排序会静默换语义而无任何红。
    const noImportance = { ...W, weights: { relevance: 0, importance: 0, recency: 1 } }
    const a = scoreEntry(e({ recurrence: 9, statusWeight: 0, ageDays: 5 }), noImportance).score
    const b = scoreEntry(e({ recurrence: 0, statusWeight: 0, ageDays: 5 }), noImportance).score
    assert.equal(a, b, 'importance 权重为 0 时 recurrence 不得影响总分')
    // 对照：默认权重下同样的两条必须有差异
    assert.ok(scoreEntry(e({ recurrence: 9, statusWeight: 0, ageDays: 5 }), W).score > scoreEntry(e({ recurrence: 0, statusWeight: 0, ageDays: 5 }), W).score)
  })

  it('resolveRanking：实例配置缺段/非法值 → 回落内置默认（fail-open，不炸不静默变语义）', () => {
    assert.deepEqual(resolveRanking({}).weights, { relevance: 0.55, importance: 0.3, recency: 0.15 })
    const partial = resolveRanking({ injection: { ranking: { weights: { relevance: 0.9 } } } })
    assert.equal(partial.weights.relevance, 0.9, '给了的项取实例值')
    assert.equal(partial.weights.importance, 0.3, '没给的项回落默认')
    assert.equal(partial.weights.recency, 0.15)
    const bad = resolveRanking({ injection: { ranking: { weights: { relevance: -1 }, recency_half_life_days: 0 } } })
    assert.equal(bad.weights.relevance, 0.55, '负权重非法 → 回落默认')
    assert.equal(bad.recency_half_life_days, 30, '零半衰期非法 → 回落默认')
  })
})
