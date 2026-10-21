/**
 * init.test.mjs —— 接入脚手架的判据测试
 *
 * 这个命令的核心纪律是「**默认零写盘 + 只增不覆盖**」，两条都靠人自觉就会退化成
 * 「看着像幂等的覆盖」，所以这里把纪律钉成可执行断言：
 *   · 演练态断言目录**一个字节都没多**（不是「没覆盖」，是「没创建」）；
 *   · 已存在的文件断言**内容逐字节不变**（人改过的 scope / 路径不能被第二次跑吃掉）；
 *   · 目录分层与 kill_switch 断言落到**产物文本**上，不是落到「函数返回了什么」。
 *
 * 末尾的「破坏测试自检」把模板改坏，断言 init 报错而不是静默产出半成品配置 ——
 * 没有这一条，上面那些断言可能全是恒真。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyInit,
  EXCLUDE_SUGGESTION,
  main,
  NPM_SCRIPT_KEY,
  npmScriptSuggestion,
  planInit,
  renderConfig,
  renderConfigFromTemplate,
  renderRegistry,
  selfTestScript,
  TRACKED_ROOT,
  WORK_ROOT,
} from '../scripts/init.mjs'
import { validateConfig, KILL_SWITCH_KEYS } from '../scripts/validate.mjs'
import { listTestFiles, main as mainRunTests } from '../scripts/run-tests.mjs'
import { parseYaml } from '../scripts/lib/yaml-lite.mjs'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INIT = path.join(SKILL_ROOT, 'scripts', 'init.mjs')
const RUN_TESTS = path.join(SKILL_ROOT, 'scripts', 'run-tests.mjs')
const CONFIG_PATH = '.self-improving.yaml'
const REGISTRY_PATH = `${TRACKED_ROOT}/registry.yaml`
/** 项目侧薄壳（2026-10-21 起 init 一并落：没有它，宿主钩子就没有入口）。 */
const SHELL_PATH = 'scripts/self-improving.mjs'

/** 递归列出目录下所有文件（相对、正斜杠），用于「零写盘」与「不多生目录」断言。 */
function fileList(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** 起一个空项目目录。 */
function newProject() {
  return mkdtempSync(path.join(tmpdir(), 'si-init-'))
}

/** 原始配置模板（未经 init 渲染）—— 替换表的判据要对着它做。 */
function rawTemplate() {
  return readFileSync(path.join(SKILL_ROOT, 'scripts', 'config.example.yaml'), 'utf8')
}

/** 以子进程跑 CLI（退出码是 CLI 契约的一部分，必须真跑）。 */
function runCLI(args, cwd = SKILL_ROOT) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, [INIT, ...args], { cwd, encoding: 'utf8', env })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// ── 默认零写盘 ────────────────────────────────────────────────────────────────

test('演练态（无 --apply）一个字节都不写', () => {
  const dir = newProject()
  const before = fileList(dir)
  const r = runCLI(['--project-dir', dir])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(fileList(dir), before, '演练态创建了文件 —— 默认零写盘这条纪律破了')
  assert.match(r.stdout, /演练模式（零写盘）/)
  // 演练态仍须把「将要落什么」讲全，否则用户无从判断要不要加 --apply
  assert.match(r.stdout, new RegExp(CONFIG_PATH.replace(/\./g, '\\.')))
  assert.match(r.stdout, /registry\.yaml/)
})

test('演练态已存在的文件列为「保持不动」，不谎报为将要落', () => {
  const dir = newProject()
  writeFileSync(path.join(dir, CONFIG_PATH), 'version: 1\n', 'utf8')
  const r = runCLI(['--project-dir', dir])
  assert.match(r.stdout, /已存在，保持不动/)
  assert.match(r.stdout, /将[要]落 2 个文件/)
})

// ── --apply：只增缺失 ────────────────────────────────────────────────────────

test('--apply 落三个文件且目录里不多不少（配置 / 注册表 / 项目侧薄壳）', () => {
  const dir = newProject()
  const r = runCLI(['--project-dir', dir, '--apply'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(fileList(dir), [CONFIG_PATH, REGISTRY_PATH, SHELL_PATH].sort())
})

test('--apply 二次运行不覆盖已存在的文件（逐字节不变）', () => {
  const dir = newProject()
  assert.equal(applyInit(dir).written.length, 3)

  // 人手改过的配置：改了 scope.default（正常该改的地方）
  const edited = readFileSync(path.join(dir, CONFIG_PATH), 'utf8').replace(
    /^  default: .*$/m,
    '  default: 我自己改过的分类',
  )
  writeFileSync(path.join(dir, CONFIG_PATH), edited, 'utf8')

  const { written, skipped } = applyInit(dir)
  assert.deepEqual(written, [], '二次运行覆盖了已存在的文件')
  assert.deepEqual(skipped.sort(), [CONFIG_PATH, REGISTRY_PATH, SHELL_PATH].sort())
  assert.equal(readFileSync(path.join(dir, CONFIG_PATH), 'utf8'), edited, '人改过的内容被吃掉了')
})

test('--apply 只补缺的那一个，不连带重写另一个', () => {
  const dir = newProject()
  applyInit(dir)
  rmConfig(dir)
  const original = readFileSync(path.join(dir, REGISTRY_PATH), 'utf8')
  const { written, skipped } = applyInit(dir)
  assert.deepEqual(written, [CONFIG_PATH])
  assert.deepEqual(skipped.sort(), [REGISTRY_PATH, SHELL_PATH].sort())
  assert.equal(readFileSync(path.join(dir, REGISTRY_PATH), 'utf8'), original)
})

function rmConfig(dir) {
  unlinkSync(path.join(dir, CONFIG_PATH))
}

// ── 产物内容：目录分层 / 开关 / 门禁 ─────────────────────────────────────────

test('产物把运行时数据与永久知识库分层，且分层写进配置本身', () => {
  const cfg = renderConfigFromTemplate()
  // 运行时数据必须在 gitignored 侧（照抄模板默认值会让每次探针跑完仓内就不干净）
  for (const [key, want] of [
    ['events_dir', `${WORK_ROOT}/events/`],
    ['proposals_dir', `${WORK_ROOT}/proposals/`],
    ['guard_state', `${WORK_ROOT}/guard-state.json`],
    ['audit_log', `${WORK_ROOT}/audit.jsonl`],
  ]) {
    assert.ok(
      new RegExp(`^  ${key}: ${want.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm').test(cfg),
      `${key} 未落到 ${want}`,
    )
  }
  // 永久知识库在 tracked 侧
  for (const [key, want] of [
    ['entries_dir', `${TRACKED_ROOT}/entries/`],
    ['registry', `${TRACKED_ROOT}/registry.yaml`],
    ['archive_dir', `${TRACKED_ROOT}/entries/archive/`],
  ]) {
    assert.ok(
      new RegExp(`^  ${key}: ${want.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm').test(cfg),
      `${key} 应留在 tracked 侧，实际不是 ${want}`,
    )
  }
  // 模板里那段反例示范（⚠️ 开头、点名「照抄就出事」）已被 init 落实，不该原样留在产物里继续吓人。
  // 判据打的是那段示范本身，不是「不可照抄」四个字 —— init 写回的新注释里也会提到它，
  // 拿字面量当判据就是自己打自己。
  assert.ok(
    !/⚠️ 下面这个默认值/.test(cfg),
    '产物里仍留着「照抄这个默认值就出事」的反例示范 —— init 已经改写了，就不该再让人二次手动改',
  )
})

test('产物能直接通过 validateConfig（不是「大概合法」）', () => {
  const problems = validateConfig(parseYaml(renderConfigFromTemplate()))
  assert.deepEqual(problems, [], `init 产物过不了自家校验：${problems.join('; ')}`)
})

test('产物三个 kill_switch 全为 false（接线前开关必须先于它防的风险存在）', () => {
  const cfg = parseYaml(renderConfigFromTemplate())
  assert.deepEqual(Object.keys(cfg.kill_switch).sort(), [...KILL_SWITCH_KEYS].sort())
  for (const k of KILL_SWITCH_KEYS) {
    assert.equal(cfg.kill_switch[k], false, `kill_switch.${k} 不是 false —— 默认接线就把闸开了`)
  }
})

test('产物在 scope.values 上留了明确 TODO（待人填而不阻塞创建）', () => {
  const cfg = renderConfigFromTemplate()
  assert.match(cfg, /# ⚠️ TODO\(必填\)/)
  const valuesLine = cfg.split('\n').find((l) => /^\s*values: \[/.test(l))
  assert.ok(valuesLine, 'scope.values 行不见了')
  // 保留模板默认（fail-safe 桶 other 永不自动注入）但标出待填：删掉会让创建就判红
  assert.match(valuesLine, /other/, '默认值里的 fail-safe 桶 other 被删了')
})

test('registry 产物是空注册表骨架（不夹带任何守卫）', () => {
  const reg = renderRegistry()
  const parsed = parseYaml(reg)
  const guards = parsed.guards ?? []
  assert.ok(Array.isArray(guards), 'guards 不是数组')
  assert.equal(guards.length, 0, `新项目注册表不该预置守卫，实际有 ${guards.length} 条 —— 守卫属于具体仓库，协议层只带形状`)
})

// ── 副作用边界：不碰 exclude / 不越界建目录 ──────────────────────────────────

test('不修改 .git/info/exclude（只提示，不代改）', () => {
  const dir = newProject()
  mkdirSync(path.join(dir, '.git'), { recursive: true })
  const exclude = path.join(dir, '.git', 'info', 'exclude')
  mkdirSync(path.dirname(exclude), { recursive: true })
  const before = '# 原有人工条目\nnode_modules/\n'
  writeFileSync(exclude, before, 'utf8')

  const r = runCLI(['--project-dir', dir, '--apply'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(exclude, 'utf8'), before, 'init 改了 .git/info/exclude')
  // 但必须**提示**要加，且提示里点名那个运行时目录
  assert.match(r.stdout, new RegExp(EXCLUDE_SUGGESTION.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))
  assert.match(r.stdout, /只提示，不代改/)
})

test('不在条目区之外铺目录树（只多一个装薄壳的 scripts/，且里面只有一个文件）', () => {
  const dir = newProject()
  applyInit(dir)
  assert.deepEqual(
    readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    [TRACKED_ROOT, 'scripts'].sort(),
    'init 建了条目区之外的目录 —— 接入一个技能不该在业务仓里铺自己的目录树',
  )
  // scripts/ 里**只有一个**薄壳文件：它是「层在哪 / 怎么用 / 怎么判装没装好」的入口，
  // 不是判据副本（判据副本 = 两份事实源，见 onboarding 的「环节 4b」）。
  // 目录里多出任何东西都算违规 —— 接入不该在业务仓里留自己的杂物。
  assert.deepEqual(readdirSync(path.join(dir, 'scripts')), ['self-improving.mjs'])
  // 且条目区自身此刻只有注册表：不让空目录进 git（git 不跟踪空目录，建了也是噪声）
  assert.deepEqual(readdirSync(path.join(dir, TRACKED_ROOT)), ['registry.yaml'])
})

// ── npm script 建议 ───────────────────────────────────────────────────────────

test('npm script 建议片段是合法 JSON（整行粘进 package.json 不能解析失败）', () => {
  const dir = newProject()
  const snippet = npmScriptSuggestion(dir)
  const line = snippet.split('\n').find((l) => l.trim().startsWith(`"${NPM_SCRIPT_KEY}"`))
  assert.ok(line, `建议里找不到脚本行：\n${snippet}`)
  // 把它塞进一个最小 package.json 再 parse —— 直接 parse 单个片段验证不了「粘进去会不会炸」
  const merged = JSON.parse(`{"scripts":{${line}}}`)
  assert.equal(merged.scripts[NPM_SCRIPT_KEY], selfTestScript())
  assert.ok(merged.scripts[NPM_SCRIPT_KEY].startsWith('node '))
})

test('项目没有 package.json 时只提示片段，不凭空造一个清单文件', () => {
  const dir = newProject()
  npmScriptSuggestion(dir)
  assert.deepEqual(fileList(dir), [], 'init 凭空创建了 package.json')
})

test('package.json 已有同键时不谎报「建议加入」', () => {
  const dir = newProject()
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { [NPM_SCRIPT_KEY]: 'node x.mjs' } }), 'utf8')
  assert.match(npmScriptSuggestion(dir), /已有.*未改动/)
})

// ── fail-closed：模板形状漂移 ────────────────────────────────────────────────
// 以下三条篡改的是**原始模板**而不是渲染产物 —— 产物里那些行已经被换成新值了，
// 在产物上找旧行只会得到「命中 0 次」，测的就不是 init 的替换表了。

test('模板缺了替换项时渲染报错，不静默产出半成品配置', () => {
  const broken = rawTemplate().replace(/^  events_dir: .*$/m, '')
  assert.throws(() => renderConfig(broken), /配置模板形状已变/, '模板行缺失却照常产出 —— 那是半成品配置')
})

test('模板出现重复的替换项时同样报错（命中数必须恰为 1）', () => {
  const dup = `${rawTemplate()}\n  events_dir: .self-improving/events/\n`
  assert.throws(() => renderConfig(dup), /命中 2 次/, '重复行未被发现 —— 替换会只改掉其中一处，产物半新半旧')
})

test('报错信息点名是哪条替换、为什么必须换（否则后人无从修）', () => {
  // 篡改一条**确实在替换表里**的行。registry 不在表内（它在 tracked 侧，init 有意不动），
  // 拿它当样本会得到「删了也不报」——那不是判据松，是样本选错了。
  const broken = rawTemplate().replace(/^  guard_state: .*$/m, '')
  assert.throws(() => renderConfig(broken), (e) => {
    assert.match(e.message, /guard_state/, '报错没点名是哪条')
    assert.match(e.message, /churn/, '报错只说「形状变了」，没说为什么必须换 —— 后人无从判断能不能删掉这条替换')
    assert.match(e.message, /同步 scripts\/init\.mjs 的 REPLACEMENTS/)
    return true
  })
})

// ── CLI 契约 ────────────────────────────────────────────────────────────────

test('缺 --project-dir 报用法错误并退出 2（不猜 cwd）', () => {
  const r = runCLI([])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--project-dir 必填/)
})

test('项目目录不存在报前置事实不满足并退出 1', () => {
  const r = runCLI(['--project-dir', path.join(tmpdir(), 'si-init-绝对不存在-xyz')])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /前置事实不满足/)
})

test('未知参数退出 2，不被当成 --apply 之外的宽松匹配', () => {
  assert.equal(runCLI(['--project-dir', newProject(), '--force']).status, 2)
})

test('--project-dir 缺值时退出 2（不把下一个 flag 当目录吞掉）', () => {
  assert.equal(runCLI(['--project-dir', '--apply']).status, 2)
})

test('main() 可被直接调用并返回退出码（CLI 入口约定）', () => {
  const dir = newProject()
  assert.equal(main(['--project-dir', dir, '--apply']), 0)
  assert.deepEqual(fileList(dir), [CONFIG_PATH, REGISTRY_PATH, SHELL_PATH].sort())
})

// ── 破坏测试自检：证明上面的判据不是恒真 ─────────────────────────────────────

test('破坏测试自检：把反例默认值塞回产物，对应断言必须变红', () => {
  const good = renderConfigFromTemplate()
  // 模板的「不可照抄」反例值：一旦 init 不再改写它，上面那条分层断言就该红
  const tampered = good.replace(
    /^  audit_log: .*$/m,
    '  audit_log: .self-improving/audit.jsonl',
  )
  assert.notEqual(good, tampered, '篡改没生效 —— 断言无意义')
  assert.ok(
    !/^  audit_log: \.self-improving\/audit\.jsonl$/m.test(good),
    'init 产物里仍写着落在 git-tracked 目录的审计日志路径',
  )
  assert.ok(tampered.match(/^  audit_log: \.self-improving\/audit\.jsonl$/m), '篡改样本构造失败')
})

test('破坏测试自检：排除建议与产物路径是同一条纪律的两种表述', () => {
  const cfg = renderConfigFromTemplate()
  assert.ok(cfg.includes(EXCLUDE_SUGGESTION), '产物里点名了要 ignore 的运行时目录')
  // 二者若各自独立硬编码，改一处另一处会静默脱钩；这里钉住「提示里说的 = 配置里用的」
  assert.notEqual(EXCLUDE_SUGGESTION, `${TRACKED_ROOT}/`, '排除建议指回了 tracked 目录')
  for (const key of ['events_dir', 'proposals_dir', 'guard_state', 'audit_log']) {
    assert.ok(
      new RegExp(`^  ${key}: ${EXCLUDE_SUGGESTION}`, 'm').test(cfg),
      `${key} 不在要 ignore 的工作目录下，与排除建议脱钩`,
    )
  }
})

// ── run-tests.mjs：判据入口（2026-10-19 · T2） ─────────────────────────────
// 接入项目的 npm script 必须指向协议层这个脚本，而不是把「协议层在某仓某目录」写死进 package.json
// —— 那种写法在协议层挪位置后指向不存在的路径，而 npm 脚本失败常被 CI 当成不稳定跳过，
// 于是**静默失去全部回归保护**。
//
// 这里**不直接拉起真实全量套件**：入口会跑 tests/ 下所有文件，其中包括本文件 —— 于是
// 本文件再拉起入口，就是无限递归。改用「把真实脚本复制进一个合成协议根」的办法：
// 验的是同一份代码，但能自由摆布测试内容 —— 连「有失败时退出码非 0」这种真实套件
// 永远演示不出来的情况也能验。

/** 造一个合成协议根：真实 run-tests.mjs + 指定内容的 tests/。 */
function fakeProtocolRoot(testFiles) {
  const root = mkdtempSync(path.join(tmpdir(), 'si-fakeroot-'))
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  copyFileSync(RUN_TESTS, path.join(root, 'scripts', 'run-tests.mjs'))
  const tests = path.join(root, 'tests')
  mkdirSync(tests, { recursive: true })
  for (const [name, body] of Object.entries(testFiles)) {
    writeFileSync(path.join(tests, name), body, 'utf8')
  }
  return { root, entry: path.join(root, 'scripts', 'run-tests.mjs'), tests }
}

const PASSING = "import test from 'node:test'\ntest('ok', () => {})\n"
const FAILING = "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('bad', () => assert.equal(1, 2))\n"

/** 以指定 cwd 跑合成入口。 */
function runFake(entry, cwd) {
  const r = spawnSync(process.execPath, [entry], { cwd, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

test('run-tests 列出全部 *.test.mjs 且按名排序（顺序稳定 → 「哪条先红」可复现）', () => {
  const files = listTestFiles()
  assert.ok(files.length >= 10, `只找到 ${files.length} 个测试文件 —— glob 或目录定位坏了`)
  assert.ok(files.every((f) => f.endsWith('.test.mjs')))
  assert.deepEqual(files, [...files].sort(), '文件顺序不稳定')
  assert.ok(files.some((f) => f.endsWith(`${path.sep}init.test.mjs`)), '连本文件都没被收进去')
})

test('run-tests 在找不到测试目录时报错而不是静默通过', () => {
  // 路径**根本不存在**（不是「存在但为空」—— 那是下一条用例的另一条分支）
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'si-notests-')), '没有这个目录')
  assert.throws(() => listTestFiles(missing), /找不到测试目录/, '「没跑」被当成了「跑过了」')
})

test('run-tests 在测试目录为空时报错（空 ≠ 全绿）', () => {
  const { tests } = fakeProtocolRoot({})
  assert.throws(() => listTestFiles(tests), /没有任何 \*\.test\.mjs/)
  assert.equal(runFake(path.join(path.dirname(tests), 'scripts', 'run-tests.mjs'), path.dirname(tests)).status, 2)
})

test('run-tests 全绿时退出 0 且真的跑出了 TAP 汇总', () => {
  const { root, entry } = fakeProtocolRoot({ 'a.test.mjs': PASSING })
  const r = runFake(entry, root)
  // 光看退出码会被 NODE_TEST_CONTEXT 骗过去：那变量存在时子进程会静默跳过整个文件并 exit 0。
  // 本用例正是从 `node --test` 里发起的，所以它同时验掉了那层坑。
  assert.match(r.stdout, /# tests \d+/, `没跑出 TAP 汇总（多半是 NODE_TEST_CONTEXT 没剥净）\n${r.stdout.slice(-500)}`)
  assert.match(r.stdout, /# fail 0/)
  assert.equal(r.status, 0, r.stderr)
})

test('run-tests 有失败时退出非 0（不是「永远绿」的那种自检）', () => {
  const { root, entry } = fakeProtocolRoot({ 'a.test.mjs': PASSING, 'b.test.mjs': FAILING })
  const r = runFake(entry, root)
  assert.match(r.stdout, /# fail 1/)
  assert.notEqual(r.status, 0, '有失败却退出 0 —— 那正是「永远 exit 0 的自检」，比没有自检更坏')
})

test('run-tests 与 cwd 无关（换目录调用，退出码与跑的用例数一致）', () => {
  const { root, entry } = fakeProtocolRoot({ 'a.test.mjs': PASSING, 'b.test.mjs': PASSING })
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'si-elsewhere-'))
  const a = runFake(entry, root)
  const b = runFake(entry, elsewhere)
  assert.equal(b.status, a.status, '换个目录跑就改了退出码 —— 入口还在按 cwd 定位')
  const count = (s) => (/# tests (\d+)/.exec(s) ?? [])[1]
  assert.equal(count(b.stdout), count(a.stdout), '换个目录跑跑的用例数就变了')
  assert.equal(count(a.stdout), '2')
})

test('run-tests 拒绝位置参数（不猜调用方想跑哪个文件）', () => {
  assert.equal(mainRunTests(['tests/validate.test.mjs']), 2)
})

test('init 建议的 test:self-improving 指向协议层真实存在的入口脚本', () => {
  // 指向一个不存在的脚本 = 接入项目的自检命令恒失败，而失败常被跳过 —— 静默失去保护
  const cmd = selfTestScript()
  assert.match(cmd, /^node /)
  const target = cmd.replace(/^node "?/, '').replace(/"$/, '')
  assert.ok(existsSync(target), `建议指向的脚本不存在：${target}`)
  assert.match(target, /run-tests\.mjs$/)
})

// ── planInit 的形状 ─────────────────────────────────────────────────────────

test('planInit 对已存在的项标 exists（供调用方决定「写还是跳过」）', () => {
  const dir = newProject()
  assert.deepEqual(planInit(dir).map((p) => [p.path, p.exists]), [
    [CONFIG_PATH, false],
    [REGISTRY_PATH, false],
    [SHELL_PATH, false],
  ])
  applyInit(dir)
  assert.deepEqual(planInit(dir).map((p) => [p.path, p.exists]), [
    [CONFIG_PATH, true],
    [REGISTRY_PATH, true],
    [SHELL_PATH, true],
  ])
})

test('planInit 报出的相对路径一律正斜杠（Windows 上也不吐反斜杠）', () => {
  for (const p of planInit(newProject())) {
    assert.ok(!p.path.includes('\\'), `相对路径含反斜杠：${p.path} —— 会被照抄进跨平台的配置里`)
  }
})
