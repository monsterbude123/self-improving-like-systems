/**
 * portability.test.mjs —— 位置假设守卫（协议层「换个地方还能不能跑」的机器判据）
 *
 * 存在理由（2026-10-19 实测）：协议层从「业务仓内的一个目录」升格为独立仓 + 全局 clone 后，
 * 把 `tests/` 整目录复制到 /tmp 跑 `node --test`，结果是 `# pass 334 / # fail 8 / # skipped 5`
 * （本仓内同一份代码是 347/0/0）。根因不是协议有 bug，而是**测试层有四处位置假设**：
 * 协议层被写死成「位于 <repo>/.agents/skills/<name>/、上溯若干级即某个业务仓根」，
 * 或者按 cwd 解析部署路径。这类假设的共同特征是：**在它被写下的那个布局里永远绿**，
 * 一旦换个布局就静默指向不存在的目录 —— 比断言写错更难查。
 *
 * 本守卫与 `approve.test.mjs` 的「通用性（零项目耦合）」是**两个不同判据**，刻意不合并：
 *   · 零项目耦合 = 不许出现某个业务仓的项目物词表，词表正本 = `lib/coupling-scan.mjs`，扫 `scripts/` + `tests/`
 *   · 本守卫     = 不许依赖部署位置（多级上溯 / 层级截断 / 写死部署路径），扫 `tests/`
 * `tests/` 里**合法**存在项目物词（词表正本本身、历史路径记录），
 * 所以两个词表互相套用必然假红 —— 这是把它们分成两判据的直接理由，不是风格偏好。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')

/**
 * 显式豁免台账。每一项必须写清**为什么这条不是位置假设**，并声明该文件里被豁免形态的**出现次数** ——
 * 次数对不上即判红。这样豁免是「这条字符串是样本数据」的可审计声明，而不是整文件放行；
 * 日后再有人往同一文件里加第二处写死的部署路径，台账立刻失配。
 *
 * 正则无法区分「测试拿这个路径定位协议层」（违规）与「测试构造一条长得这样的配置样本」
 * （合法）：两者的字面形态完全一样，差别只在意图。这种意图差异只能显式声明，不能靠猜。
 */
const ALLOWLIST = [
  {
    file: 'hook-install.test.mjs',
    occurrences: 1,
    reason:
      '宿主配置样本：这条刻意构造 `${ZCODE_PROJECT_DIR}/.agents/skills/self-improving-like-systems/scripts/capture.mjs` ' +
      '形态，用于覆盖体检器「路径含 ${} 则不判存在性」那条分支。它是喂给 doctorConfig 的样本数据，' +
      '不是测试用来定位协议层自身的路径 —— 后者已被本文件顶部的 SCRIPTS 常量按 import.meta.url 解析替代。',
  },
]

/**
 * 排除两类文件，否则守卫必然自指而恒红：
 *   ① 本文件 —— 它以正则与样本字符串的形态**持有**全部被禁形态；
 *   ② `lib/` 词法辅助件 —— 它是判据的实现，不是被判定的对象。
 * 这不是放水：被禁形态在测试里只能以「定义判据」或「做反例对照」两种合法理由出现，
 * 而这两种理由都只发生在上面这两个文件里。
 */
const EXEMPT = new Set(['portability.test.mjs'])

/**
 * 被禁的位置假设形态。四条各自对应实测中的一类真实写法。
 * 判据按「可区分的最小形态」写，不按「看起来像」写 —— 例如负索引切片本身是合法写法
 * （`arr.slice(0, -1)` 裁掉末位），只有「先按分隔符 split 再丢掉末尾若干段」才是层级截断。
 * 守卫一旦恒红就等于没有，所以宁可漏到人工 review 也不误伤。
 */
const LOCATION_ASSUMPTIONS = [
  // ① 多级上溯定位「仓库根」：path.resolve(SKILL_ROOT, '..', '..', '..')
  //    要求**连续两个及以上** '..'；单级上溯（path.resolve(HERE, '..')）是正常的。
  { name: '多级上溯定位仓库根', re: /\.resolve\(\s*[^)]*['"]\.\.\s*['"]\s*,\s*['"]\.\.\s*['"]/ },
  // ② 按层级数截断路径：SKILL_ROOT.split(/[\\/]/).slice(0, -4)
  //    必须紧跟在 split 之后 —— 否则 `arr.slice(0, -1)` 这类常规切片会被误判。
  { name: '按层级数截断路径', re: /\.split\([^)]*\)\s*\.slice\(\s*0\s*,\s*-\s*\d+\s*\)/ },
  // ③ 写死的技能部署路径字面量：'<repo>/.agents/skills/self-improving-like-systems/...'
  { name: '写死的技能部署路径字面量', re: /\.agents\/skills\/self-improving-like-systems/ },
  // ④ 按 cwd 解析部署路径：path.resolve('.agents/skills/.../scripts')
  { name: '按 cwd 解析的部署路径', re: /path\.resolve\(\s*['"]\.agents\// },
]

/** 列出扫描面（tests/ 下的 *.test.mjs，排除豁免项）。 */
function scanSurface() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.mjs') && !EXEMPT.has(f))
    .sort()
}

/** 对一段源码判命中（先剥注释：注释里说明「此前此处写死了 X」不该让门禁变红）。 */
function hitsIn(src) {
  const code = stripComments(src)
  return LOCATION_ASSUMPTIONS.filter(({ re }) => re.test(code)).map(({ name }) => name)
}

describe('位置假设守卫', () => {
  it('扫描面非空（枚举整个 tests/*.test.mjs，新增测试默认进扫描面）', () => {
    const files = scanSurface()
    assert.ok(files.length >= 15, `扫描面异常：只枚举到 ${files.length} 个测试文件（应覆盖 tests/ 下的全部用例，新增测试默认进面）`)
    assert.ok(files.includes('validate.test.mjs'), '扫描面必须含 validate.test.mjs')
    assert.ok(files.includes('hook-install.test.mjs'), '扫描面必须含 hook-install.test.mjs')
  })

  it('tests/ 下不存在位置假设（剥注释后判命中；豁免须命中台账声明的次数）', () => {
    for (const f of scanSurface()) {
      const src = readFileSync(path.join(HERE, f), 'utf8')
      const hits = hitsIn(src)
      const allowance = ALLOWLIST.find((a) => a.file === f)
      if (!allowance) {
        assert.equal(hits.length, 0, `${f} 命中位置假设：${hits.join('、')}（注释已剥离 ⇒ 这是可执行代码或字符串字面量）`)
        continue
      }
      // 豁免项：不是「整文件放行」，而是「命中数必须与台账声明一致」——
      // 日后再加第二处写死路径，台账立刻失配并判红。
      assert.equal(hits.length, allowance.occurrences,
        `${f} 命中数 ${hits.length} 与豁免台账声明的 ${allowance.occurrences} 不符：要么该行被删了（台账该收窄），` +
        `要么新增了位置假设（台账该被推翻）。当前命中：${hits.join('、')}`)
    }
  })

  it('豁免台账每条都有理由，且不得指向不在扫描面内的文件', () => {
    const surface = new Set(scanSurface())
    for (const a of ALLOWLIST) {
      assert.ok(a.reason && a.reason.length > 30, `${a.file} 的豁免理由过短，须写清「为什么这不是位置假设」`)
      assert.ok(surface.has(a.file), `豁免台账指向 ${a.file}，但它不在扫描面内（文件已改名或删除？）—— 台账该清理`)
    }
  })

  it('破坏测试自检：注入的位置假设必须被命中（防守卫恒绿）', () => {
    // 正例：四种形态各一段，全部必须被抓到
    const samples = [
      "const R = path.resolve(SKILL_ROOT, '..', '..', '..')",
      'const R = p.split(/[\\\\/]/).slice(0, -4).join(1)',
      "const d = r + '/.agents/skills/self-improving-like-systems/scripts'",
      "const S = path.resolve('.agents/skills/self-improving-like-systems/scripts')",
    ]
    for (const s of samples) {
      assert.ok(hitsIn(s).length > 0, `注入的位置假设未被命中，守卫已恒绿: ${s}`)
    }
  })

  it('反向对照：合法写法不得被误判（防守卫恒红）', () => {
    const clean = [
      'const SKILL_ROOT = path.resolve(HERE, "..")',
      "const S = path.join(SKILL_ROOT, 'scripts', 'validate.mjs')",
      // 按本文件位置解析，与部署位置无关 —— 这才是正确形态
      "const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')",
      // 负索引切片本身合法：裁掉末位，不是层级截断
      'const last = arr.slice(0, -1)',
      // 注释里写死「此前此处写死了本仓路径」不该让门禁变红
      "// 历史上这里写过 .agents/skills/self-improving-like-systems/ 的硬编码，已删除",
      '/* 块注释里出现 a.split(/[\\\\/]/).slice(0, -4) 同理不算 */',
    ]
    for (const s of clean) {
      assert.equal(hitsIn(s).length, 0, `合法写法被误判: ${s}`)
    }
  })

  it('真实 cwd 无关性：以临时目录为 cwd 跑一遍最吃位置假设的用例（退出码 0 且真的跑了）', () => {
    // 上面的扫描只判「代码里有没有这种写法」，判不了「换个 cwd 还能不能跑」。
    // 这条用一次真实子进程把它兜住：validate.test.mjs 历史上正是位置假设最密集的一处。
    //
    // ⚠ 必须剥掉 NODE_TEST_CONTEXT（2026-10-19 实测）：父进程被 `node --test` 包裹时该变量已存在，
    // 子进程继承它会走「递归调用 run()」分支 —— **静默跳过整个测试文件**，退出码仍是 0、stdout 空。
    // 于是 `assert.equal(status, 0)` 会通过而测试从未执行：空转的守卫比没有守卫更坏。
    // 故下面同时断言「退出码 0」与「stdout 真的产出了 TAP 汇总」。
    const cwd = mkdtempSync(path.join(tmpdir(), 'si-portability-cwd-'))
    try {
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const r = spawnSync(process.execPath, ['--test', path.join(HERE, 'validate.test.mjs')], {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        env,
      })
      assert.equal(r.status, 0, `以外部 cwd 运行时失败：\n${r.stdout}${r.stderr}`)
      assert.match(r.stdout, /# tests \d+/, `子进程没真正跑测试（空 stdout ⇒ 多半是 NODE_TEST_CONTEXT 未剥净）:\n${r.stderr}`)
      assert.match(r.stdout, /# fail 0/, `以外部 cwd 运行时出现失败用例:\n${r.stdout}`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
