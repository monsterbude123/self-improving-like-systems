/**
 * coupling-scan.mjs —— 项目耦合判据的**单一归宿**（零依赖，可被任一测试 import）
 *
 * 存在理由：此前禁用词表在 approve.test.mjs 与 lifecycle.test.mjs 各存一份，且两份不一致
 * （一份少一条）。两份词表 = 两个判据 = 「看哪份」成为自由度，而自由度的方向恰好是漏网。
 * 故词表收敛到本模块，扫描面也一并在这里枚举，测试侧只做断言。
 *
 * 扫描面（repoNounFiles）：
 *   - `tests/*.test.mjs` —— 测试源码本身不得持有项目物（否则断言里写死别人家的仓名，
 *     对外分发等于广播；协议层不知道宿主仓叫什么，它的断言就不该知道）。
 *   - `tests/lib/*.mjs` —— 判据与测试共用件。
 *   - `tests/fixtures/**` —— **只禁 org 层词条**（见 PROJECT_NOUNS 的 tier 字段）。
 *     fixture 是「有问题的样本」本身（错误路径、失败输出），它的职责就是长得像真的报错，
 *     所以**布局类**词条（`.learnings/` 这类通用目录约定）在 fixture 里合法存在；
 *     但**组织专有名词**（某家公司的仓名 / 产品代号 / 内部门禁编号）在 fixture 里毫无正当理由 ——
 *     中性写法（`example-host-repo/...`、`entry-binding-gate.mjs`）完全不削弱测试，
 *     却能避免对外分发时广播出去。两者必须分开判，否则要么放过 org 泄漏，要么逼 fixture
 *     不能包含它要测的路径。
 *   - `scripts/**` 的扫描面仍在 approve.test.mjs（那里同时断言「枚举整个目录」这件事本身）。
 *
 * 判注释一律经共用的 stripComments（「注释里的不算」——否则「修掉硬编码后在注释里说明
 * 『此前此处硬编码了 X』」本身就会让门禁变红，修复动作与守卫互锁，于是没人敢留下解释）。
 * 反过来，**字符串/模板串/正则字面量里的项目物必须保留**：那正是会进用户可见输出的形态。
 *
 * ⚠ 本文件自身以正则字面量 + 字符串字面量持有全部被禁形态，故它必须登记在测试侧的
 *   豁免台账里，且台账声明的是「命中哪几条」（按词条名），不是「命中几次」——
 *   词表增删时台账必须跟着改，这是有意的耦合：改词表忘了改台账就该变红。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './strip-comments.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 禁用词表（两份历史词表的**并集**，含此前只在 approve.test.mjs 里的那一条）。
 * 每条必须写清「为什么它是项目物」—— 没有理由的禁用词迟早被误当成噪音删掉。
 * literal 字段是字面形态，供测试侧构造正/反向样本用（避免测试文件自己复制一份被禁形态）。
 *
 * tier 决定该词条在**哪些扫描面**生效，两层的判据不同、不能用同一把尺：
 *   - `org`    = 组织专有名词（仓名 / 产品代号 / 内部门禁编号 / 内部脚本名）。
 *                **任何**文件都禁，包括 fixtures —— 中性写法不削弱测试，
 *                留着它只是对外广播别人家的内部黑话。
 *   - `layout` = 宿主仓的目录布局约定。代码里禁（写死即位置假设），
 *                但 fixture 里合法（fixture 的职责就是长得像真的报错路径）。
 */
export const PROJECT_NOUNS = [
  // `learning-dir` 的前瞻是刻意的：`.learnings-work` 是**协议层自己的默认目录**
  // （scripts/config.example.yaml 的 logs/ 默认值、scripts/next-id.sh 的 claims 账本都在用它），
  // 把它一并禁掉等于禁掉协议自身的契约，而测试正需要按那个真实默认去跑。
  // 故只禁「条目目录」形态：`.learnings` 后面不接连字符/词字符（`.learnings/`、`.learnings;`、
  // `"$ROOT/.learnings"` 都命中，`.learnings-work` 不命中）。
  { name: 'learning-dir', tier: 'layout', literal: '.learnings', re: /\.learnings(?![-\w])/, why: '原仓经验条目的目录名，属于宿主仓的私有约定（协议自己的 .learnings-work 默认不在此列）' },
  { name: 'repo-name', tier: 'org', literal: 'ai-short-studio', re: /ai-short-studio/, why: '原业务仓仓名片段，等于对外点名某家公司的内部项目' },
  { name: 'product-tag', tier: 'org', literal: 'vvicat', re: /vvicat/i, why: '原仓产品/品牌代号，宿主之外无意义' },
  { name: 'container-form', tier: 'org', literal: 'devbox', re: /devbox/, why: '原仓给容器开发形态起的专名（通用说法是容器形态）' },
  { name: 'gate-file', tier: 'org', literal: 'D13-entry-guard-binding', re: /D13-entry-guard-binding/, why: '原仓某个门禁脚本的文件名，含原仓内部编号前缀' },
  { name: 'build-script', tier: 'org', literal: 'build-host.sh', re: /build-host\.sh/, why: '原仓构建脚本名，含「宿主构建」这一内部约定' },
  { name: 'hook-flag', tier: 'layout', literal: 'touchesLearnings', re: /touchesLearnings/, why: '原仓 hook 安装器的判别标记，绑定原仓目录布局' },
  { name: 'install-dir', tier: 'layout', literal: 'touchesExperienceSystem', re: /touchesExperienceSystem/, why: '原仓安装目录名，与宿主文件系统布局强绑定' },
]

/** org 层词条 = fixture 扫描面的判据（fixture 只需要挡这一层）。 */
export const FIXTURE_FORBIDDEN_NOUNS = PROJECT_NOUNS.filter((n) => n.tier === 'org')

/** 源码 → 命中的词条名数组（去重后按词表顺序；空数组 = 干净）。传 nouns 可换判据层。 */
export function couplingHits(src, nouns = PROJECT_NOUNS) {
  const code = stripComments(String(src))
  return nouns.filter((n) => n.re.test(code)).map((n) => n.name)
}

/** 单个文件 → 命中的词条名数组。传 nouns 可换判据层（fixture 扫描传 org 层）。 */
export function hitsInFile(file, nouns = PROJECT_NOUNS) {
  return couplingHits(readFileSync(file, 'utf8'), nouns)
}

/** 扫描面：`tests/*.test.mjs` + `tests/lib/*.mjs`（不含 fixtures，见文件头注释）。 */
export function repoNounFiles(testsDir = path.resolve(HERE, '..')) {
  const libDir = path.join(testsDir, 'lib')
  return [
    ...readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(testsDir, f)),
    ...readdirSync(libDir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(libDir, f)),
  ]
}

/**
 * fixture 扫描面：`tests/fixtures/` 下的全部文本类文件（递归）。
 *
 * 只挡 org 层词条（见文件头注释的 tier 说明）。这里刻意**不剥注释** ——
 * fixture 不是代码，没有注释语法可言；且 fixture 里的样本行就是要给人看的，
 * 剥了等于把「文档里写着的泄漏」放过。
 * 二进制/图片按扩展名排除，避免读出乱码误判。
 */
const FIXTURE_TEXT_EXT = new Set(['.txt', '.md', '.yaml', '.yml', '.jsonl', '.json', '.csv', '.log'])
export function fixtureNounFiles(testsDir = path.resolve(HERE, '..')) {
  const root = path.join(testsDir, 'fixtures')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && FIXTURE_TEXT_EXT.has(path.extname(d.name).toLowerCase()))
    .map((d) => path.join(d.parentPath ?? d.path, d.name))
    .sort()
}
