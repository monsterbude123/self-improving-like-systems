/**
 * onboarding.test.mjs —— 跨项目接入的端到端验收
 *
 * `02-01` 之前，「别的项目能用」这句话没有任何可执行的证据支撑。本文件把整条接入
 * 链路在临时目录里跑一遍并逐环节断言，让它从主张变成可复验的命令：
 *
 *   git init → init --apply → 手工并入接线片段 → validate --all → 守卫注册表
 *   → 从**项目目录**调 run-tests → hook-install --doctor
 *
 * 三条方法论纪律：
 *
 *   1. **临时项目自己 `git init`**。配置解析链有一级是「仓根 `.self-improving.yaml`」，
 *      不造真 git 仓库就等于这一级没被覆盖 —— 而它恰恰是「协议层装到别的项目后
 *      还找得到自己的配置」的关键。
 *
 *   2. **不碰本仓任何路径**。这条验收一旦引用主检出，就退化回 `02-01` T3 刚修掉的
 *      那种位置假设：「在我机器上能过」和「在别人机器上能过」从此不再是一回事。
 *      临时项目只允许引用协议层自己的路径。
 *
 *   3. **每条正向断言配一条破坏断言**。只走通顺向的端到端，证明不了判据还在判：
 *      判据退化成恒真时，顺向同样全绿。因此下面每个环节都注入一个错误并要求它变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml } from '../scripts/lib/yaml-lite.mjs'
import { validateRegistryEntry } from '../scripts/validate.mjs'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = path.join(SKILL_ROOT, 'scripts')
const INIT = path.join(SCRIPTS, 'init.mjs')
const VALIDATE = path.join(SCRIPTS, 'validate.mjs')
const HOOK_INSTALL = path.join(SCRIPTS, 'hook-install.mjs')
const RUN_TESTS = path.join(SCRIPTS, 'run-tests.mjs')

const CONFIG = '.self-improving.yaml'
const REGISTRY = '.self-improving/registry.yaml'
const ENTRY = '.self-improving/entries/LRN-20260101-001-onboarding.md'

/** 跑一条命令。cwd 显式传 —— 「在哪个目录下跑」正是这套链路要验的东西之一。 */
function run(cmd, args, cwd) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000, env })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const node = (script, args, cwd) => run(process.execPath, [script, ...args], cwd)

/** 一条合法条目。scope 取 `alpha` —— 这个值**只**存在于本测试生成的项目配置里。 */
function entryText(scope) {
  return `---
type: LRN
status: active
scope: ${scope}
claim: "接入项目的第一条经验：先跑判据再改代码"
guard_ref: null
recurrence: 1
last_verified_at: "2026-01-01"
---

# 接入第一条
`
}

/**
 * 把项目 scope 改成 `alpha/beta` 并落一条 alpha 条目。
 * 这一步是**配置链那一级的判别器**：alpha 不在内置默认表里，所以
 * 「条目校验通过」只有在仓根实例真被读到时才成立。
 */
function customizeScope(project) {
  const p = path.join(project, CONFIG)
  const text = readFileSync(p, 'utf8')
    .replace(/^  values: \[.*\]$/m, '  values: [alpha, beta]')
    .replace(/^  default: .*$/m, '  default: alpha')
  writeFileSync(p, text, 'utf8')
  mkdirSync(path.dirname(path.join(project, ENTRY)), { recursive: true })
  writeFileSync(path.join(project, ENTRY), entryText('alpha'), 'utf8')
}

/** 从 hook-install 的输出里取出 JSON 片段（它的 stdout 是 JSON + 一段人工提示）。 */
function extractSnippet(stdout) {
  const end = stdout.indexOf('\n}\n')
  assert.notEqual(end, -1, `输出里找不到完整 JSON 片段：\n${stdout.slice(-400)}`)
  return stdout.slice(0, end + 3)
}

/**
 * 走完接入链路的前三步，返回项目目录。
 * 后面的用例各自动作，避免一个用例失败连带后面全红而看不出是哪一环。
 */
function onboard({ wire = true } = {}) {
  const project = mkdtempSync(path.join(tmpdir(), 'si-onboard-'))
  run('git', ['init', '-q', '.'], project)
  const r = node(INIT, ['--project-dir', project, '--apply'], project)
  assert.equal(r.status, 0, `init 失败：${r.out}`)
  customizeScope(project)
  if (wire) {
    const snip = node(HOOK_INSTALL, ['--project-dir', project], project)
    assert.equal(snip.status, 0, `hook-install 出片段失败：${snip.out}`)
    mkdirSync(path.join(project, '.zcode'), { recursive: true })
    writeFileSync(path.join(project, '.zcode', 'config.json'), extractSnippet(snip.stdout), 'utf8')
  }
  return project
}

// ── 环节 1：init ─────────────────────────────────────────────────────────────

test('环节 1 · init 在一个全新空项目里落两份文件，且不多落', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'si-onboard-'))
  run('git', ['init', '-q', '.'], project)
  // git init 自建 .git/info/exclude —— 先取基线，判据要比「内容未变」而不是「文件不存在」
  const exclude = path.join(project, '.git', 'info', 'exclude')
  const excludeBefore = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null

  const r = node(INIT, ['--project-dir', project, '--apply'], project)
  assert.equal(r.status, 0, r.out)
  assert.ok(existsSync(path.join(project, CONFIG)))
  assert.ok(existsSync(path.join(project, REGISTRY)))
  assert.ok(!existsSync(path.join(project, '.self-improving-work')), 'init 预先建了运行时目录 —— 那是提示给人去 exclude 的，不该由它落盘')
  const excludeAfter = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null
  assert.equal(excludeAfter, excludeBefore, 'init 改了 .git/info/exclude')
})

test('破坏 · 演练态的 init 在同一份项目上零变更（端到端也守默认零写盘）', () => {
  const project = onboard()
  const before = readFileSync(path.join(project, CONFIG), 'utf8')
  const dry = node(INIT, ['--project-dir', project], project)
  assert.equal(dry.status, 0, dry.out)
  assert.equal(readFileSync(path.join(project, CONFIG), 'utf8'), before, '演练态改动了已有配置')
})

// ── 环节 2：validate（配置链的仓根实例这一级） ───────────────────────────────

test('环节 2 · 从项目目录跑 validate --all 零问题退出（证明读到了仓根实例）', () => {
  const project = onboard()
  const r = node(VALIDATE, ['--all'], project)
  assert.equal(r.status, 0, `validate 未通过：\n${r.out}`)
  assert.match(r.stdout, /PASS/)
})

test('破坏 · 移走仓根配置后同一条命令必须变红（否则它读的是内置默认，不算覆盖）', () => {
  const project = onboard()
  const cfg = path.join(project, CONFIG)
  const parked = `${cfg}.parked`
  renameSync(cfg, parked)
  const r = node(VALIDATE, ['--all'], project)
  renameSync(parked, cfg)
  assert.notEqual(r.status, 0, '拿掉仓根配置后仍然通过 —— 那一级根本没被覆盖，端到端是假的')
  assert.match(r.out, /alpha|scope/, `失败原因不是 scope：\n${r.out}`)
})

test('破坏 · 把 kill_switch 改成字符串必须让 validate 变红', () => {
  const project = onboard()
  const cfg = path.join(project, CONFIG)
  const before = readFileSync(cfg, 'utf8')
  writeFileSync(cfg, before.replace(/^  injection: false$/m, '  injection: "true"'), 'utf8')
  const r = node(VALIDATE, ['--all'], project)
  writeFileSync(cfg, before, 'utf8')
  assert.notEqual(r.status, 0, 'kill_switch 写成字符串仍通过 —— 判据已失效')
  assert.match(r.out, /kill_switch|injection/)
})

// ── 环节 3：守卫注册表 ──────────────────────────────────────────────────────

test('环节 3 · 新项目注册表是空表且逐条过校验', () => {
  const project = onboard()
  const reg = parseYaml(readFileSync(path.join(project, REGISTRY), 'utf8'))
  assert.deepEqual(reg.guards ?? [], [], '新项目注册表不该预置守卫')
  for (const g of reg.guards ?? []) assert.deepEqual(validateRegistryEntry(g), [])
})

test('破坏 · 注册表塞一条结构非法的守卫必须被校验打回', () => {
  // args 为空数组 = 派发器无从执行，而它在注册表里长得和正常条目一样
  const bad = { key: 'k', args: [], when: 'commit 前' }
  const problems = validateRegistryEntry(bad)
  assert.ok(problems.length > 0, 'args 为空的守卫被放行 —— 派发时它会静默什么都不做')
})

test('破坏 · 注册表里有非法条目时判据确实会红（不是恒真）', () => {
  const project = onboard()
  const regPath = path.join(project, REGISTRY)
  const before = readFileSync(regPath, 'utf8')
  // 替换 `guards: []` 本身 —— 往后追加会变成 `guards` 的兄弟节点，那是 YAML 缩进错误，
  // 测到的就成了「解析失败」而不是「条目非法」。
  assert.ok(before.includes('guards: []'), `注册表模板形态变了：\n${before.slice(-200)}`)
  writeFileSync(regPath, before.replace('guards: []', 'guards:\n  - key: 坏条目\n    args: []\n    when: never'), 'utf8')
  const reg = parseYaml(readFileSync(regPath, 'utf8'))
  const problems = (reg.guards ?? []).flatMap((g) => validateRegistryEntry(g))
  writeFileSync(regPath, before, 'utf8')
  assert.equal((reg.guards ?? []).length, 1, '篡改样本没建出条目 —— 判据等于没被触发')
  assert.ok(problems.length > 0, '篡改后的注册表全部通过 —— validateRegistryEntry 已恒真')
})

// ── 环节 4：判据入口从项目目录可用 ──────────────────────────────────────────

test('环节 4 · 判据入口在接入项目目录下可跑通（判据不寄生在本仓）', () => {
  const project = onboard()
  // 这里**不**直接跑真实全量套件：入口会跑 tests/ 下所有文件，其中包含本文件 ——
  // 本文件再拉起入口就是无限递归（实测把子进程拖到 600s 超时被杀）。
  // 改用「真实入口脚本 + 合成 tests/」：验的是同一份代码的同一个性质
  // （从任意 cwd 调用都指向协议层自己的 tests），且不再自我嵌套。
  // 全量套件本身的绿由顶层 `node scripts/run-tests.mjs` 保证。
  const root = mkdtempSync(path.join(tmpdir(), 'si-onboard-fakeroot-'))
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  copyFileSync(RUN_TESTS, path.join(root, 'scripts', 'run-tests.mjs'))
  mkdirSync(path.join(root, 'tests'), { recursive: true })
  writeFileSync(path.join(root, 'tests', 'a.test.mjs'), "import test from 'node:test'\ntest('ok', () => {})\n", 'utf8')

  const r = node(path.join(root, 'scripts', 'run-tests.mjs'), [], project)
  assert.equal(r.status, 0, `从接入项目目录调用判据入口失败：\n${r.out.slice(-800)}`)
  assert.match(r.stdout, /# fail 0/)
  assert.match(r.stdout, /# tests \d+/, '没跑出 TAP 汇总（多半是 NODE_TEST_CONTEXT 没剥净）')
  // 反向确认：同一次调用换一个 cwd 结果不变
  const other = node(path.join(root, 'scripts', 'run-tests.mjs'), [], root)
  assert.equal(other.status, r.status, '换个 cwd 结果就变了 —— 入口还在按 cwd 定位')
})

test('环节 4b · 接入项目目录里没有指向本仓的判据副本（判据入口只有协议层一处）', () => {
  const project = onboard()
  // init 生成的配置与接线片段都只应指向协议层；若哪天开始往项目里复制一份判据，
  // 就会出现「两份判据各自演化」—— 那正是 02-01 诊断出的 B 点病灶。
  const hookCfg = readFileSync(path.join(project, '.zcode', 'config.json'), 'utf8')
  assert.match(hookCfg, /ZCODE_PROJECT_DIR/)
  assert.ok(!existsSync(path.join(project, 'scripts', 'validate.mjs')), '接入项目里出现了判据脚本副本')
  assert.ok(!existsSync(path.join(project, 'tests')), '接入项目里出现了判据测试副本')
})

// ── 环节 5：接线体检 ────────────────────────────────────────────────────────

test('环节 5 · 并入接线片段后 doctor 零 problem', () => {
  const project = onboard()
  const r = node(HOOK_INSTALL, ['--doctor', '--project-dir', project], project)
  assert.equal(r.status, 0, `doctor 报错：\n${r.out}`)
  assert.ok(!/❌/.test(r.out), `doctor 报了问题：\n${r.out}`)
})

test('破坏 · 把 hooks.enabled 改 false 后 doctor 必须报出问题', () => {
  const project = onboard()
  const cfgPath = path.join(project, '.zcode', 'config.json')
  const before = readFileSync(cfgPath, 'utf8')
  const cfg = JSON.parse(before)
  cfg.hooks.enabled = false
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8')
  const r = node(HOOK_INSTALL, ['--doctor', '--project-dir', project], project)
  writeFileSync(cfgPath, before, 'utf8')
  assert.match(r.out, /hooks\.enabled/, `doctor 没抓到 enabled=false：\n${r.out}`)
  assert.notEqual(r.status, 0)
})

test('破坏 · 把接线片段里的脚本换成不存在的文件，doctor 必须报出来', () => {
  const project = onboard()
  const cfgPath = path.join(project, '.zcode', 'config.json')
  const before = readFileSync(cfgPath, 'utf8')
  const cfg = JSON.parse(before)
  // 篡改**真实片段**里的脚本名，而不是手写一条命令：手写就得把部署路径字面量搬进测试，
  // 而那正是可移植性守卫（tests/portability.test.mjs）要拦的东西 —— 让判据与守卫互相打脸。
  // 只换文件名（ASCII：判据的正则是 [A-Za-z0-9_.-]+，中文名压根匹配不上），
  // 死路径也只有落在 `.../scripts/<name>` 形态上才会被静态核对。
  const cmd = cfg.hooks.events.PostToolUse[0].hooks[0].command
  cfg.hooks.events.PostToolUse[0].hooks[0].command = cmd.replace(/[\w-]+\.mjs/, 'no-such-hook.mjs')
  assert.notEqual(cfg.hooks.events.PostToolUse[0].hooks[0].command, cmd, '篡改没生效')
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8')
  const r = node(HOOK_INSTALL, ['--doctor', '--project-dir', project], project)
  writeFileSync(cfgPath, before, 'utf8')
  assert.match(r.out, /no-such-hook\.mjs/, `doctor 没抓到死路径：\n${r.out}`)
})

// ── 零耦合：整条链路不许引用本仓 ────────────────────────────────────────────

test('零耦合 · 临时项目里没有任何指向本仓（协议层以外）的绝对路径', () => {
  const project = onboard()
  const files = [CONFIG, REGISTRY, ENTRY, '.zcode/config.json']
  for (const rel of files) {
    const text = readFileSync(path.join(project, rel), 'utf8')
    // 协议层自己的路径是允许的（本测试就是它发起的）；别的绝对路径一律不允许：
    // 那意味着接入项目要靠「某台机器上恰好存在某个目录」才能工作。
    const suspicious = text.match(/[A-Za-z]:[\\/][^/\\"<>\s]+/g)?.filter((p) => !p.startsWith(SKILL_ROOT.slice(0, 2))) ?? []
    assert.deepEqual(suspicious, [], `${rel} 里出现了协议层之外的绝对路径：${suspicious.join(', ')}`)
  }
})

test('零耦合 · 演练与体检全程没在临时项目里写 .git/info/exclude', () => {
  const project = onboard()
  const exclude = path.join(project, '.git', 'info', 'exclude')
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null
  node(INIT, ['--project-dir', project], project)
  node(HOOK_INSTALL, ['--doctor', '--project-dir', project], project)
  const after = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null
  assert.equal(after, before, '接入链路改了 .git/info/exclude —— 运行时目录必须由人显式 exclude')
})

/**
 * 产出文本里泄漏了哪些「协议层不该知道的位置」。抽成函数是为了能被注入测试：
 * 判据写在 `it()` 里的话，注入测试只能重复一遍同样的表达式，
 * 于是「判据变了、注入测试没变」这种假绿照样通过。
 */
function leakReasons(text, needles) {
  return needles.filter(([value]) => value && value.length > 1 && text.includes(value)).map(([, what]) => what)
}

/** 协议层自己所在检出根 + 用户家目录，两种分隔符形态。协议层唯一「知道」的位置就是这两处。 */
function selfLeaks() {
  // SKILL_ROOT 由 import.meta.url 推出（不是某个写死的仓名），并就地校验它确实是检出根 ——
  // 层级写错一级不会报错，只会让判据悄悄变弱，所以这里把它钉住。
  assert.ok(existsSync(path.join(SKILL_ROOT, 'scripts')), `SKILL_ROOT 层级有误（它不像检出根）: ${SKILL_ROOT}`)
  const HOME = homedir()
  return [
    [SKILL_ROOT, '协议层检出根'],
    [SKILL_ROOT.replace(/\\/g, '/'), '协议层检出根（正斜杠形态）'],
    [HOME, '用户家目录'],
    [HOME.replace(/\\/g, '/'), '用户家目录（正斜杠形态）'],
  ]
}

test('零耦合 · 接入链路产出里没有任何指向协议层自身检出位置或用户家目录的路径', () => {
  // 为什么改成自指形态：原来的判据是「产出里不含字符串 <某个仓名>」，它只对**那一个仓名**
  // 有效 —— 换个人接、换个仓名接，这条断言就退化成「没提到这个我不认识的名字」，恒真。
  // 它证明的从来不是「没泄漏宿主位置」，而是「不认识这个词」。
  // 协议层不知道宿主仓叫什么，所以它的断言也不该知道；能自证的泄漏只有一类：
  // **协议层把自己所在的检出位置 / 用户家目录写进了产出**。那才是可移植性真正的破绽。
  const needles = selfLeaks()
  assert.ok(needles.filter(([v]) => v.length > 1).length >= 2, '自指判据自身失效：检出根与家目录都没解析出来')
  const project = onboard()
  for (const rel of [CONFIG, REGISTRY, '.zcode/config.json']) {
    const text = readFileSync(path.join(project, rel), 'utf8')
    const leaked = leakReasons(text, needles)
    assert.deepEqual(leaked, [], `${rel} 泄漏了 ${leaked.join('、')} —— 一旦泄漏，这条验收就只在本机成立`)
  }
})

test('破坏测试：注入一条含检出根的产出 → 泄漏判据必须报出来（不得恒绿）', () => {
  const needles = selfLeaks()
  const root = needles.find(([v]) => v.length > 1)[0]
  assert.deepEqual(leakReasons(`# 泄漏样例 ${root}\n`, needles), ['协议层检出根'], '含检出根的产出必须被判为泄漏')
  assert.deepEqual(leakReasons(`# 正常产出 ${JSON.stringify({ guards: [] })}\n`, needles), [], '干净产出不得被误报')
  // 家目录形态同样要能认出（Windows 上路径分隔符不同，只测检出根会漏掉一半）
  const home = needles.find(([, what]) => what === '用户家目录')[0]
  assert.deepEqual(leakReasons(`# ${home}\n`, needles), ['用户家目录'], '含家目录的产出必须被判为泄漏')
})
