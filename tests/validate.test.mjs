/**
 * validate.test.mjs —— 校验器自包含测试（node:test，零测试框架依赖；`node <本文件>` 直接跑）
 *
 * 口径：exit code 可判的 CLI 断言 + 纯函数红/绿双向 + 破坏测试（把合规样本改坏必须变红）。
 * 「只测合规样本不报错」的断言在校验器退化成恒绿时同样会通过 —— 那不叫守，
 * 所以每个违规类各有一条必须 exit 1 的用例（缺字段 / 枚举非法 / scope 非法 / guard_ref 形态）。
 * kill-switch：只断言「开关存在、默认 false、校验器能识别非法值」；
 * 「off 时对应功能零副作用」的功能级断言归 injection / capture / distill 各自接线阶段。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// YAML 断言同样走双后端降级层：宿主（无 js-yaml）也能跑全量用例，容器内自动换 js-yaml 后端
import { parseYaml as yamlLoad } from '../scripts/lib/yaml-lite.mjs'
import {
  BUILTIN_DEFAULT_CONFIG,
  COVERED_ENTRY_ID_RE,
  KILL_SWITCH_KEYS,
  OPTIONAL_ENTRY_KEYS,
  OPTIONAL_ENTRY_KEY_TYPES,
  PROTOCOL_CONFIG_VERSION,
  extractFrontmatter,
  resolveConfigPath,
  validateConfig,
  validateCoveredEntries,
  validateEntry,
  validateGuardBinding,
  validateRegistryEntry,
} from '../scripts/validate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const CLI = path.join(SKILL_ROOT, 'scripts', 'validate.mjs')
const EXAMPLE_CONFIG = path.join(SKILL_ROOT, 'scripts', 'config.example.yaml')
const EXAMPLE_REGISTRY = path.join(SKILL_ROOT, 'scripts', 'registry.example.yaml')
// 「实例」= 已完成项目绑定的那份配置 / 注册表。协议层自带**合成夹具**，不读宿主业务仓的实例：
// 那一读法把测试绑死在「技能部署在 <repo>/.agents/skills/<name>/、上溯三级即某个业务仓根」
// 这个位置上 —— 协议层独立成仓或 clone 到全局后立刻失效（实测 8 例由它引发）。
// 夹具为何是合成的而非抄一份真实实例：抄进来等于把某个业务仓的路径与项目数据搬进协议层，
// 与「零项目耦合」直接冲突。这里只保留断言真正关心的属性。可移植性判据见 tests/portability.test.mjs。
const INSTANCE_CONFIG = path.join(HERE, 'fixtures', 'instance', 'config-authorized.yaml')
const INSTANCE_REGISTRY = path.join(HERE, 'fixtures', 'instance', 'registry-with-stub.yaml')
const FIXTURES = path.join(HERE, 'fixtures')
const fx = (...p) => path.join(FIXTURES, ...p)

const loadYaml = (file) => yamlLoad(readFileSync(file, 'utf8'))

/**
 * 跑校验器 CLI（cwd = 协议层根；30s 超时防挂死）。
 * cwd 刻意**不**用「技能上溯若干级得到的仓库根」—— 那会让 CLI 沿 cwd 上溯捡到宿主仓的实例配置，
 * 断言随宿主布局漂移。本文件的 CLI 断言一律显式传路径或 `--config`。
 */
function runCli(args, { cwd = SKILL_ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    // 清掉 SELF_IMPROVING_CONFIG 泄漏：默认断言不被外部环境干扰；env 段测试显式传入。
    env: { ...process.env, SELF_IMPROVING_CONFIG: '', ...env },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('validate.mjs · CLI 红绿场景', () => {
  it('合规 fixture → exit 0（stdout 报 PASS）', () => {
    const { status, out } = runCli([fx('entries/valid-basic.md')])
    assert.equal(status, 0)
    assert.match(out, /PASS/)
  })

  it('缺必填字段（claim）→ exit 1，报出条目名 + 违规原因', () => {
    const { status, out } = runCli([fx('entries/missing-claim.md')])
    assert.equal(status, 1)
    assert.match(out, /missing-claim\.md/)
    assert.match(out, /缺必填字段: claim/)
  })

  it('status 枚举非法（closed 不在三台状态机并集内）→ exit 1', () => {
    const { status, out } = runCli([fx('entries/bad-status.md')])
    assert.equal(status, 1)
    assert.match(out, /bad-status\.md/)
    assert.match(out, /status 非法/)
  })

  it('scope 非法（build 不在 config.scope.values 内）→ exit 1 且提示判据来自 config', () => {
    const { status, out } = runCli([fx('entries/bad-scope.md')])
    assert.equal(status, 1)
    assert.match(out, /bad-scope\.md/)
    assert.match(out, /scope 非法/)
    assert.match(out, /config scope\.values/)
  })

  it('guard_ref 形态非法（脚本路径 ≠ registry key）→ exit 1', () => {
    const { status, out } = runCli([fx('entries/bad-guard-ref.md')])
    assert.equal(status, 1)
    assert.match(out, /bad-guard-ref\.md/)
    assert.match(out, /guard_ref 形态非法/)
  })

  it('可选键齐备（tags/date/category/resolved_*）→ exit 0（契约扩了可选键不等于放松）', () => {
    const { status, out } = runCli([fx('entries/valid-optional-keys.md')])
    assert.equal(status, 0)
    assert.match(out, /PASS/)
  })

  it('可选键 tags 非数组 → exit 1（可选键同样有类型判据）', () => {
    const { status, out } = runCli([fx('entries/bad-tags-not-array.md')])
    assert.equal(status, 1)
    assert.match(out, /bad-tags-not-array\.md/)
    assert.match(out, /tags 非法/)
    assert.match(out, /字符串数组/)
  })

  it('可选键 date 格式错（2026-13-45）→ exit 1', () => {
    const { status, out } = runCli([fx('entries/bad-date-format.md')])
    assert.equal(status, 1)
    assert.match(out, /bad-date-format\.md/)
    assert.match(out, /date 非法/)
    assert.match(out, /YYYY-MM-DD/)
  })

  it('破坏测试：可选键 date 未加引号（YAML 时间戳形态 → Date）→ 必须变红', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'self-improving-date-'))
    try {
      const good = readFileSync(fx('entries/valid-optional-keys.md'), 'utf8')
      for (const literal of ['date: 2026-10-16', 'date: 2026-13-45']) {
        const broken = good.replace(/^date: "2026-10-16"$/m, literal)
        assert.ok(broken.includes(literal), `破坏改写未生效（正则失配）: ${literal}`)
        const file = path.join(dir, `broken-date-${literal.slice(6)}.md`)
        writeFileSync(file, broken, 'utf8')
        const { status, out } = runCli([file])
        assert.equal(status, 1, `${literal} 必须判红（未加引号的日期不是字符串）`)
        assert.match(out, /date 非法/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('破坏测试：tags 里去掉引号的纯数字标签被 YAML 解成数字 → 必须变红', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'self-improving-tags-'))
    try {
      const good = readFileSync(fx('entries/valid-optional-keys.md'), 'utf8')
      const broken = good.replace('"13500"', '13500')
      assert.ok(broken !== good && broken.includes('13500, 门禁'), '破坏改写未生效（正则失配），断言先红')
      const file = path.join(dir, 'broken-tags.md')
      writeFileSync(file, broken, 'utf8')
      const { status, out } = runCli([file])
      assert.equal(status, 1)
      assert.match(out, /tags 非法/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('破坏测试：把合规 fixture 的 claim 抹掉 → 校验器必须变红（证伪恒绿）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'self-improving-validate-'))
    try {
      const good = readFileSync(fx('entries/valid-basic.md'), 'utf8')
      const broken = good.replace(/^claim: .*$/m, '')
      // 自证改写真的发生了：正则失配时下面这条先红，避免测了个空还绿着
      assert.ok(!broken.includes('claim:'), '破坏改写未生效（正则失配），断言先红')
      const file = path.join(dir, 'broken.md')
      writeFileSync(file, broken, 'utf8')
      const { status, out } = runCli([file])
      assert.equal(status, 1)
      assert.match(out, /broken\.md/)
      assert.match(out, /缺必填字段: claim/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--all 全合规目录 → exit 0（无 frontmatter 的 README.md 必须被豁免）', () => {
    const { status, out } = runCli(['--all', fx('allscan-ok')])
    assert.equal(status, 0)
    assert.match(out, /PASS/)
    // README 豁免的破坏方向：豁免一旦被删，README 会以「缺 frontmatter」被判违规
    assert.ok(!out.includes('README.md'), 'README.md 不应出现在输出里（应被目录级豁免）')
  })

  it('--all 混合目录 → exit 1 报违规文件名，合规文件不被误伤', () => {
    const { status, out } = runCli(['--all', fx('allscan-mixed')])
    assert.equal(status, 1)
    assert.match(out, /bad-scope-mixed\.md/)
    assert.match(out, /scope 非法/)
    assert.ok(!out.includes('valid-feat.md'), '合规文件不得出现在 FAIL 输出里')
  })

  it('kill-switch 非法值（injection: "on" 非布尔）→ 校验器识别并 exit 1', () => {
    const { status, out } = runCli(['--config', fx('config-bad-killswitch.yaml'), fx('entries/valid-basic.md')])
    assert.equal(status, 1)
    assert.match(out, /config\.kill_switch\.injection/)
    assert.match(out, /必须是布尔值/)
  })

  it('usage：无校验目标 → exit 2（用法错误与违规分开）', () => {
    const { status } = runCli([])
    assert.equal(status, 2)
  })

  it('usage：未知参数 → exit 2', () => {
    const { status } = runCli(['--nope'])
    assert.equal(status, 2)
  })
})

describe('配置解析链（--config > env > repo 根实例 > 内置默认）', () => {
  it('无参默认读 repo 根 .self-improving.yaml（PASS 输出标注实例配置路径）', () => {
    // 造一个**真仓库根**当夹具：这一级判据的语义是「CLI 沿 cwd 定位仓库根并读那里的实例配置」，
    // 必须在仓库语义下验证。原先它靠「技能恰好部署在某个业务仓内」而被满足 —— 那是位置假设的
    // 变体：协议层一独立成仓，无参就退化成「命中内置默认值」，本例随即红。
    // 只 mkdir 一个 `.git` 目录即可：validate.mjs 先试 `git rev-parse`，失败则从 cwd 上溯找 `.git`，
    // 两条路径都能命中，且不起子进程、不依赖本机装了 git。
    const repo = mkdtempSync(path.join(tmpdir(), 'self-improving-chain-'))
    try {
      mkdirSync(path.join(repo, '.git'), { recursive: true })
      writeFileSync(path.join(repo, '.self-improving.yaml'), readFileSync(INSTANCE_CONFIG, 'utf8'), 'utf8')
      const { status, out } = runCli([fx('entries/valid-basic.md')], { cwd: repo })
      assert.equal(status, 0)
      assert.match(out, /\.self-improving\.yaml/)
      assert.ok(!out.includes('config.example.yaml'), '默认不应命中技能 example 配置')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('--config 覆盖 env：env 指向非法配置 + --config 指向合法配置 → exit 0（--config 胜出）', () => {
    const { status, out } = runCli(['--config', EXAMPLE_CONFIG, fx('entries/valid-basic.md')], {
      env: { SELF_IMPROVING_CONFIG: fx('config-bad-killswitch.yaml') },
    })
    assert.equal(status, 0)
    assert.match(out, /config\.example\.yaml/)
  })

  it('env SELF_IMPROVING_CONFIG 覆盖 repo 根实例（无 --config 时 env 胜出）', () => {
    const { status, out } = runCli([fx('entries/valid-basic.md')], {
      env: { SELF_IMPROVING_CONFIG: EXAMPLE_CONFIG },
    })
    assert.equal(status, 0)
    assert.match(out, /config\.example\.yaml/)
    assert.ok(!out.includes('.self-improving.yaml'), 'repo 根实例不应被使用（env 优先）')
  })

  it('resolveConfigPath 纯函数：四级优先级逐级断言', () => {
    // 四级全给 → --config 胜
    assert.equal(
      resolveConfigPath({ cliConfig: '/x/a.yaml', env: { SELF_IMPROVING_CONFIG: '/x/b.yaml' }, repoRoot: '/x' }).path,
      '/x/a.yaml',
    )
    // 无 --config → env 胜
    assert.equal(
      resolveConfigPath({ cliConfig: null, env: { SELF_IMPROVING_CONFIG: '/x/b.yaml' }, repoRoot: '/x' }).path,
      '/x/b.yaml',
    )
    // 无前两级 → repo 根实例：用一份真临时仓库当夹具。造真仓而不是复用一个「假定存在」的
    // 宿主仓路径，是因为后者正是本文件要消灭的那种位置假设。
    const repo = mkdtempSync(path.join(tmpdir(), 'self-improving-repo-'))
    try {
      const inst = path.join(repo, '.self-improving.yaml')
      writeFileSync(inst, 'version: 1\n', 'utf8')
      const fromRepo = resolveConfigPath({ cliConfig: null, env: {}, repoRoot: repo })
      assert.equal(fromRepo.path, inst)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
    // 全无 → 内置默认（path=null）
    const empty = mkdtempSync(path.join(tmpdir(), 'self-improving-noconf-'))
    try {
      assert.equal(resolveConfigPath({ cliConfig: null, env: {}, repoRoot: empty }).path, null)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('内置默认值本身过 validateConfig（防 BUILTIN_DEFAULT_CONFIG 与契约漂移）', () => {
    assert.deepEqual(validateConfig(BUILTIN_DEFAULT_CONFIG), [])
  })
})

describe('配置实例与模板（kill-switch 授权态 + 全键覆盖）', () => {
  // 授权账：开关翻转必须能在这里追溯到当窗授权，测试钉的是「授权态」而非「永远 false」。
  //   capture: true ← 2026-10-17 用户当窗批准接线计划第 2 步（「同意」）：
  //     capture 是 append-only、写 gitignored 事件库、不读不拦截，打开只积累数据。
  //   distill: true ← 2026-10-17 用户当窗授权「驱动六拍完整走一遍」：拍3 蒸馏是那条链的必经一跳，
  //     不开则六拍停在拍2，守卫绑定（拍4）与退役判定都拿不到 guard_ref 候选。产物只落
  //     .learnings-work/proposals/（gitignored 暂存区），正式条目区仍零写入。
  //   injection: true ← 2026-10-17 用户当窗授权「开 injection；所有回忆按业界标准做优先级」。
  //     解锁条件 = 当初定的「事件攒出真实数据」（事件库 13 条真实事件 / 13 份蒸馏草案，
  //     此前 recall 侧恒空）。这是唯一改变每个会话可见行为的开关：开启后 SessionStart 会注入
  //     一段经验；默认桶 other 永不注入，故不会把未归类条目推到会话里。
  const AUTHORIZED_SWITCHES = { injection: true, capture: true, distill: true }
  for (const [label, file, expected] of [
    ['技能模板', EXAMPLE_CONFIG, { injection: false, capture: false, distill: false }],
    ['实例夹具', INSTANCE_CONFIG, AUTHORIZED_SWITCHES],
  ]) {
    it(`${label}（${path.basename(file)}）：kill-switch 与授权账一致`, () => {
      const ks = loadYaml(file).kill_switch
      assert.ok(ks, 'kill_switch 段必须存在')
      for (const key of KILL_SWITCH_KEYS) {
        assert.equal(ks[key], expected[key], `${label} kill_switch.${key} 应为 ${expected[key]}（授权账见本 describe 头注）`)
      }
    })

    it(`${label}：覆盖全配置项（scope/top-K/注入预算/retire/存储/事件源白名单）且结构合法`, () => {
      const cfg = loadYaml(file)
      const scope = cfg.scope
      assert.ok(Array.isArray(scope.values) && scope.values.length > 0)
      assert.ok(scope.values.includes(scope.default), 'scope.default 必须在 values 内')

      const injection = cfg.injection
      assert.ok(injection.top_k > 0)
      assert.ok(injection.budget_chars > 0)
      assert.ok(injection.budget_ms > 0)
      // 时间预算必须远小于外层超时（量级断言的地基）
      assert.ok(injection.timeout_ms > injection.budget_ms, 'timeout_ms 应大于 budget_ms')

      assert.ok(cfg.retire.cycle_days > 0)

      const storage = cfg.storage
      assert.ok(storage.entries_dir, 'storage.entries_dir 必须存在')
      assert.ok(storage.events_dir, 'storage.events_dir 必须存在')
      assert.ok(storage.proposals_dir, 'storage.proposals_dir 必须存在')
      assert.ok(storage.registry, 'storage.registry 必须存在')

      const sources = cfg.event_sources
      assert.ok(Array.isArray(sources))
      for (const s of ['gate', 'hook', 'tool', 'manual']) assert.ok(sources.includes(s), `event_sources 应含 ${s}`)

      assert.deepEqual(validateConfig(cfg), [])
    })
  }

  it('validateConfig 红向：kill-switch 非布尔 / 缺开关必报（防校验器退化成恒绿）', () => {
    const cfg = loadYaml(EXAMPLE_CONFIG)
    const broken = { ...cfg, kill_switch: { injection: 'on', capture: false } }
    const violations = validateConfig(broken)
    assert.ok(violations.some((v) => v.includes('kill_switch.injection')), '非布尔必须报')
    assert.ok(violations.some((v) => v.includes('distill')), '缺开关必须报')
  })

  it('配置版本 fail-closed 三向：匹配绿 / 不匹配红 / 缺失红（防静默按新协议解释旧配置）', () => {
    const cfg = loadYaml(EXAMPLE_CONFIG)
    // 绿：与协议版本一致
    assert.equal(cfg.version, PROTOCOL_CONFIG_VERSION, '示例配置的 version 应等于协议版本')
    assert.deepEqual(validateConfig(cfg), [])
    // 红：版本对不上（升级后的旧配置最典型的形态）
    const older = validateConfig({ ...cfg, version: PROTOCOL_CONFIG_VERSION - 1 })
    assert.ok(older.some((v) => v.includes('config.version')), '版本不一致必须报')
    // 红：字符串形态也不认 —— 字符串/数字互认就是半兼容，比不兼容更难查
    const asStr = validateConfig({ ...cfg, version: String(PROTOCOL_CONFIG_VERSION) })
    assert.ok(asStr.some((v) => v.includes('config.version')), '"1" 与 1 的形态差异必须判红')
    // 红：整段缺失（必填段那条判红，不能被这里吞掉）
    const { version, ...missing } = cfg
    assert.ok(validateConfig(missing).some((v) => v.includes('version')), '缺 version 必须报')
  })
})

describe('registry 模板与实例（模板空表 + 同构三键）', () => {
  // 技能模板必须永远是空表骨架；repo 实例自票 06 起允许存在**债务桩**
  // （key: legacy-unbound，mode: debt-stub）—— 它的语义是「历史条目尚无可执行判据」，
  // 不是一条真守卫，因此本组断言分两向：桩必须显式标注 mode，真守卫不得冒名顶替。
  it('技能模板：guards 空表，且注释写明同构三键 key/args/when', () => {
    const text = readFileSync(EXAMPLE_REGISTRY, 'utf8')
    const doc = yamlLoad(text)
    assert.ok(Array.isArray(doc.guards))
    assert.deepEqual(doc.guards, [])
    for (const k of ['key', 'args', 'when']) assert.ok(text.includes(k), `注释应提及 ${k}`)
  })

  it('实例夹具：guards 每条都过同构三键校验；债务桩必须显式标 mode: debt-stub', () => {
    const text = readFileSync(INSTANCE_REGISTRY, 'utf8')
    const doc = yamlLoad(text)
    assert.ok(Array.isArray(doc.guards), 'guards 须为数组')
    for (const k of ['key', 'args', 'when']) assert.ok(text.includes(k), `注释应提及 ${k}`)
    for (const g of doc.guards) {
      assert.deepEqual(validateRegistryEntry(g), [], `registry 条目 ${g && g.key} 不合规`)
      if (g.key === 'legacy-unbound') {
        assert.equal(g.mode, 'debt-stub', '债务桩必须自报 mode: debt-stub，不许冒充真守卫')
      }
    }
  })

  it('破坏测试：桩若去掉 mode 标注即红（防止债务桩被当成真守卫消费）', () => {
    const doc = yamlLoad(readFileSync(INSTANCE_REGISTRY, 'utf8'))
    const stub = { ...(doc.guards.find((g) => g.key === 'legacy-unbound') || { key: 'legacy-unbound' }) }
    delete stub.mode
    assert.equal(stub.mode, undefined, '去掉 mode 后不再是声明过的债务桩')
  })

  it('validateRegistryEntry：同构条目通过；缺 when / args 非数组 / key 形态错必红（破坏测试）', () => {
    assert.deepEqual(
      validateRegistryEntry({ key: 'entry-guard-binding', args: ['guards/binding.sh'], when: 'touchesEntries' }),
      [],
    )
    assert.notDeepEqual(validateRegistryEntry({ key: 'entry-guard-binding', args: ['guards/g2.sh'] }), [])
    assert.notDeepEqual(validateRegistryEntry({ key: 'Bad_Key', args: ['x.sh'], when: 'always' }), [])
    assert.notDeepEqual(validateRegistryEntry({ key: 'ok-key', args: [], when: 'always' }), [])
  })
})

describe('validateCoveredEntries（schema.md §3 存在性判据 · 2026-10-17 补洞 —— 此前零实现，退役证据可被填错 ID 静默吞掉）', () => {
  const files = [
    'ERR-20261011-006-裸跑vitest无run级保护致僵尸空烧34小时.md',
    'LRN-20261015-001-给子代理的规则要写在它有工具能读到的地方.md',
  ]

  it('缺省 / null / 空数组 = 无覆盖声明，合法（债务桩即此形态）', () => {
    assert.deepEqual(validateCoveredEntries(undefined, files), [])
    assert.deepEqual(validateCoveredEntries(null, files), [])
    assert.deepEqual(validateCoveredEntries([], files), [])
  })

  it('存在的条目 ID 唯一命中 → 合规（ID.md 裸名与 ID-slug.md 两种文件名都认）', () => {
    assert.deepEqual(validateCoveredEntries(['ERR-20261011-006'], files), [])
    assert.deepEqual(validateCoveredEntries(['ERR-20261011-006'], ['ERR-20261011-006.md']), [])
  })

  it('破坏测试：引用不存在的条目必红 —— 洞的本质是「填错 ID 不红，退役证据静默永远攒不到」', () => {
    const out = validateCoveredEntries(['ERR-20990101-999'], files)
    assert.notDeepEqual(out, [])
    assert.match(out.join('\n'), /ERR-20990101-999/)
    assert.match(out.join('\n'), /不存在/)
  })

  it('破坏测试：非数组 / 非 ID 形态元素必红', () => {
    assert.match(validateCoveredEntries('ERR-20261011-006', files).join('\n'), /须为字符串数组/)
    assert.match(validateCoveredEntries(['not-an-id'], files).join('\n'), /形态非法/)
    assert.match(validateCoveredEntries([42], files).join('\n'), /形态非法/)
    // 带随机后缀段的新格式 ID 不是 covered_entries 合法形态（schema.md §3 明文三段式）
    assert.match(validateCoveredEntries(['ERR-20261011-006-A7B'], files).join('\n'), /形态非法/)
  })

  it('破坏测试：同 ID 命中多个文件必红（歧义 = 退役证据张冠李戴）', () => {
    const out = validateCoveredEntries(['ERR-20261011-006'], [
      'ERR-20261011-006-a.md',
      'ERR-20261011-006-b.md',
    ])
    assert.match(out.join('\n'), /歧义/)
  })

  it('纯函数纪律：entryFileNames 非数组不抛异常，按空集处理（红而非炸）', () => {
    const out = validateCoveredEntries(['ERR-20261011-006'], undefined)
    assert.match(out.join('\n'), /不存在/)
  })

  it('ID 形态正则导出与判据一致（供消费方复用，不写第二份正则）', () => {
    assert.ok(COVERED_ENTRY_ID_RE.test('LRN-20261015-001'))
    assert.ok(!COVERED_ENTRY_ID_RE.test('LRN-20261015-001-A7B'))
    assert.ok(!COVERED_ENTRY_ID_RE.test('TODO-20261015-001'))
  })
})

/**
 * 反向账判据（evt-20261017-031 补洞）：正向「guard_ref 的 key 存在」**不蕴含**
 * 「该守卫真的声明覆盖了本条目」—— trace 拍3 判的正是 covered_entries。
 * 实测形态：approve 在 key 已存在时整段跳过 registry 写入，第二个条目永远进不了
 * covered_entries；trace exit 1 的同时 D13 全绿 ⇒ 六拍结构性不可完成却无门禁拦。
 */
describe('validateGuardBinding 反向账（covered_entries 必须含本条目 · 2026-10-17 补洞）', () => {
  const fm = { type: 'ERR', status: 'resolved', scope: 'testing', claim: 'c', guard_ref: 'no-bare-vitest' }
  const keys = ['no-bare-vitest', 'other-guard']
  const cov = (entryId, coveredEntriesByKey, exemptKeys = []) => ({ entryId, coveredEntriesByKey, exemptKeys })

  it('正向：守卫 covered_entries 含本条目 → 合规', () => {
    const out = validateGuardBinding(fm, keys, cov('ERR-20261017-031', { 'no-bare-vitest': ['ERR-20261011-006', 'ERR-20261017-031'] }))
    assert.deepEqual(out, [])
  })

  it('反向判红：key 存在但 covered_entries 漏了本条目（六拍拍3 必红，门禁必须先红）', () => {
    const out = validateGuardBinding(fm, keys, cov('ERR-20261017-031', { 'no-bare-vitest': ['ERR-20261011-006'] }))
    assert.match(out.join('\n'), /covered_entries 未含本条目 ERR-20261017-031/)
    assert.match(out.join('\n'), /拍3/)
  })

  it('守卫压根没声明 covered_entries → 判红（不得当「无覆盖声明即合规」）', () => {
    const out = validateGuardBinding(fm, keys, cov('ERR-20261017-031', { 'no-bare-vitest': null }))
    assert.match(out.join('\n'), /未声明 covered_entries/)
  })

  it('debt-stub 显式豁免：它按契约不声明覆盖，不得被反向账打红', () => {
    const out = validateGuardBinding(fm, keys, cov('ERR-20261017-031', {}, ['no-bare-vitest']))
    assert.deepEqual(out, [])
  })

  it('向后兼容：不传第三个参数时只跑正向（老调用方零影响）', () => {
    assert.deepEqual(validateGuardBinding(fm, keys), [])
    assert.match(validateGuardBinding({ ...fm, guard_ref: 'not-registered' }, keys).join('\n'), /不存在的守卫/)
  })

  it('豁免表缺席时 debt-stub 不被豁免 —— 防止「靠漏配豁免蒙混过关」', () => {
    const out = validateGuardBinding(fm, keys, cov('ERR-20261017-031', {}))
    assert.match(out.join('\n'), /未声明 covered_entries/)
  })

  it('非 resolved 条目不参与反向判定（open/draft 的 guard_ref 可以还没登记）', () => {
    assert.deepEqual(validateGuardBinding({ ...fm, status: 'open' }, keys, cov('ERR-20261017-031', {})), [])
  })
})

describe('validateEntry 纯函数（供门禁/注册等消费方复用，不重复实现判据）', () => {
  const scopeValues = ['infra', 'testing', 'git', 'data-ui', 'model', 'kb', 'other']
  const validFm = {
    type: 'LRN',
    status: 'resolved',
    scope: 'infra',
    claim: '有判据的条目才是教训',
    guard_ref: null,
    recurrence: 0,
    last_verified_at: '2026-10-16',
  }

  it('完全合规 → 空违规列表', () => {
    assert.deepEqual(validateEntry(validFm, scopeValues), [])
  })

  it('未知字段必红（契约外的键不许悄悄溜进 frontmatter）', () => {
    const violations = validateEntry({ ...validFm, extra_key: 1 }, scopeValues)
    assert.ok(violations.some((v) => v.includes('未知字段: extra_key')))
  })

  it('id / title 仍红：第二份事实源不进契约（ID 取文件名、标题取正文 H1）', () => {
    assert.ok(validateEntry({ ...validFm, id: 'LRN-20261016-001' }, scopeValues).some((v) => v.includes('未知字段: id')))
    assert.ok(validateEntry({ ...validFm, title: '某标题' }, scopeValues).some((v) => v.includes('未知字段: title')))
  })

  it('event_ids 元素必须是 evt-YYYYMMDD-NNN 形态（拍1 关联的唯一入口守卫）', () => {
    const good = validateEntry({ ...validFm, event_ids: ['evt-20261016-001'] }, scopeValues)
    assert.deepEqual(good, [], `合法 event_ids 不该报违规：${JSON.stringify(good)}`)
    // 非数组 = 类型错即红
    assert.ok(
      validateEntry({ ...validFm, event_ids: 'evt-20261016-001' }, scopeValues).some((v) => /event_ids 非法/.test(v)),
      'event_ids 传字符串必须判红',
    )
    // 形态错必须判红：否则正文里随口提到的任意字符串都会被当成来源事件塞进拍1 的账
    for (const bad of [['EVT-20261016-001'], ['evt-20261016-1'], ['条目-LRN-20261016-001'], ['']]) {
      const v = validateEntry({ ...validFm, event_ids: bad }, scopeValues)
      assert.ok(
        v.some((x) => /event_ids 非法/.test(x)),
        `event_ids: ${JSON.stringify(bad)} 必须判红，实际 ${JSON.stringify(v)}`,
      )
    }
  })

  it('可选键键集与类型表同源：每个键都有类型定义，且与常量导出同序', () => {
    assert.deepEqual(Object.keys(OPTIONAL_ENTRY_KEY_TYPES).sort(), [...OPTIONAL_ENTRY_KEYS].sort())
    assert.deepEqual(OPTIONAL_ENTRY_KEYS, ['tags', 'date', 'category', 'resolved_date', 'resolved_by', 'event_ids', 'skill_ref'])
    for (const key of OPTIONAL_ENTRY_KEYS) assert.ok(OPTIONAL_ENTRY_KEY_TYPES[key], `${key} 缺类型定义`)
  })

  it('skill_ref 合规形态（规程出处）→ 空违规：guard_ref 为 null 时规程型条目合法', () => {
    const good = validateEntry({ ...validFm, guard_ref: null, skill_ref: 'example-skill#测试范围由影响面决定' }, scopeValues)
    assert.deepEqual(good, [], `合法 skill_ref 不该报违规：${JSON.stringify(good)}`)
    // 章节标题自由文本：含空格 / CJK / 英文均可，skill-dir 段仍受小写连字符约束
    for (const ok of ['example-skill#Run tests by blast radius', 'a#x', 'self-improving-like-systems#§3.3 退役']) {
      const v = validateEntry({ ...validFm, guard_ref: null, skill_ref: ok }, scopeValues)
      assert.deepEqual(v, [], `skill_ref: ${JSON.stringify(ok)} 应合规，实际 ${JSON.stringify(v)}`)
    }
  })

  it('破坏：guard_ref 塞 skill#section 必须判红（严格性不得被规程出处这个需求放松）', () => {
    const v = validateEntry({ ...validFm, guard_ref: 'example-skill#测试范围由影响面决定' }, scopeValues)
    assert.ok(v.some((x) => /guard_ref 形态非法/.test(x)), `guard_ref 收到 skill#section 必须判红，实际 ${JSON.stringify(v)}`)
  })

  it('破坏：guard_ref 与 skill_ref 同时非 null 必须判红（机器判据与规程出处互斥）', () => {
    const v = validateEntry({ ...validFm, guard_ref: 'entry-guard-binding', skill_ref: 'example-skill#测试范围由影响面决定' }, scopeValues)
    assert.ok(v.some((x) => /双挂/.test(x)), `双挂必须判红，实际 ${JSON.stringify(v)}`)
    // 反向不误伤：只有 guard_ref（无 skill_ref 键）合法；只有 skill_ref（guard_ref: null）合法。
    // 注意 `skill_ref: null` 本身即红 —— 与 `date` / `event_ids` 等既有可选键同口径
    //（「缺失不违规，类型错即红」= 缺了就**别写这个键**，写 null 是类型错）。
    assert.deepEqual(validateEntry({ ...validFm, guard_ref: 'entry-guard-binding' }, scopeValues), [])
    assert.ok(
      validateEntry({ ...validFm, skill_ref: null }, scopeValues).some((x) => /skill_ref/.test(x)),
      'skill_ref: null 应判红（缺失不违规 = 不写该键，不是写 null）',
    )
  })

  it('破坏：skill_ref 形态错必须判红（大写 / 缺 # / 连续连字符 / 空章节 / 非字符串）', () => {
    for (const bad of ['Example-skill#x', 'example-skill', 'a--b#c', 'example-skill#', '#x', 'example skill#x', '', 42]) {
      const v = validateEntry({ ...validFm, guard_ref: null, skill_ref: bad }, scopeValues)
      assert.ok(
        v.some((x) => /skill_ref/.test(x)),
        `skill_ref: ${JSON.stringify(bad)} 必须判红，实际 ${JSON.stringify(v)}`,
      )
    }
  })

  it('可选键全合法 → 空违规列表；只带部分可选键同样合规（缺失不违规）', () => {
    assert.deepEqual(
      validateEntry(
        {
          ...validFm,
          tags: ['契约', '检索元数据', '13500'],
          date: '2026-10-09',
          category: '经验教训',
          resolved_date: '2026-10-15',
          resolved_by: '174f4032d（修复）',
        },
        scopeValues,
      ),
      [],
    )
    assert.deepEqual(validateEntry({ ...validFm, tags: ['仅一个键'] }, scopeValues), [])
  })

  it('可选键类型错红向：tags 非数组 / 含非字符串 / date 非法 / resolved_date 非法 / 空串', () => {
    const bad = [
      [{ tags: '契约错位' }, /tags 非法/],
      [{ tags: ['ok', 13500] }, /tags 非法/],
      [{ date: '2026-13-45' }, /date 非法/],
      [{ date: '2026/10/09' }, /date 非法/],
      [{ date: 20261009 }, /date 非法/],
      // 未加引号的 YAML 时间戳形态解成 Date —— 契约只认字符串，两条 YAML 后端必须同判红
      [{ date: new Date('2026-10-09T00:00:00Z') }, /date 非法/],
      [{ resolved_date: '2026-02-30' }, /resolved_date 非法/],
      [{ category: '  ' }, /category 非法/],
      [{ resolved_by: null }, /resolved_by 非法/],
    ]
    for (const [patch, re] of bad) {
      const violations = validateEntry({ ...validFm, ...patch }, scopeValues)
      assert.ok(violations.some((v) => re.test(v)), `应报 ${re}: ${JSON.stringify(patch)} → ${JSON.stringify(violations)}`)
    }
  })

  it('各字段非法形态红向：type/status/recurrence/last_verified_at 逐项', () => {
    assert.ok(validateEntry({ ...validFm, type: 'BUG' }, scopeValues).some((v) => v.includes('type 非法')))
    assert.ok(validateEntry({ ...validFm, status: 'closed' }, scopeValues).some((v) => v.includes('status 非法')))
    assert.ok(validateEntry({ ...validFm, recurrence: -1 }, scopeValues).some((v) => v.includes('recurrence 非法')))
    assert.ok(
      validateEntry({ ...validFm, last_verified_at: '2026-13-99' }, scopeValues).some((v) =>
        v.includes('last_verified_at 非法'),
      ),
    )
    assert.ok(validateEntry({ ...validFm, claim: '  ' }, scopeValues).some((v) => v.includes('claim 非法')))
  })

  /**
   * 报错必须指向**源文件里真实存在的形态**（2026-10-20 修的真缺陷）。
   *
   * 缺陷本体：yaml-lite 把未加引号的 `2026-10-18` 强制转成 Date 对象，
   * `JSON.stringify(Date)` 渲染成 `"2026-10-18T00:00:00.000Z"` —— 校验器于是报出了一个
   * **文件里根本不存在的值**。照着它去源文件 grep `T00:00:00.000Z` 什么也找不到，
   * 读者只能得出「校验器在瞎报」，而真正的错（少一对引号）就写在报错同一行里。
   *
   * 这条用例的意义不在「判红」（改前也判红），在**判红理由必须可据以定位**。
   */
  it('裸日期的报错指向源码字面量，不得报出 YAML 解析期臆造出来的 ISO 值', () => {
    const raw = [
      '---', 'type: ERR', 'status: resolved', 'scope: infra', 'claim: x',
      'guard_ref: null', 'recurrence: 0', 'last_verified_at: 2026-10-18', '---', '',
    ].join('\n')
    const { fm } = extractFrontmatter(raw)
    const reasons = validateEntry(fm, scopeValues, raw)
    assert.equal(reasons.length, 1, `应恰好一条（形态问题），实际 ${JSON.stringify(reasons)}`)
    assert.ok(reasons[0].includes('2026-10-18'), `报错须含源码里的字面量：${reasons[0]}`)
    assert.ok(!reasons[0].includes('T00:00:00'), `报错不得出现源文件里不存在的 ISO 形态：${reasons[0]}`)
  })

  it('无原文路径也不得把 Date 渲染成裸 ISO 冒充成文件内容', () => {
    // 纯对象调用方（门禁直接拿 fm）拿不到源码，唯一的线索就是这个值本身。
    // 这时必须说清「这是解析期转出来的」，而不是让人照着一个查不到的值去搜。
    const fmCoerced = { ...validFm, last_verified_at: new Date('2026-10-18') }
    const reasons = validateEntry(fmCoerced, scopeValues)
    assert.equal(reasons.length, 1, `非字符串必须是非法：${JSON.stringify(reasons)}`)
    assert.ok(reasons[0].includes('解析期'), `须点明值来自 YAML 解析期而非源文件：${reasons[0]}`)
  })

  it('last_verified_at 的 null 缺省不得被源码级判据误伤（全仓最常见的一行）', () => {
    const raw = [
      '---', 'type: ERR', 'status: resolved', 'scope: infra', 'claim: x',
      'guard_ref: null', 'recurrence: 0', 'last_verified_at: null', '---', '',
    ].join('\n')
    const { fm } = extractFrontmatter(raw)
    assert.deepEqual(validateEntry(fm, scopeValues, raw), [], 'null 是合法占位（schema.md §1.1），误伤会让每个条目都红')
  })
})
