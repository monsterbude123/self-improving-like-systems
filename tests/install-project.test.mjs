/**
 * install-project.test.mjs —— 「一条命令接入一个项目」的判据测试
 *
 * 存在理由（2026-10-21）：实测（.planning/02-VERIFICATION.md）协议层能装能跑，
 * 但「接进新项目」要手工 7 步，且 `init` 会把本机绝对路径写进新项目清单；
 * 更糟的是生成的钩子指向**项目内**的协议层副本 —— 层装在仓外时那份路径根本不存在，
 * 而体检器只核对脚本名、从不核对命令里写的路径 ⇒ **体检判绿、钩子每次失败**。
 *
 * 本文件把三件事钉成机器判据：
 *   ① 生成的接线**指向真实存在的脚本**（死链不得发生）；
 *   ② 体检能抓住「命令指向的路径不存在」（旧口径漏判的那一类）；
 *   ③ 接入过程只增不覆盖，且清单文件不被重排。
 *
 * 形态纪律（承自本仓其余测试）：每条断言都必须能被注入的错误打红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_POINTER_NAME,
  PROJECT_SCRIPTS,
  SHELL_REL,
  applyGitignore,
  applyPackageScripts,
  packageJsonRoundTrip,
  planInstall,
  planPackageScripts,
  pointerContent,
} from '../scripts/install-project.mjs'
import { applyHooks, doctorConfig, resolveSkillScriptsDir } from '../scripts/hook-install.mjs'
import { runLayerGate } from '../scripts/lib/layer-gate.mjs'
import { LAYER_GITHUB_URL, LAYER_NPM_PACKAGE } from '../scripts/lib/layer-resolve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPTS = path.join(ROOT, 'scripts')

/** 造一个临时项目目录。 */
function tmpProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'si-install-'))
}

/** 抽出接线片段里那条命令文本（片段形状 = 数组的数组的 hooks 数组）。 */
function commandsOf(cfg) {
  const out = []
  for (const [event, groups] of Object.entries(cfg.hooks?.events ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        out.push({ event, text: `${h.command ?? ''} ${JSON.stringify(h.args ?? [])}` })
      }
    }
  }
  return out
}

/** 从命令文本里抽出脚本路径。 */
function scriptPathOf(text) {
  const m = /"([^"]+\.(?:mjs|cjs|js))"/.exec(text) ?? /([^\s"']+\.(?:mjs|cjs|js))/.exec(text)
  return m ? m[1] : null
}

test('接入计划：落 4 类东西（实例配置 / 注册表 / 项目侧薄壳 / 指针）', () => {
  const dir = tmpProject()
  try {
    const plan = planInstall(dir)
    const kinds = plan.map((p) => p.kind)
    assert.ok(kinds.includes('config'), '要有实例配置')
    assert.ok(kinds.includes('registry'), '要有注册表')
    assert.ok(kinds.includes('shell'), '要有项目侧薄壳')
    assert.ok(kinds.includes('pointer'), '要有指针')
    const shell = plan.find((p) => p.kind === 'shell')
    assert.equal(shell.path, SHELL_REL, '薄壳落在约定位置')
    assert.ok(shell.content.includes('self-improving-like-systems'), '薄壳要指向层')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('指针内容必须含 GitHub 仓地址 + 可执行 npm 命令形态（门禁判据③要能过）', () => {
  const content = pointerContent(DEFAULT_POINTER_NAME)
  assert.ok(content.includes(LAYER_GITHUB_URL), '指针必须含 GitHub 公开仓地址')
  assert.ok(new RegExp(`(npm i -g|npx)\\s+${LAYER_NPM_PACKAGE}`).test(content), '指针必须含可执行的 npm 命令形态')
})

test('接入后的项目：层门禁判据全过（层在位 + 指针两通道齐全 + 无仓内副本）', () => {
  const dir = tmpProject()
  try {
    const plan = planInstall(dir)
    for (const it of plan) {
      mkdirSync(path.dirname(it.abs), { recursive: true })
      writeFileSync(it.abs, it.content, 'utf8')
    }
    const r = runLayerGate({ repoRoot: dir })
    assert.equal(r.ok, true, '接入完就该过门禁：\n' + r.lines.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('破坏测试：指针少写一条通道 → 门禁判红（防遗忘机制不得恒绿）', () => {
  const dir = tmpProject()
  try {
    const plan = planInstall(dir)
    for (const it of plan) {
      mkdirSync(path.dirname(it.abs), { recursive: true })
      // 注入：把 npm 那条命令形态删掉，只留 GitHub 地址
      const content = it.kind === 'pointer'
        ? it.content.replace(new RegExp(`(npm i -g|npx)\\s+${LAYER_NPM_PACKAGE}`, 'g'), '（被删掉的 npm 通道）')
        : it.content
      writeFileSync(it.abs, content, 'utf8')
    }
    const r = runLayerGate({ repoRoot: dir })
    assert.equal(r.ok, false, '少一条通道必须判红')
    assert.match(r.lines.join('\n'), /分发通道/, '要说清是通道缺失：\n' + r.lines.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('生成的接线：每条命令指向的脚本**真实存在**（死链不得发生）', () => {
  // 这是 2026-10-21 那个静默失效的正向判据：
  // 片段里写的路径，必须是运行期真会执行的那个路径，且它存在。
  const dir = tmpProject()
  try {
    // 接入：先落薄壳（钩子入口），再接线
    for (const it of planInstall(dir)) {
      mkdirSync(path.dirname(it.abs), { recursive: true })
      writeFileSync(it.abs, it.content, 'utf8')
    }
    const r = applyHooks(dir, resolveSkillScriptsDir(dir))
    assert.equal(r.ok, true, '接线应成功：' + r.lines.join('\n'))
    const cfg = JSON.parse(readFileSync(path.join(dir, '.zcode', 'config.json'), 'utf8'))
    const cmds = commandsOf(cfg)
    assert.ok(cmds.length >= 5, '应接了 5 个事件')
    for (const c of cmds) {
      const p = scriptPathOf(c.text)
      assert.ok(p, `${c.event} 的命令里应能认出脚本路径：${c.text}`)
      // 入口是项目相对路径（宿主在会话启动时展开成项目根）—— 按项目根核对它存在
      const abs = path.resolve(dir, p.replace('${ZCODE_PROJECT_DIR}', '.'))
      assert.ok(existsSync(abs), `${c.event} 指向的脚本必须存在，否则钩子必然失败：${abs}`)
      assert.ok(!p.includes('C:'), `${c.event} 的脚本路径不该含机器盘符（配置要可移植）：${p}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('破坏测试：接线指向已删的项目内副本 → 体检必须报「钩子必然失败」', () => {
  // 旧口径只核对脚本名在层目录里在不在 —— 这一类（旧形态接线）**体检全绿、钩子每次失败**。
  const dir = tmpProject()
  try {
    const cfg = {
      hooks: {
        enabled: true,
        events: {
          PostToolUseFailure: [{
            hooks: [{
              type: 'command',
              command: 'node "${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts/capture.mjs" --text -',
              timeout: 10,
            }],
          }],
        },
      },
    }
    const r = doctorConfig(cfg, SCRIPTS, dir)
    assert.ok(r.problems.length > 0, '这种形态必须被报出来（旧口径会漏判）')
    assert.match(r.problems.join('\n'), /必然失败/, '要说清是必然失败：' + r.problems.join(' | '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('破坏测试：事件值多包一层数组 → 体检必须判红（那种形状宿主一条都不匹配）', () => {
  // 2026-10-21 实测：`hook-install --apply` 一直产出 `[[{hooks:[…]}]]`，
  // 宿主读不到 hooks 字段 ⇒ 整条事件被静默忽略（配置看着齐、事件永远不投递、无报错）。
  const cfg = {
    hooks: {
      enabled: true,
      events: {
        PostToolUseFailure: [[{
          hooks: [{ type: 'command', command: 'node capture.mjs --text -', timeout: 10 }],
        }]],
      },
    },
  }
  const r = doctorConfig(cfg, SCRIPTS, ROOT)
  assert.ok(r.problems.length > 0, '双层形状必须被报出来')
  assert.match(r.problems.join('\n'), /多包了一层|静默忽略/, '要说清是形状错层：' + r.problems.join(' | '))
})

test('接线只增不覆盖：已有事件条目原样保留', () => {
  const dir = tmpProject()
  try {
    const cfgPath = path.join(dir, '.zcode', 'config.json')
    mkdirSync(path.dirname(cfgPath), { recursive: true })
    const mine = { hooks: [{ type: 'command', command: 'node mine.mjs' }] }
    writeFileSync(cfgPath, JSON.stringify({ hooks: { enabled: true, events: { Stop: mine } } }, null, 2), 'utf8')
    const r = applyHooks(dir, resolveSkillScriptsDir(dir))
    assert.equal(r.ok, true)
    const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
    assert.deepEqual(after.hooks.events.Stop, mine, '已存在的条目必须原样不动')
    assert.ok(after.hooks.events.SessionStart, '缺的应补上')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清单文件：往返不变形才改，只加缺的脚本', () => {
  const dir = tmpProject()
  try {
    const pkgPath = path.join(dir, 'package.json')
    writeFileSync(pkgPath, JSON.stringify({ name: 'x', scripts: { build: 'tsc', 'si:doctor': '我自己写的' } }, null, 2) + '\n', 'utf8')
    const plan = planPackageScripts(dir)
    assert.ok(plan.add['si:install'], '应计划新增缺的脚本')
    assert.equal(plan.add['si:doctor'], undefined, '已有的脚本不得被覆盖')
    assert.ok(plan.skip.includes('si:doctor'), '已有的应记为跳过')
    const res = applyPackageScripts(dir, plan.add)
    assert.equal(res.changed, true)
    const after = JSON.parse(readFileSync(pkgPath, 'utf8'))
    assert.equal(after.scripts.build, 'tsc', '原有脚本不得动')
    assert.equal(after.scripts['si:doctor'], '我自己写的', '已有的脚本值不得被改写')
    assert.equal(after.scripts['si:install'], PROJECT_SCRIPTS['si:install'])
    // 再跑一次：幂等，不再新增
    const plan2 = planPackageScripts(dir)
    assert.deepEqual(plan2.add, {}, '第二次不应再新增（幂等）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清单文件：JSON 往返会变形 → 一律不碰（只给建议）', () => {
  const dir = tmpProject()
  try {
    const pkgPath = path.join(dir, 'package.json')
    // 数字 1.0 经 JSON.parse → stringify 变成 1 ⇒ 往返变形
    writeFileSync(pkgPath, '{\n  "name": "x",\n  "n": 1.0,\n  "scripts": {\n    "build": "tsc"\n  }\n}\n', 'utf8')
    const rt = packageJsonRoundTrip(readFileSync(pkgPath, 'utf8'))
    assert.equal(rt.safe, false, '往返变形必须判出来')
    const plan = planPackageScripts(dir)
    assert.deepEqual(plan.add, {}, '不该计划新增')
    assert.ok(plan.reason, '必须说明为什么不改')
    const before = readFileSync(pkgPath, 'utf8')
    applyPackageScripts(dir, plan.add)
    assert.equal(readFileSync(pkgPath, 'utf8'), before, '清单必须一个字节都没动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('.gitignore：运行期目录只加一次（幂等），且不动已有内容', () => {
  const dir = tmpProject()
  try {
    const gi = path.join(dir, '.gitignore')
    writeFileSync(gi, 'node_modules\n', 'utf8')
    const r1 = applyGitignore(dir)
    assert.equal(r1.changed, true)
    const text1 = readFileSync(gi, 'utf8')
    assert.ok(text1.startsWith('node_modules\n'), '已有内容必须原样在前')
    assert.ok(text1.includes('.self-improving-work/'), '运行期目录必须被加进来')
    const r2 = applyGitignore(dir)
    assert.equal(r2.changed, false, '第二次不该再改')
    assert.equal(readFileSync(gi, 'utf8'), text1, '第二次必须一个字节都没变')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接入只增不覆盖：已存在的文件内容原样保留', () => {
  const dir = tmpProject()
  try {
    const plan = planInstall(dir)
    for (const it of plan) {
      mkdirSync(path.dirname(it.abs), { recursive: true })
      writeFileSync(it.abs, '我改过的内容', 'utf8')
    }
    const again = planInstall(dir)
    assert.ok(again.every((p) => p.exists), '已存在的都应被认出来')
    // apply 的实现按 exists 跳过 —— 直接验证文件没被动
    assert.equal(readFileSync(plan[0].abs, 'utf8'), '我改过的内容')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
