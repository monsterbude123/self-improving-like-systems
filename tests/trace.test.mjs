/**
 * trace.test.mjs —— 运维验收与止损对账（node:test，零框架依赖）
 *
 * 口径（票 13 AC 全部 fixture 化）：
 *   - 正向：一条真实形态的六拍链（事件 → 条目 → 守卫登记 → 守卫运行 → 拦截 → 回写）→ exit 0「通过」，
 *     且**每一拍都带指向原始记录的行级引用**（`文件:行号`）——没有引用的结论不算可核查；
 *   - 二值判定：无任何条目走完六拍 → exit 1「触发冻结」（真实仓当前就是 1，如实判、不粉饰）；
 *   - 只读：跑完 trace 前后整棵目录摘要必须一致（本命令一个字节都不许写）；
 *   - 破坏：夹具数据冒充真实（塞进真实事件目录的 `fixtures/` 子目录、配置指向夹具目录）必须被排除/拒绝；
 *     事实损坏（registry / 守卫状态坏掉）是 exit 2 而不是 exit 1 —— 「读不到」≠「没跑起来」；
 *     抽掉任一拍的证据（swept_hits / 对质段 / last_run / covered_entries）必须判红。
 *
 * fixture = tests/fixtures/trace/（整目录拷到临时目录；项目实例配置不动）。
 * 双后端：YAML 读取经 scripts/lib/yaml-lite.mjs（宿主无 js-yaml → 降级后端；容器有 js-yaml → js-yaml）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const TRACE = path.join(SKILL_ROOT, 'scripts', 'trace.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'trace')
const CONFIG = 'config.yaml'
const CHAIN_ID = 'LRN-20261016-001'
const UNBOUND_ID = 'LRN-20261016-002'
const EVENT_IDS_ID = 'LRN-20261016-003'
const GUARD_KEY = 'guard-fixture-trace-chain'

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'trace-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

function runTrace(dir, args = [], { config = CONFIG } = {}) {
  const r = spawnSync(process.execPath, [TRACE, ...args, '--config', path.join(dir, config)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * 把夹具的 **wild 链**改造成一条**完整的 probe 链**（末次观测健康度用例的前置）。
 *
 * 不这么搭会踩一个隐蔽的坑：夹具里 probe_hits=0，只把 wild_hits 清零并不会让拍5 走 probe 分支 ——
 * 它会因为「压根没有探针证据」而红，那是与被测判据无关的红，绿/红两侧断言都会失去意义。
 * 探针证据龄用「当天」而非固定日期，否则夹具放久了会因超过 retire.cycle_days 而恒红。
 */
function makeProbeChain(dir, patch = {}) {
  const p = path.join(dir, 'work', 'guard-state.json')
  const st = JSON.parse(readFileSync(p, 'utf8'))
  const today = new Date().toISOString()
  st.entries[CHAIN_ID] = {
    ...st.entries[CHAIN_ID],
    wild_hits: 0,
    first_wild_hit: undefined,
    legacy_hits: 0,
    probe_hits: 1,
    probe_last_outcome: 'proven',
    probe_last_outcome_at: today,
    observed_error_runs: 0,
    last_observation: 'healthy',
    last_observation_at: today,
    pending_hits: 0,
    pending_records: [],
    pending_probes: 0,
    pending_probe_records: [],
    swept_hits: 0,
    swept_probes: 1,
    last_probe_swept_at: today,
    ...patch,
  }
  writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
}

/** 整棵目录摘要（只读断言的基准）：路径 + 内容 sha256，目录项也计入（防新增/改名）。 */
function treeDigest(dir) {
  const hash = createHash('sha256')
  const walk = (abs, rel) => {
    const st = statSync(abs)
    if (st.isDirectory()) {
      hash.update(`D ${rel}\n`)
      for (const name of readdirSync(abs).sort()) walk(path.join(abs, name), rel === '' ? name : `${rel}/${name}`)
    } else {
      hash.update(`F ${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`)
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

const traceJson = (dir, args = []) => {
  const r = runTrace(dir, [...args, '--json'])
  return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null }
}

describe('六拍正向：一条真实条目自然走完 → exit 0', () => {
  it('全链可追溯，每拍都带指向原始记录的行级引用，且只读零写', () => {
    const dir = freshTmp()
    try {
      const before = treeDigest(dir)
      const r = traceJson(dir)
      assert.equal(r.status, 0, r.all)
      assert.equal(r.json.verdict, 'pass')
      const chain = r.json.traces.find((t) => t.id === CHAIN_ID)
      assert.ok(chain, `报告里必须有 ${CHAIN_ID}`)
      assert.equal(chain.ok, true, '六拍必须全绿')

      // 逐拍断言：既判绿，也必须有可核查的 `文件:行号`。
      const expects = {
        1: /events-20261016\.jsonl:\d+$/,
        2: /LRN-20261016-001-fixture-trace-chain\.md:\d+$/,
        3: /registry\.yaml:\d+$/,
        4: /guard-state\.json:\d+$/,
        5: /guard-state\.json/,
        6: /LRN-20261016-001-fixture-trace-chain\.md:\d+$/,
      }
      for (const b of chain.beats) {
        assert.equal(b.ok, true, `拍${b.beat} ${b.name} 应为绿`)
        assert.ok(b.evidence.length > 0, `拍${b.beat} 必须有证据`)
        assert.ok(
          b.evidence.some((e) => expects[b.beat].test(e.at)),
          `拍${b.beat} ${b.name} 缺少行级引用（期望形如 ${expects[b.beat]}）：${JSON.stringify(b.evidence.map((e) => e.at))}`,
        )
      }

      // 拍1 走的是强链接（entry_id 直接命中），不是时间共现。
      assert.match(chain.beats[0].evidence[0].note, /entry-id/, '事件链接须标明强度（强=entry_id）')
      // 拍6 的回写结论要能追到正文末尾的对质段与账上的 swept_hits。
      assert.ok(chain.beats[5].evidence.some((e) => /对质段/.test(e.note ?? '')), '拍6 必须引用正文对质段')
      assert.ok(chain.beats[5].evidence.some((e) => /swept_hits=2/.test(e.note ?? '')), '拍6 必须引用账上 swept_hits')

      // 时间线：recurrence / last_verified_at 的每个结论都有引用。
      assert.ok(chain.timeline.length >= 4, `时间线至少 4 个节点，实际 ${chain.timeline.length}`)
      assert.ok(chain.timeline.every((n) => typeof n.ref.at === 'string' && n.ref.at.length > 0), '时间线每节点都要带引用')
      assert.ok(
        chain.timeline.some((n) => /last_verified_at/.test(n.label)),
        '时间线须含 last_verified_at 溯源节点',
      )

      assert.equal(treeDigest(dir), before, 'trace 是只读命令：跑完目录摘要必须逐字节不变')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拍1 强链接走条目侧 event_ids（事件侧 entry_id 恒 null 也能判绿）', () => {
    const dir = freshTmp()
    try {
      const r = traceJson(dir, ['--id', EVENT_IDS_ID])
      assert.equal(r.status, 1, '本条目只走通了拍1，其余拍红 → exit 1，如实判')
      const t = r.json.traces[0]
      assert.equal(t.id, EVENT_IDS_ID)
      assert.equal(t.beats[0].ok, true, '只靠 event_ids 关联也必须让拍1 判绿')
      assert.match(t.beats[0].evidence[0].note, /entry-ids/, '证据须标明链接类型来自条目侧 event_ids')
      assert.match(t.beats[0].evidence[0].note, /evt-20261016-002/, '证据须点名被关联的事件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('条目声明的来源事件查无记录时，拍1 显式报「声明过但查无此事」而不是静默丢弃', () => {
    const dir = freshTmp()
    try {
      const p = path.join(dir, 'entries', `${EVENT_IDS_ID}-fixture-eventids.md`)
      writeFileSync(p, readFileSync(p, 'utf8').replace('"evt-20261016-002"', '"evt-20991231-999"'), 'utf8')
      const r = traceJson(dir, ['--id', EVENT_IDS_ID])
      assert.equal(r.status, 1)
      const t = r.json.traces[0]
      assert.equal(t.beats[0].ok, false, '事件库里没有这条事实，拍1 必须红')
      assert.ok(
        t.beats[0].evidence.some((e) => /evt-20991231-999/.test(e.note ?? '') && /查无此记录/.test(e.note ?? '')),
        `须显式点名缺失的事件：${JSON.stringify(t.beats[0].evidence.map((e) => e.note))}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未绑定的条目照实判红，但只要有 ≥1 条走完就整体 exit 0', () => {
    const dir = freshTmp()
    try {
      const r = traceJson(dir)
      assert.equal(r.status, 0, r.all)
      const unbound = r.json.traces.find((t) => t.id === UNBOUND_ID)
      assert.ok(unbound, `报告里必须有 ${UNBOUND_ID}`)
      assert.equal(unbound.ok, false, '未绑定条目的六拍必须红')
      assert.equal(unbound.beats[1].ok, false, 'guard_ref=null 时拍2 必须红')
      assert.equal(unbound.beats[2].ok, false, '拍3 必���红')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--id 只对账单条（其余条目不进报告）', () => {
    const dir = freshTmp()
    try {
      const r = traceJson(dir, ['--id', UNBOUND_ID])
      assert.equal(r.status, 1, '只对账未走完的条目 → 触发冻结')
      assert.deepEqual(r.json.traces.map((t) => t.id), [UNBOUND_ID])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('二值判定：未走完 → exit 1 触发冻结', () => {
  const breakCases = [
    {
      name: '抽掉 swept_hits（账上从没回写过）',
      why: '拍6 判据',
      apply: (dir) => {
        const p = path.join(dir, 'work', 'guard-state.json')
        const st = JSON.parse(readFileSync(p, 'utf8'))
        delete st.entries[CHAIN_ID].swept_hits
        writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      },
    },
    {
      name: '守卫没挣到 blocking（还在 shadow）',
      why: '拍4 判据',
      apply: (dir) => {
        const p = path.join(dir, 'work', 'guard-state.json')
        const st = JSON.parse(readFileSync(p, 'utf8'))
        st.guards[GUARD_KEY].mode = 'shadow'
        st.guards[GUARD_KEY].shadow_runs = 1
        st.guards[GUARD_KEY].shadow_green = 1
        writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      },
    },
    {
      name: '守卫从没派发过（无 last_run）',
      why: '拍4 判据',
      apply: (dir) => {
        const p = path.join(dir, 'work', 'guard-state.json')
        const st = JSON.parse(readFileSync(p, 'utf8'))
        delete st.guards[GUARD_KEY].last_run
        writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      },
    },
    {
      name: 'registry 不声明 covered_entries（无可追溯的覆盖声明）',
      why: '拍3 判据',
      apply: (dir) => {
        const p = path.join(dir, 'registry.yaml')
        writeFileSync(p, readFileSync(p, 'utf8').replace(/^ {4}covered_entries:.*\n/m, ''), 'utf8')
      },
    },
    {
      name: '野外命中数被清零（从未被现实攻击过）',
      why: '拍5 判据（wild 路径）',
      apply: (dir) => {
        const p = path.join(dir, 'work', 'guard-state.json')
        const st = JSON.parse(readFileSync(p, 'utf8'))
        st.entries[CHAIN_ID].wild_hits = 0
        writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      },
    },
    {
      name: '分型前的历史命中（legacy-unknown）：不追溯追认成 wild',
      why: '拍5 判据（保守回填的兜底）',
      apply: (dir) => {
        const p = path.join(dir, 'work', 'guard-state.json')
        const st = JSON.parse(readFileSync(p, 'utf8'))
        st.entries[CHAIN_ID].wild_hits = 0
        st.entries[CHAIN_ID].first_wild_hit = undefined
        st.entries[CHAIN_ID].legacy_hits = 2
        writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      },
    },
    {
      name: '正文对质段被删（回写没留下可核查的痕迹）',
      why: '拍6 判据',
      apply: (dir) => {
        const name = readdirSync(path.join(dir, 'entries')).find((n) => n.startsWith(CHAIN_ID))
        const p = path.join(dir, 'entries', name)
        writeFileSync(p, readFileSync(p, 'utf8').replace(/^### 复发 \d+ · \d{4}-\d{2}-\d{2}$/gm, '### 复发 N'), 'utf8')
      },
    },
    {
      name: '事件库清空（第一拍就没有事实）',
      why: '拍1 判据',
      apply: (dir) => {
        rmSync(path.join(dir, 'work', 'events'), { recursive: true, force: true })
        mkdirSync(path.join(dir, 'work', 'events'), { recursive: true })
      },
    },
    {
      name: '末次观测仍是守卫异常（判据现在还没跑起来过）',
      why: '拍5 probe 分支（末次观测健康度）',
      apply: (dir) => makeProbeChain(dir, { last_observation: 'error' }),
    },
  ]

  for (const c of breakCases) {
    it(`${c.name} → exit 1（${c.why}）`, () => {
      const dir = freshTmp()
      try {
        c.apply(dir)
        const r = traceJson(dir)
        assert.equal(r.status, 1, `${c.name} 必须判冻结:\n${r.all}`)
        assert.equal(r.json.verdict, 'freeze')
        const chain = r.json.traces.find((t) => t.id === CHAIN_ID)
        assert.equal(chain.ok, false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  /**
   * 末次观测健康度判据（evt-20261017-033 补洞）—— 拍5 probe 分支的**绿灯侧**。
   *
   * 洞的由来：证据门原先用**累计**计数 `observed_error_runs == 0`，而该计数只增不减，
   * 于是守卫异常过一次就把它覆盖的条目**永久**锁死（实测：D13 退出码与守卫协议错配，
   * 第一次 probe 返回 exit=1 error，ERR-20261017-032 此后拍5 永远判红）。
   * 这条断言的存在意义 = 防止有人「顺手」把门又改回累计判据而测试仍然绿。
   */
  it('绿灯侧：末次观测 healthy 时，历史判据异常不得再把条目永久锁死', () => {
    const dir = freshTmp()
    try {
      makeProbeChain(dir, { observed_error_runs: 7, last_observation: 'healthy' })
      const r = traceJson(dir)
      const chain = r.json.traces.find((t) => t.id === CHAIN_ID)
      const beat5 = chain.beats.find((b) => b.beat === 5)
      assert.equal(beat5.ok, true, `末次健康就该判绿（历史异常只供人审，不作门）:\n${r.all}`)
      assert.equal(chain.ok, true, `六拍应全绿:\n${r.all}`)
      assert.equal(r.status, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('旧账回退：账上没有 last_observation 时仍按旧判据（不追溯洗白）', () => {
    const dir = freshTmp()
    try {
      const rec = { observed_error_runs: 1 }
      makeProbeChain(dir, rec)
      const p = path.join(dir, 'work', 'guard-state.json')
      const st = JSON.parse(readFileSync(p, 'utf8'))
      delete st.entries[CHAIN_ID].last_observation
      delete st.entries[CHAIN_ID].last_observation_at
      writeFileSync(p, `${JSON.stringify(st, null, 2)}\n`, 'utf8')
      const r = traceJson(dir)
      const chain = r.json.traces.find((t) => t.id === CHAIN_ID)
      const beat5 = chain.beats.find((b) => b.beat === 5)
      assert.equal(beat5.ok, false, `旧账缺末次健康度时不得乐观判绿（否则等于追溯洗白）:\n${r.all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('契约对拍：schema 与 trace 头注对拍5 证据门的表述，不许再有两套说法', () => {
    const schema = readFileSync(path.join(SKILL_ROOT, 'references', 'schema.md'), 'utf8')
    const head = readFileSync(TRACE, 'utf8').slice(0, 6000)
    // 判据行（schema 的拍5 表行 + trace 头注两处）必须点名 last_observation，
    // 且**不得**把累计计数单独写成门 —— 「旧账回退到累计判据」的说明里出现它是合法的，
    // 所以只查「判据行本身」，不做全文否定。
    const beat5Row = /^\| 拍5 拦截命中 \|.*$/m.exec(schema)
    assert.ok(beat5Row, 'schema 必须保留拍5 判据表行')
    assert.match(beat5Row[0], /last_observation == 'healthy'/, `schema 拍5 行必须以末次观测健康度为门：${beat5Row[0]}`)
    assert.match(head, /last_observation == 'healthy'/, 'trace 头注必须与 schema 对拍同一判据')
    assert.ok(
      !/observed_error_runs == 0/.test(beat5Row[0].split('（旧账')[0]),
      `schema 拍5 行的**门本体**仍写着累计计数（括号里的旧账回退说明是合法的）：${beat5Row[0]}`,
    )
    // schema §3.1 那句「不参与退役证据」是本次修复的锚点，必须还在
    assert.match(schema, /observed_error_runs[\s\S]{0,120}不参与退役证据/)
  })

  it('报告必须给出冻结指引（人知道下一步做什么）', () => {
    const dir = freshTmp()
    try {
      rmSync(path.join(dir, 'work', 'events'), { recursive: true, force: true })
      mkdirSync(path.join(dir, 'work', 'events'), { recursive: true })
      const r = runTrace(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /stoploss\.md/, '冻结报告必须指向止损程序文档')
      assert.match(r.all, /只保留事件捕获/, '止损摘要必须说明保留什么')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('破坏测试（红向）：夹具冒充真实一律判红', () => {
  it('把整条六拍链复制进事件目录下的 fixtures/ 子目录 → 显式排除，且不得把判定凑绿', () => {
    const dir = freshTmp()
    try {
      // 先把真链打断（事件库清空），再把「假的完整链」塞进 fixtures/ 子目录冒充真实数据。
      rmSync(path.join(dir, 'work', 'events'), { recursive: true, force: true })
      const fake = path.join(dir, 'work', 'events', 'fixtures')
      mkdirSync(fake, { recursive: true })
      cpSync(path.join(FIXTURE_DIR, 'work', 'events'), fake, { recursive: true })

      const r = traceJson(dir)
      assert.equal(r.status, 1, `夹具数据不得让判定变绿:\n${r.all}`)
      assert.equal(r.json.verdict, 'freeze')
      assert.equal(r.json.counts.events, 0, '落在 fixtures/ 下的事件记录一条都不许进统计')
      const excluded = r.json.excluded.filter((e) => e.kind === 'fixture')
      assert.ok(excluded.length > 0, '夹具路径必须在报告里被点名列出')
      assert.match(excluded[0].file, /fixtures/, excluded[0].file)
      assert.match(excluded[0].reason, /夹具目录名/, excluded[0].reason)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('把夹具条目塞进条目区的 fixtures/ 子目录 → 排除，不当成正式条目', () => {
    const dir = freshTmp()
    try {
      cpSync(FIXTURE_DIR, path.join(dir, 'entries', 'fixtures'), { recursive: true })
      const r = traceJson(dir)
      // 收紧（票 H2 · 审计 P1-B）：原断言写成 `... || true` —— 恒真，等于没断言。
      // 它想说的 sanity 是「根层的本仓条目仍被当成正式条目出链」，那就真去查这条链在不在。
      assert.ok(
        r.json.traces.some((t) => t.id === CHAIN_ID),
        `sanity：根层的本仓条目仍应出链（实得 ${r.json.traces.map((t) => t.id).join(', ') || '空'}）`,
      )
      const excluded = r.json.excluded.filter((e) => e.kind === 'fixture' && /fixtures/.test(e.file))
      assert.ok(excluded.length > 0, '条目区的夹具子目录必须被点名')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('配置把数据源指向夹具目录 → exit 2 拒绝出报告（夹具当事实源的报告比没报告更危险）', () => {
    const dir = freshTmp()
    try {
      const p = path.join(dir, CONFIG)
      writeFileSync(p, readFileSync(p, 'utf8').replace('entries_dir: entries/', 'entries_dir: tests/fixtures/trace/entries/'), 'utf8')
      const r = runTrace(dir)
      assert.equal(r.status, 2, r.all)
      assert.match(r.all, /夹具/, '必须说清为什么拒绝')
      assert.doesNotMatch(r.stdout, /判定 =/, '拒绝时不得输出任何判定结论')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('配置指向 *.example.* 模板文件 → 同样 exit 2（技能自带模板不是任何仓的运行事实）', () => {
    const dir = freshTmp()
    try {
      const p = path.join(dir, CONFIG)
      writeFileSync(p, readFileSync(p, 'utf8').replace('registry: registry.yaml', 'registry: registry.example.yaml'), 'utf8')
      const r = runTrace(dir)
      assert.equal(r.status, 2, r.all)
      assert.match(r.all, /示例|模板/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('事实损坏 ≠ 没跑起来（exit 2 而非 exit 1）', () => {
  it('守卫状态文件损坏 → exit 2，不得判成「冻结」', () => {
    const dir = freshTmp()
    try {
      writeFileSync(path.join(dir, 'work', 'guard-state.json'), '{ 这不是 JSON', 'utf8')
      const r = runTrace(dir)
      assert.equal(r.status, 2, r.all)
      assert.match(r.all, /损坏|非法/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registry 结构非法 → exit 2', () => {
    const dir = freshTmp()
    try {
      writeFileSync(path.join(dir, 'registry.yaml'), 'guards: 不是数组\n', 'utf8')
      const r = runTrace(dir)
      assert.equal(r.status, 2, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('数据源整个不存在 → exit 1（还没有数据 = 判冻结，不是读不到）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trace-empty-'))
    try {
      // 配置在、数据目录不在 —— 这才是「还没接入」的真实形态。
      copyFileSync(path.join(FIXTURE_DIR, CONFIG), path.join(dir, CONFIG))
      const r = runTrace(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /触发冻结/, r.all)
      assert.match(r.all, /尚不存在/, '须明说数据源为空而不是损坏')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('配置文件本身缺失 → exit 2（连事实面都定位不到，无从判定）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'trace-noconfig-'))
    try {
      const r = runTrace(dir)
      assert.equal(r.status, 2, r.all)
      assert.match(r.all, /配置链失败/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用法错误 → exit 2', () => {
    const dir = freshTmp()
    try {
      assert.equal(runTrace(dir, ['--id', '不是条目ID']).status, 2)
      assert.equal(runTrace(dir, ['--unknown']).status, 2)
      assert.equal(runTrace(dir, ['--id']).status, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('引用可核查性（报告的立身之本）', () => {
  it('引用的行号必须真实指向那一行内容（防「有引用但引错行」）', () => {
    const dir = freshTmp()
    try {
      const r = traceJson(dir)
      const chain = r.json.traces.find((t) => t.id === CHAIN_ID)
      const abs = (rel) => {
        const candidates = [
          path.join(dir, 'entries', rel),
          path.join(dir, rel),
          path.join(dir, 'work', rel),
          path.join(dir, 'work', 'audit', rel),
          path.join(dir, rel),
        ]
        return candidates.find((c) => existsSync(c)) ?? null
      }
      let checked = 0
      for (const b of chain.beats) {
        for (const e of b.evidence) {
          if (e.line === null) continue
          const file = abs(e.file)
          assert.ok(file, `引用文件必须存在: ${e.file}`)
          const line = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')[e.line - 1]
          assert.ok(typeof line === 'string', `${e.at} 的行号越界`)
          // 行级引用的最低要求：引到的那一行不是空行（空行 = 没真指到东西）。
          assert.notEqual(line.trim(), '', `${e.at} 指向空行，引用无效`)
          checked++
        }
      }
      assert.ok(checked >= 6, `带行号的引用至少 6 条，实际 ${checked}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--json 输出是完整结构化报告（供人、CI、门禁复用）', () => {
    const dir = freshTmp()
    try {
      const r = traceJson(dir)
      for (const key of ['sources', 'counts', 'excluded', 'traces', 'verdict']) {
        assert.ok(key in r.json, `JSON 报告缺字段 ${key}`)
      }
      assert.equal(Object.keys(r.json.sources).length, 5, '数据源必须恰好五处（少一处 = 报告不可信）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
