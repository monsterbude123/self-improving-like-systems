/**
 * distill.test.mjs —— 蒸馏提案器自包含测试（node:test，零框架依赖；`node <本文件>` 直跑）
 *
 * 口径（票 09 AC 全部 fixture 化）：三要素齐全 + 草案过 validateEntry + 正式区零写入
 * （git 级证明的目录快照等价断言）+ 幂等 + 空库破坏 + kill-switch off 零副作用 + 用法错误。
 * fixture = tests/fixtures/distill/（每用例整体拷到临时目录；实例配置 kill-switch 默认值永不动）。
 * 双后端：YAML 读取经 scripts/lib/yaml-lite.mjs（宿主无 js-yaml → 降级后端；
 * 容器有 js-yaml → js-yaml）。同一份测试两端都绿即两条后端同判。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const CLI = path.join(SKILL_ROOT, 'scripts', 'distill.mjs')
const VALIDATE_CLI = path.join(SKILL_ROOT, 'scripts', 'validate.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'distill')

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'distill-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** 跑蒸馏 CLI（cwd=fixture 根；配置用 fixture 文件，实例配置默认值永不动）。 */
function runDistill(args, dir, { config = 'config-on.yaml' } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--config', path.join(dir, config)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 目录内容指纹（递归、含内容哈希）—— 「正式区零写入」用它证明，不靠行为描述。 */
function treeDigest(dir) {
  if (!existsSync(dir)) return '<absent>'
  const walk = (d, prefix = '') =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        const p = path.join(d, name)
        const rel = prefix ? `${prefix}/${name}` : name
        if (statSync(p).isDirectory()) return walk(p, rel)
        return [`${rel}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`]
      })
  return walk(dir).join('\n')
}

const proposalsOf = (dir) => {
  const p = path.join(dir, 'proposals')
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.md')).sort() : []
}

describe('产出草案（Entry 契约 + 三要素）', () => {
  it('正向：事件库聚成簇，每簇一份草案；文件名只含稳定簇 ID（不含事件集指纹）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill([], tmp)
      assert.equal(r.status, 0, r.all)
      const files = proposalsOf(tmp)
      assert.equal(files.length, 3, `三条异 fingerprint（跨分片 fp 归并后）应出三份草案，实际: ${JSON.stringify(files)}\n${r.all}`)
      for (const f of files) {
        assert.match(f, /^PROP-[0-9a-f]{16}-.+\.md$/, `草案名应为 PROP-<cluster16>-<slug>.md: ${f}`)
        assert.ok(!/^PROP-[0-9a-f]{8}-/.test(f), `草案名不得含事件集指纹段（带它就每次蒸馏新开一份）: ${f}`)
      }
      const cids = new Set(files.map((f) => f.split('-')[1]))
      assert.equal(cids.size, 3, '三个簇的 cid 必须互不相同（一簇一文件）')
      assert.match(r.stderr, /正式区零写入/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('草案过 validate.mjs（exit 0）+ 三要素齐全：可证伪 claim / 守卫绑定建议 / scope', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const files = proposalsOf(tmp)
      for (const f of files) {
        const v = spawnSync(process.execPath, [VALIDATE_CLI, path.join(tmp, 'proposals', f), '--config', path.join(tmp, 'config-on.yaml')], {
          cwd: tmp,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
        })
        assert.equal(v.status, 0, `草案 ${f} 未过校验器:\n${v.stdout}${v.stderr}`)
      }
      const text = readFileSync(path.join(tmp, 'proposals', files[0]), 'utf8')
      // 7 必填齐全（由校验器兜底，这里断言三要素的**实质**而不只是键存在）
      assert.match(text, /^---\ntype: (LRN|ERR)\nstatus: proposed\nscope: [a-z-]+\n/, '提案态 = type + status: proposed + scope')
      assert.match(text, /guard_ref: null/, '未登记守卫前 guard_ref 必须为 null（草案不代签）')
      assert.match(text, /last_verified_at: null/)
      assert.match(text, /recurrence: [1-9]\d*/)
      // claim 可证伪：给出「若做 X 则失效不再出现」+ 可观测的证伪方式
      assert.match(text, /断言：若在触发该形态之前先跑一遍/, 'claim 缺少可证伪的前置条件')
      assert.match(text, /证伪方式：.*recurrence 不再增长/, 'claim 缺少证伪方式（同义反复的话永不可证伪）')
      // 守卫绑定建议：候选 key + 可执行判定思路 + 破坏测试自检
      // 候选 key 必须是 registry key 形态（小写连字符）—— kind 的下划线已 slug 化成连字符
      const guardKey = text.match(/候选 `guard_ref`.*?`(guard-[a-z0-9]+(?:-[a-z0-9]+)+)`/)
      assert.ok(guardKey, '缺候选 guard_ref（须是 registry key 形态：小写连字符）')
      assert.match(guardKey[1], /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, '候选 key 不符 registry key 形态')
      assert.match(text, /命中判据 → `exit 2` 阻断/, '缺可执行判据（阻断/放行的退出码形态）')
      assert.match(text, /破坏测试自检（登记前必做）/, '缺「注入违规样本必须变红」的自检要求')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('recurrence 取该 fingerprint 跨分片累计次数（3 + 2 = 5，不是单分片的 3）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const build = proposalsOf(tmp).find((f) => f.includes('enoent'))
      assert.ok(build, `未找到 ENOENT 簇草案: ${JSON.stringify(proposalsOf(tmp))}`)
      const text = readFileSync(path.join(tmp, 'proposals', build), 'utf8')
      assert.match(text, /recurrence: 5/, 'recurrence 未取跨分片求和')
      assert.match(text, /簇成员 fingerprint：`fp-2d68f00c5af2f907`/, '归并后应只有一个成员 fingerprint')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('scope 归域正确：docker 构建失效 → infra（条目语料投票），vitest 失效 → testing', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const build = readFileSync(path.join(tmp, 'proposals', proposalsOf(tmp).find((f) => f.includes('enoent'))), 'utf8')
      const vitest = readFileSync(path.join(tmp, 'proposals', proposalsOf(tmp).find((f) => f.includes('vitest'))), 'utf8')
      assert.match(build, /\nscope: infra\n/, 'docker 构建失效应归 infra')
      assert.match(vitest, /\nscope: testing\n/, 'vitest 失效应归 testing')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('证据不足时明说「未归类」落默认桶，而不是编一个看着像的域', () => {
    const tmp = freshTmp()
    try {
      // 事件 token 在条目语料里一个都不命中 → 无归域证据 → 必须落默认桶并明说未归类
      const r = runDistill(['--from', path.join(tmp, 'events-unclassifiable'), '--to', path.join(tmp, 'proposals')], tmp)
      assert.equal(r.status, 0, r.all)
      const files = proposalsOf(tmp)
      assert.equal(files.length, 1, r.all)
      const text = readFileSync(path.join(tmp, 'proposals', files[0]), 'utf8')
      assert.match(text, /\nscope: other\n/, '无证据簇应落默认未归类桶（config.scope.default）')
      assert.match(text, /未归类/, '必须明说未归类并交人工（不能静默猜一个域）')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('显式 --scope 覆盖推断（且非法域 exit 2，先于 kill-switch）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill(['--scope', 'kb'], tmp).status, 0)
      for (const f of proposalsOf(tmp)) {
        assert.match(readFileSync(path.join(tmp, 'proposals', f), 'utf8'), /\nscope: kb\n/)
      }
      const bad = runDistill(['--scope', 'no-such-scope'], tmp)
      assert.equal(bad.status, 2, bad.all)
      assert.match(bad.stderr, /--scope 取值非法/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('只提案不落盘（正式区零写入 · git 级证明的目录快照等价）', () => {
  it('运行前后正式区（entries/）逐文件哈希不变，且提案只落 proposals/', () => {
    const tmp = freshTmp()
    try {
      const before = treeDigest(path.join(tmp, 'entries'))
      const r = runDistill([], tmp)
      assert.equal(r.status, 0, r.all)
      const after = treeDigest(path.join(tmp, 'entries'))
      assert.equal(before, after, '蒸馏器写了正式区 —— 「只提案不落盘」被破坏')
      assert.ok(existsSync(path.join(tmp, 'proposals')), '草案必须落在 proposals_dir')
      assert.ok(proposalsOf(tmp).length > 0)
      // 引擎自身不得持有指向 entries_dir 的写路径（防后续回归引入）
      const src = readFileSync(CLI, 'utf8')
      assert.ok(!/writeFileSync\([^)]*entries_dir/.test(src), '引擎出现指向 entries_dir 的写盘调用')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--dry-run：报告将要产出什么但零写盘（连提案目录都不建）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill(['--dry-run', '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const parsed = JSON.parse(r.stdout)
      assert.equal(parsed.proposals.length, 3)
      assert.ok(parsed.proposals.every((p) => p.action === 'dry-run'))
      assert.ok(!existsSync(path.join(tmp, 'proposals')), '--dry-run 不得建提案目录')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('幂等（同一事件集重复蒸馏不产生新草案）', () => {
  it('连跑两次：草案文件名与内容逐字节不变（第二次全部 unchanged，mtime 不动）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const names = proposalsOf(tmp)
      const digest1 = names.map((f) => [f, readFileSync(path.join(tmp, 'proposals', f), 'utf8')])
      const mtime1 = names.map((f) => statSync(path.join(tmp, 'proposals', f)).mtimeMs)

      const second = runDistill(['--json'], tmp)
      assert.equal(second.status, 0, second.all)
      const parsed = JSON.parse(second.stdout)
      assert.ok(parsed.proposals.every((p) => p.action === 'unchanged'), `第二次应全部 unchanged: ${JSON.stringify(parsed.proposals.map((p) => p.action))}`)

      const names2 = proposalsOf(tmp)
      assert.deepEqual(names2, names, '第二次跑出了新的草案文件（集合变了）')
      for (const [f, text] of digest1) {
        assert.equal(readFileSync(path.join(tmp, 'proposals', f), 'utf8'), text, `草案 ${f} 内容在重复蒸馏后变了（内容不得含运行时刻）`)
      }
      for (let i = 0; i < names2.length; i++) {
        assert.equal(statSync(path.join(tmp, 'proposals', names2[i])).mtimeMs, mtime1[i], 'unchanged 草案不应被重写（mtime 不动）')
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('事件集变化 → 同一簇**原地更新**（不另开新文件、不留旧副本），事实不过期', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const before = proposalsOf(tmp)
      assert.equal(before.length, 3)
      const extra = path.join(tmp, 'events', 'events-20261018.jsonl')
      const rows = readFileSync(path.join(tmp, 'events', 'events-20261016.jsonl'), 'utf8').split('\n').filter(Boolean)
      rows.push(JSON.stringify({ ...JSON.parse(rows[1]), id: 'evt-20261018-009', ts: '2026-10-18T09:00:00.000Z', last_ts: '2026-10-18T09:00:01.000Z', count: 1 }))
      mkdirSync(path.dirname(extra), { recursive: true })
      writeFileSync(extra, `${rows.join('\n')}\n`, 'utf8')
      assert.equal(runDistill([], tmp).status, 0)
      const after = proposalsOf(tmp)
      assert.deepEqual(after, before, `同一簇事件复发后草案名必须不变（原地更新），实得 ${JSON.stringify(after)}`)
      const names = proposalsOf(tmp)
      const enoentFile = names.find((f) => f.includes('enoent'))
      const recurrenceOf = (f) => Number(/^recurrence: (\d+)$/m.exec(readFileSync(path.join(tmp, 'proposals', f), 'utf8'))[1])
      const recurrenceAfter = recurrenceOf(enoentFile)
      assert.ok(recurrenceAfter > 5, `recurrence 应随新事件增长（原地更新，不是停在旧值 5），实得 ${recurrenceAfter}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('陈旧清扫（proposals 目录收敛到「一簇一份」）', () => {
  const cidOf = (name) => name.split('-')[1]

  it('簇消失后重跑 → 该簇的旧草案被清掉（活着的簇不动）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      assert.equal(proposalsOf(tmp).length, 3)
      const doomed = proposalsOf(tmp).find((f) => f.includes('enoent'))
      // 把 ENOENT 簇的全部事件删掉（换成一个空分片）→ 该簇本轮不成簇
      const shards = readdirSync(path.join(tmp, 'events')).filter((f) => f.endsWith('.jsonl'))
      const kept = []
      for (const s of shards) {
        for (const line of readFileSync(path.join(tmp, 'events', s), 'utf8').split('\n').filter(Boolean)) {
          const rec = JSON.parse(line)
          if (!/2d68f00c5af2f907/.test(rec.fingerprint)) kept.push(line)
        }
      }
      writeFileSync(path.join(tmp, 'events', shards[0]), kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
      for (const s of shards.slice(1)) rmSync(path.join(tmp, 'events', s))

      const r = runDistill(['--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const files = proposalsOf(tmp)
      assert.equal(files.length, 2, `消失的簇的草案必须被清掉，实得 ${JSON.stringify(files)}`)
      assert.ok(!files.includes(doomed), `陈旧草案未被清掉: ${doomed}`)
      assert.deepEqual(JSON.parse(r.stdout).stale.map((s) => s.fileName), [doomed], 'stale 清单须点名被清掉的草案')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('重复蒸馏同一事件集：提案数不增（不因 recurrence 增长散出新文件）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const first = proposalsOf(tmp)
      // recurrence +2（再灌一份同 fp 分片，count=2）→ 集指纹变了但簇没变
      const shard = path.join(tmp, 'events', 'events-20261018.jsonl')
      const rows = readFileSync(path.join(tmp, 'events', 'events-20261016.jsonl'), 'utf8').split('\n').filter(Boolean)
      rows.push(JSON.stringify({ ...JSON.parse(rows[1]), id: 'evt-20261018-010', ts: '2026-10-18T09:00:00.000Z', last_ts: '2026-10-18T09:00:01.000Z', count: 2 }))
      writeFileSync(shard, `${rows.join('\n')}\n`, 'utf8')
      assert.equal(runDistill([], tmp).status, 0)
      const after = proposalsOf(tmp)
      assert.equal(after.length, first.length, `提案数不得增长（recurrence 增长应原地更新），实得 ${JSON.stringify(after)}`)
      assert.deepEqual(after, first, '文件名必须逐个相同（只含稳定 cid）')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('旧命名的重复副本（PROP-<evtset8>-<cid>-<slug>.md）一并清扫，且列入 --dry-run 清单', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const fresh = proposalsOf(tmp)
      // 造一份旧命名的同簇副本（真实仓库里 434 份里绝大多数就是它）
      const dup = fresh.map((f) => `PROP-deadbeef-${f.replace(/^PROP-/, '')}`).sort()
      for (const d of dup) writeFileSync(path.join(tmp, 'proposals', d), '旧副本\n', 'utf8')
      assert.equal(proposalsOf(tmp).length, 6)

      const dry = runDistill(['--dry-run', '--json'], tmp)
      assert.equal(dry.status, 0, dry.all)
      const stale = JSON.parse(dry.stdout).stale
      assert.deepEqual(stale.map((s) => s.fileName), dup, '--dry-run 须列出全部旧命名副本')
      assert.ok(stale.every((s) => s.reason === 'legacy-naming'), '旧命名副本须标 reason=legacy-naming')
      assert.equal(proposalsOf(tmp).length, 6, '--dry-run 一个文件都不许删')

      const r = runDistill(['--json'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.deepEqual(proposalsOf(tmp), fresh, '清扫后只剩本轮的一簇一份')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--dry-run：不删任何文件（既有草案与陈旧草案全留），只报清单', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const before = proposalsOf(tmp)
      // 人为放一份 cid 不存在的草案（模拟簇已消失的陈旧件）
      const orphan = 'PROP-ffffffffffffffff-ghost-cluster.md'
      writeFileSync(path.join(tmp, 'proposals', orphan), '孤儿草案\n', 'utf8')

      const r = runDistill(['--dry-run', '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const parsed = JSON.parse(r.stdout)
      assert.deepEqual(parsed.stale.map((s) => s.fileName), [orphan], '--dry-run 须报出将要清扫的陈旧草案')
      assert.ok(parsed.stale.every((s) => s.action === 'stale-dry-run'))
      assert.deepEqual(proposalsOf(tmp), [...before, orphan].sort(), '--dry-run 零删除')
      assert.equal(readFileSync(path.join(tmp, 'proposals', orphan), 'utf8'), '孤儿草案\n', '--dry-run 不得动文件内容')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('来源宇宙与落位不同源（--from 指向别的事件集、--to 指向本提案目录）→ 拒绝清扫', () => {
    // 主代理复核补的洞：存活集合是「本轮读到的事件」推出来的。
    // 拿别的事件集算存活集合、却去扫本仓库的提案目录 → 真实草案会被整片判为陈旧删光，
    // 而「空集安全阀」挡不住（A 宇宙非空）。批量删文件正是 ERR-20261017-002 点名的反模式。
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const before = proposalsOf(tmp)
      assert.equal(before.length, 3)

      // 造一个「另一个宇宙」：只有一枚与本目录毫无关系的簇
      const alien = path.join(tmp, 'events-alien')
      mkdirSync(alien, { recursive: true })
      writeFileSync(
        path.join(alien, 'events-20261017.jsonl'),
        `${JSON.stringify({
          id: 'evt-20261017-777',
          ts: '2026-10-17T00:00:00.000Z',
          first_ts: '2026-10-17T00:00:00.000Z',
          last_ts: '2026-10-17T00:00:00.000Z',
          count: 9,
          source: 'tool',
          kind: 'tool_error',
          severity: 'error',
          payload: { message: 'ALIEN-UNIVERSE-ONLY failure mode' },
          fingerprint: 'fp-1111111111111111',
          codes: ['ALIEN'],
          tokens: ['alien', 'universe'],
          near_neighbors: [],
        })}\n`,
        'utf8',
      )

      const r = runDistill(['--from', alien, '--to', path.join(tmp, 'proposals'), '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const parsed = JSON.parse(r.stdout)
      assert.deepEqual(parsed.stale, [], '跨宇宙清扫必须被拒：stale 清单须为空')
      assert.ok(parsed.sweep_skipped, '须在输出里明说为什么跳过')
      // 注意：写入**不受**这道闸管（--to 是调用方显式指定的），被拒的只是清扫。
      // 要守的不变量是「既有草案一个都没被删」，不是「目录字节不变」。
      const after = proposalsOf(tmp)
      for (const f of before) {
        assert.ok(after.includes(f), `既有草案被误删: ${f}（实得 ${JSON.stringify(after)}）`)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('空事件库 → 不清扫（零副作用：不碰 proposals 目录里的既有草案）', () => {
    const tmp = freshTmp()
    try {
      assert.equal(runDistill([], tmp).status, 0)
      const before = proposalsOf(tmp)
      assert.equal(before.length, 3)
      const r = runDistill(['--from', path.join(tmp, 'events-empty'), '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.deepEqual(JSON.parse(r.stdout).stale, [], '空库不得清扫（否则一次空跑就清空人工评审队列）')
      assert.deepEqual(proposalsOf(tmp), before, '空库不得删任何既有草案')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('非 PROP-*.md 的文件（README / 人工手记）不被清扫误伤', () => {
    const tmp = freshTmp()
    try {
      mkdirSync(path.join(tmp, 'proposals'), { recursive: true })
      const keep = ['README.md', 'manual-note.md', 'PROP-notahex-slug.md']
      for (const f of keep) writeFileSync(path.join(tmp, 'proposals', f), '人工内容\n', 'utf8')
      assert.equal(runDistill(['--json'], tmp).status, 0)
      for (const f of keep) {
        assert.ok(existsSync(path.join(tmp, 'proposals', f)), `清扫误伤了非草案文件: ${f}`)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('破坏测试 / kill-switch / 用法', () => {
  it('空事件库 → exit 0、0 草案、不报错、不造假（连提案目录都不建）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill(['--from', path.join(tmp, 'events-empty'), '--json'], tmp)
      assert.equal(r.status, 0, `空库必须 exit 0，实得 ${r.status}\n${r.all}`)
      const parsed = JSON.parse(r.stdout)
      assert.equal(parsed.events_read, 0)
      assert.deepEqual(parsed.proposals, [], '空库不得产出任何草案')
      assert.ok(!existsSync(path.join(tmp, 'proposals')), '空库不得建提案目录（零副作用）')
      assert.match(r.stderr, /0 个草案/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('事件目录不存在 → exit 0 空列表（缺目录与空目录同语义，不报错）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill(['--from', path.join(tmp, 'no-such-dir'), '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.deepEqual(JSON.parse(r.stdout).proposals, [])
      assert.ok(!existsSync(path.join(tmp, 'proposals')))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('事件库有坏行 → 跳过坏行、其余照常蒸馏（单行坏掉不毁整个蒸馏）', () => {
    const tmp = freshTmp()
    try {
      const shard = path.join(tmp, 'events', 'events-20261016.jsonl')
      const text = readFileSync(shard, 'utf8')
      writeFileSync(shard, `${text}{ 这不是 JSON\n`, 'utf8')
      const r = runDistill(['--json'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.match(r.stderr, /跳过坏行/)
      assert.equal(JSON.parse(r.stdout).proposals.length, 3, '坏行不应吃掉其余事件')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('kill-switch distill=off（= 本仓实例真值）→ 零草案零写盘，exit 0', () => {
    const tmp = freshTmp()
    try {
      const before = treeDigest(path.join(tmp, 'entries'))
      const r = runDistill([], tmp, { config: 'config-off.yaml' })
      assert.equal(r.status, 0, r.all)
      assert.match(r.stderr, /kill_switch\.distill=false/)
      assert.ok(!existsSync(path.join(tmp, 'proposals')), 'off 态不得建提案目录')
      assert.ok(!existsSync(path.join(tmp, 'audit')), 'off 态不得写审计（零副作用）')
      assert.equal(treeDigest(path.join(tmp, 'entries')), before)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('stdout 默认恒空（钩子 stdout 是严格 JSON schema，多一个键就判失败）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill([], tmp)
      assert.equal(r.stdout, '', `默认 stdout 必须恒空，摘要走 stderr；实得:\n${r.stdout}`)
      assert.ok(r.stderr.length > 0, '人类可读摘要应走 stderr')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--min-count 过滤：低于阈值的簇不出草案（降噪）', () => {
    const tmp = freshTmp()
    try {
      const r = runDistill(['--min-count', '2', '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const files = proposalsOf(tmp)
      assert.equal(files.length, 1, `--min-count 2 应只留 recurrence=5 的簇，实得 ${JSON.stringify(files)}`)
      assert.ok(files[0].includes('enoent'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('用法错误：未知参数 / --from 后缺值 / --min-count 非法 → exit 2，且零写盘', () => {    const tmp = freshTmp()
    try {
      const cases = [
        [['--nope'], /未知参数/],
        [['--from'], /后须跟值/],
        [['--min-count', 'abc'], /--min-count 须为 ≥0 整数/],
      ]
      for (const [args, re] of cases) {
        const r = runDistill(args, tmp)
        assert.equal(r.status, 2, `期望 exit 2: ${args.join(' ')}\n${r.all}`)
        assert.match(r.stderr, re)
      }
      assert.ok(!existsSync(path.join(tmp, 'proposals')), '用法错误不得落盘')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('配置损坏 → exit 0、零草案、fail-open（绝不阻塞调用方）', () => {
    const tmp = freshTmp()
    try {
      const bad = path.join(tmp, 'config-broken.yaml')
      writeFileSync(bad, 'version: 1\nscope:\n  values: []\n', 'utf8')
      const r = runDistill([], tmp, { config: 'config-broken.yaml' })
      assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.all}`)
      assert.match(r.stderr, /fail-open/)
      assert.ok(!existsSync(path.join(tmp, 'proposals')), 'fail-open 不得写草案')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('触发面接线片段（宿主无 SessionEnd → 只出片段不接线）', () => {
  const FRAGMENT = path.join(SKILL_ROOT, 'references', 'hook-wiring-distill.json')
  /** 宿主 ZCode 支持的全部 hook 事件（ diagnosing-hooks 权威口径）；SessionEnd 不在其中。 */
  const HOST_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop']

  it('片段只挂在宿主支持的 Stop 事件上（不得出现 SessionEnd 等未支持事件名）', () => {
    const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8'))
    const events = Object.keys(fragment.events)
    assert.equal(events.length, 1, '片段应只含一个触发事件')
    assert.ok(HOST_EVENTS.includes(events[0]), `宿主不支持事件 ${events[0]}（合法: ${HOST_EVENTS.join(', ')}）`)
    assert.equal(events[0], 'Stop', '降级触发面 = Stop（最接近会话收尾的宿主事件）')
    assert.ok(!events.includes('SessionEnd'), '宿主无 SessionEnd，片段不得写不存在的接线点')
  })

  it('片段命令级执行：argv 可直接跑、exit 0、stdout 恒空（宿主把 stdout 当严格 JSON 解析）', () => {
    const tmp = freshTmp()
    try {
      const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8'))
      const hook = fragment.events.Stop[0].hooks[0]
      const argv = hook.args
        .map((a) => a.replace(/\$\{ZCODE_PROJECT_DIR\}/g, tmp).replace(/<SKILL_DIR>/g, SKILL_ROOT))
      const r = spawnSync(hook.command, argv, {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(tmp, 'config-on.yaml') },
      })
      const all = `${r.stdout ?? ''}${r.stderr ?? ''}`
      assert.equal(r.status, 0, `片段命令必须 exit 0，实得 ${r.status}\n${all}`)
      assert.equal(r.stdout ?? '', '', `钩子 stdout 必须恒空（严格 JSON schema，多一个键就判失败）:\n${r.stdout}`)
      assert.equal(proposalsOf(tmp).length, 3, 'Stop 触发面确实产出了草案（开态）')
      assert.ok(hook.timeoutMs >= 10_000, '外层超时须给足 node 启动余量')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('kill-switch off 时片段命令零副作用（接线存在不等于功能开启）', () => {
    const tmp = freshTmp()
    try {
      const fragment = JSON.parse(readFileSync(FRAGMENT, 'utf8'))
      const hook = fragment.events.Stop[0].hooks[0]
      const argv = hook.args
        .map((a) => a.replace(/\$\{ZCODE_PROJECT_DIR\}/g, tmp).replace(/<SKILL_DIR>/g, SKILL_ROOT))
      const r = spawnSync(hook.command, argv, {
        cwd: tmp,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, SELF_IMPROVING_CONFIG: path.join(tmp, 'config-off.yaml') },
      })
      assert.equal(r.status, 0, `${r.stdout ?? ''}${r.stderr ?? ''}`)
      assert.equal(r.stdout ?? '', '')
      assert.ok(!existsSync(path.join(tmp, 'proposals')), 'off 态不得建提案目录')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
