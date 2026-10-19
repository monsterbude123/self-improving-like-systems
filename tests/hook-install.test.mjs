/**
 * hook-install.test.mjs —— 接线脚手架 + 体检器的判据测试
 *
 * 形态约定（承自本技能其余测试）：**每条断言都必须能被注入的错误打红**，
 * 否则它测的不是判据、是恒真。本文件末尾的「破坏测试自检」用一个明显非法的配置
 * 跑 doctorConfig，若不报红则整条判据失效。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { doctorConfig, resolveSkillScriptsDir } from '../scripts/hook-install.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 脚本目录按**本文件位置**解析，不按 cwd、也不假设部署在 <repo>/.agents/skills/<name>/。
// 原写法是 path.resolve('.agents/skills/self-improving-like-systems/scripts') —— 它隐含
// 「技能部署在某个业务仓的固定深度」，协议层一旦独立成仓或 clone 到全局，就静默指向不存在的
// 目录，体检器于是对每条用例误报「脚本不存在」。可移植性判据见 tests/portability.test.mjs。
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = path.join(SKILL_ROOT, 'scripts')

/**
 * 造一份最小合法配置：enabled + 一条 PostToolUseFailure（command 型）。
 * 脚本路径用**相对 SCRIPTS 的相对形式** —— 体检器对「不含 ${} 的路径」按
 * `path.resolve(SCRIPTS, p)` 判定，写绝对路径会被 resolve 成非法路径从而误报不存在。
 * 真实配置里带的是 ${ZCODE_PROJECT_DIR}，走的是「不判存在性」那条分支（另有专门用例覆盖）。
 */
function baseConfig(over = {}) {
  return {
    hooks: {
      enabled: true,
      events: {
        PostToolUseFailure: [{
          hooks: [{
            type: 'command',
            command: 'node capture.mjs --source tool --kind tool_error --text - --no-block',
            timeout: 10,
          }],
        }],
      },
      ...over,
    },
  }
}

const has = (problems, re) => problems.some((p) => re.test(p))

test('合法配置：零问题', () => {
  const r = doctorConfig(baseConfig(), SCRIPTS)
  assert.deepEqual(r.problems, [], '合法配置不该报问题：' + r.problems.join(' | '))
  assert.equal(r.checked, 1)
})

test('enabled 缺失 → 报「配置钩子默认关闭」（头号静默失效）', () => {
  const cfg = baseConfig()
  delete cfg.hooks.enabled
  const { problems } = doctorConfig(cfg, SCRIPTS)
  assert.ok(has(problems, /hooks\.enabled/), '应报 enabled：' + problems.join(' | '))
})

test('enabled=false → 同样报出', () => {
  const cfg = baseConfig()
  cfg.hooks.enabled = false
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /hooks\.enabled=/))
})

test('事件名非法 → 报出（七个之外永不触发且无报错）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUsee = [{ hooks: [{ type: 'command', command: 'node x.mjs' }] }]
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /事件名 PostToolUsee 非法/))
})

test('type 非法 → 报出', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].type = 'shell'
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /type="shell" 非法/))
})

test('字段与 type 错配（process 带 timeout）→ 报出', () => {
  const cfg = baseConfig()
  const h = cfg.hooks.events.PostToolUseFailure[0].hooks[0]
  delete h.command
  h.type = 'process'
  h.args = ['node', 'x.mjs']
  h.timeout = 10 // process 不接受 timeout
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /不接受字段 timeout/))
})

test('command 带 args → 报出（反向错配）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].args = ['x']
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /不接受字段 args/))
})

test('enabled 字段不算错配（宿主容忍的扩展键）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].enabled = true
  assert.deepEqual(doctorConfig(cfg, SCRIPTS).problems, [], 'enabled 不该被判错配')
})

test('插件专有变量用在配置钩子 → 报出', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].command =
    'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"'
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /插件专有变量/))
})

test('command 钩子 timeout 单位疑似秒值过大 → 报出', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].timeout = 900
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /单位是\*\*秒\*\*/))
})

test('process 钩子 timeoutMs 疑似本意是秒 → 报出', () => {
  const cfg = baseConfig()
  const h = cfg.hooks.events.PostToolUseFailure[0].hooks[0]
  delete h.command
  h.type = 'process'
  h.args = ['node', 'x.mjs']
  h.timeoutMs = 500 // 500ms 很可能是本意 500 秒
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /单位是毫秒/))
})

test('matcher 非法正则 → 报出', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].matcher = '[unclosed'
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /不是合法正则/))
})

test('脚本不存在 → 报出（无模板变量时才判）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].command = 'node "no-such-dir/x.mjs"'
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /不存在/))
})

test('脚本路径含模板变量 → 解析后的协议层目录里确有该脚本时**不**报「不存在」', () => {
  // 口径已升级（2026-10-19）：此前是「带 ${} 一律不判」，理由是静态拼不出真实路径。
  // 现在 resolveSkillScriptsDir 能解析出协议层目录，而**技能相对形态**的脚本名是确定的，
  // 所以这一类从「不判」升级为「按解析到的真实目录核对」。
  // 本例正是「确有该脚本 ⇒ 不得误报」的那一极 —— 误报防线没有被削弱。
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].command =
    'node "${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts/capture.mjs" --text -'
  const { problems } = doctorConfig(cfg, SCRIPTS)
  assert.ok(!has(problems, /不存在/), '解析后确实存在时不得误报：' + problems.join(' | '))
})

test('破坏测试：同一形态但脚本不存在 → 必须报「钩子必然失败」（守卫不得恒绿）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].command =
    'node "${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts/no-such-script.mjs" --text -'
  const { problems } = doctorConfig(cfg, SCRIPTS)
  assert.ok(has(problems, /必然失败|没有它/), '协议层目录下没有该脚本时必须报出：' + problems.join(' | '))
})

test('非技能相对形态的模板变量路径仍不判存在性（误报防线未被扩大）', () => {
  const cfg = baseConfig()
  cfg.hooks.events.PostToolUseFailure[0].hooks[0].command = 'node "${ZCODE_PROJECT_DIR}/tools/whatever.mjs"'
  const { problems } = doctorConfig(cfg, SCRIPTS)
  assert.ok(!has(problems, /不存在/), '非技能相对形态无法静态核对，不得判：' + problems.join(' | '))
})

test('resolveSkillScriptsDir：命中已解析到的目录，且不假设项目内存在协议层', () => {
  const dir = resolveSkillScriptsDir(path.join(tmpdir(), 'si-does-not-exist-' + Date.now()))
  assert.ok(existsSync(dir), `解析结果应是一个真实存在的目录，实际=${dir}`)
  assert.ok(existsSync(path.join(dir, 'hook-install.mjs')), `解析结果应指向协议层 scripts，实际=${dir}`)
})

test('缺 hooks 段 / 缺 events 段 → 各自报出', () => {
  assert.ok(has(doctorConfig({}, SCRIPTS).problems, /没有 hooks 段/))
  assert.ok(has(doctorConfig({ hooks: { enabled: true } }, SCRIPTS).problems, /没有 hooks\.events 段/))
})

test('事件值不是数组 → 报出', () => {
  const cfg = baseConfig()
  cfg.hooks.events.Stop = { hooks: [] }
  assert.ok(has(doctorConfig(cfg, SCRIPTS).problems, /必须是数组/))
})

test('missing 列出未接线的事件', () => {
  const { missing } = doctorConfig(baseConfig(), SCRIPTS)
  assert.ok(missing.includes('SessionStart') && missing.includes('Stop'))
  assert.ok(!missing.includes('PostToolUseFailure'))
})

// ===== 破坏测试自检：判据本身必须能被打红 =====
test('破坏测试自检：一个千疮百孔的配置必须报出多条问题', () => {
  const broken = {
    hooks: {
      enabled: false,
      events: {
        PostToolUsee: [{ hooks: [{ type: 'nope', command: '' }] }],
        Stop: [{ matcher: '[bad', hooks: [{ type: 'process', args: ['x'], timeout: 9 }] }],
        PostToolUseFailure: [{
          hooks: [{
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/x.mjs"',
            args: ['oops'],
            timeout: 5000,
          }],
        }],
      },
    },
  }
  const { problems } = doctorConfig(broken, SCRIPTS)
  assert.ok(problems.length >= 6, `应报出 >=6 条，实际 ${problems.length}：${problems.join(' | ')}`)
})

// ===== 片段形状对拍：片段、权威 snippet、doctor 判据必须是同一个契约 =====
// 2026-10-19 实测踩到：片段把 events.<Event> 吐成对象，而宿主契约、references/hook-wiring.json
// 与 doctorConfig 判据三处都是数组。同事照官方路径接线 → `--doctor` 报五条「事件值必须是数组」；
// 若直接并进真实配置则不被宿主匹配 → 静默零投递。这条对拍就是防它退回去的。
test('片段的每个事件值都是数组，且与 references/hook-wiring.json 同形', () => {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-install.mjs')], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  const end = r.stdout.indexOf('\n}\n')
  assert.notEqual(end, -1, `片段不是可解析的 JSON：\n${r.stdout.slice(-400)}`)
  const snippet = JSON.parse(r.stdout.slice(0, end + 3))
  const authority = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'references', 'hook-wiring.json'), 'utf8'))

  for (const [event, value] of Object.entries(snippet.hooks.events)) {
    assert.ok(Array.isArray(value), `${event} 的值不是数组 —— 宿主按数组匹配，吐对象会静默零投递`)
    assert.ok(value.length > 0 && Array.isArray(value[0].hooks), `${event} 缺 hooks 数组`)
  }
  // 片段覆盖的每个事件，权威 snippet 里也必须是同一种形状（数组）
  for (const event of Object.keys(snippet.hooks.events)) {
    if (!(event in authority.events)) continue
    assert.ok(Array.isArray(authority.events[event]), `权威 snippet 的 ${event} 不是数组，与片段不一致`)
  }
})

test('片段并进配置后 doctor 零问题（片段本身就是可接线的）', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'si-snippet-'))
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-install.mjs'), '--project-dir', project], { encoding: 'utf8', timeout: 60_000 })
  const end = r.stdout.indexOf('\n}\n')
  mkdirSync(path.join(project, '.zcode'), { recursive: true })
  writeFileSync(path.join(project, '.zcode', 'config.json'), r.stdout.slice(0, end + 3), 'utf8')
  const { problems } = doctorConfig(JSON.parse(readFileSync(path.join(project, '.zcode', 'config.json'), 'utf8')), SCRIPTS)
  assert.deepEqual(problems, [], `官方片段自己过不了自家体检：${problems.join(' | ')}`)
})
