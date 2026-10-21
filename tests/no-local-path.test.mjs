/**
 * no-local-path.test.mjs —— 分发面「本地路径禁入」守卫
 *
 * 存在理由（2026-10-19）：协议层独立成仓并推上 GitHub 之后，它的读者是**别人**。
 * 一旦文档或脚本里留下形如 `D:/workspace/...` 的本机绝对路径，拿到的同事照着做就会失败，
 * 而失败点在他自己的机器上 —— 排查成本全落在接盘的人身上。
 *
 * 与 `portability.test.mjs` 的分工（两个判据刻意不合并）：
 *   · portability —— 「代码是否依赖自己被装在哪」（位置假设，扫 tests/）
 *   · 本守卫      —— 「写给别人的文字/配置里是否泄露了某台机器的磁盘布局」（扫文档与脚本）
 *
 * ⚠️ `tests/` **整体不扫**，这是刻意的：`tests/fixtures/` 与若干用例里刻意写着
 * `D:/workspace/x`、`C:/Users/x/log.txt`、`example-repo` 这类**长得像真路径的合成样本** ——
 * 它们是路径归一化与脱敏逻辑的输入，改成真路径或删掉都等于删掉覆盖。
 * 把它们纳入扫描面必然假红，而一个恒红的守卫会被关掉，比没有守卫更坏。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * 扫描面：根级文档（含 `AGENTS.md` —— 2026-10-21 起它是接盘者打开的第一个文件，
 * 同样写给「别人」，同样不许泄露某台机器的盘符）+ references/ 与 scripts/ 下的文档、配置与脚本。
 * tests/ 不在其中。
 */
const SCAN_EXT = new Set(['.md', '.json', '.yaml', '.yml', '.mjs'])
const ROOT_DOCS = ['README.md', 'SKILL.md', 'AGENTS.md']
const SCAN_DIRS = ['references', 'scripts']

/**
 * 机器本地绝对路径的两种常见形态。
 *
 * 刻意**放行** `C:/Users/<user>/...` 这种带尖括号占位符的写法 —— 它是给读者的示意，
 * 不是任何一台机器的真实路径。判据要求 `Users/` 之后紧跟一个**非占位符**字符。
 */
const LOCAL_PATH_PATTERNS = [
  { name: 'Windows 用户目录绝对路径', re: /[A-Za-z]:[\\/]Users[\\/][^/<"'`\s]/ },
  { name: '机器本地工作区绝对路径', re: /[A-Za-z]:[\\/]workspace[\\/]/ },
]

/** 递归列出某目录下的扫描面文件。 */
function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (SCAN_EXT.has(path.extname(p))) out.push(p)
    }
  }
  walk(path.join(ROOT, dir))
  return out
}

/** 枚举完整扫描面（相对 ROOT 的 posix 路径）。 */
function scanSurface() {
  const out = []
  for (const f of ROOT_DOCS) if (readdirSync(ROOT).includes(f)) out.push(f)
  for (const d of SCAN_DIRS) for (const p of filesUnder(d)) out.push(path.relative(ROOT, p).split(path.sep).join('/'))
  return out
}

/** 对一段文本判命中。代码类先剥注释 —— 注释里说明「此前此处写死了本机路径」不该让门禁变红。 */
function hitsIn(text, { isCode }) {
  const body = isCode ? stripComments(text) : text
  const out = []
  for (const { name, re } of LOCAL_PATH_PATTERNS) if (re.test(body)) out.push(name)
  return out
}

describe('分发面本地路径禁入', () => {
  it('扫描面非空且覆盖根级文档与两个子目录', () => {
    const surface = scanSurface()
    assert.ok(surface.length >= 20, `扫描面异常：只枚举到 ${surface.length} 个文件（应覆盖 README/SKILL + references + scripts）`)
    for (const must of ['README.md', 'SKILL.md', 'references/schema.md', 'scripts/validate.mjs']) {
      assert.ok(surface.includes(must), `扫描面必须含 ${must}`)
    }
    assert.ok(!surface.some((f) => f.startsWith('tests/')), 'tests/ 按设计不扫（合成夹具长得像真路径正是其作用）')
  })

  it('文档 / 配置 / 脚本里没有机器本地绝对路径', () => {
    for (const f of scanSurface()) {
      const abs = path.join(ROOT, f.split('/').join(path.sep))
      const hits = hitsIn(readFileSync(abs, 'utf8'), { isCode: path.extname(f) === '.mjs' })
      assert.equal(hits.length, 0, `${f} 泄露机器本地路径：${hits.join('、')}`)
    }
  })

  it('破坏测试自检：注入的本地路径必须被命中（防守卫恒绿）', () => {
    for (const sample of [
      'clone 到 D:/workspace/ai-collaborate/whatever',
      '读 C:/Users/septe/.agents/skills/x/SKILL.md',
      '路径 = "C:\\Users\\septe\\AppData\\Local\\Temp"',
    ]) {
      assert.ok(hitsIn(sample, { isCode: false }).length > 0, `注入的本地路径未被命中，守卫已恒绿: ${sample}`)
    }
  })

  it('反向对照：合法写法不得被误判（防守卫恒红）', () => {
    const clean = [
      // 样例里用 <skill-name> 占位，而不是把协议层的真实目录名写死 ——
      // 否则会被同目录的 portability 守卫按「写死的部署路径」拦下（两个守卫各管一面，互不豁免）。
      'git clone https://github.com/monsterbude123/self-improving-like-systems.git ~/.agents/skills/<skill-name>',
      '写到 C:/Users/<user>/AppData/Local/Temp —— 这是给读者的示意，不是本机真实路径',
      "协议层根 = path.join(os.homedir(), '.agents', 'skills', '<skill-name>')",
      '// 注释里出现 D:/workspace/xxx 也不该被判（代码类会先剥注释）',
      'docs 见 ./references/schema.md；仓库 https://github.com/monsterbude123/self-improving-like-systems',
    ]
    for (const s of clean) {
      assert.equal(hitsIn(s, { isCode: s.startsWith('//') }).length, 0, `合法写法被误判: ${s}`)
    }
  })
})
