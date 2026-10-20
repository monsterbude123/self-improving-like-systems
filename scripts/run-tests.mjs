#!/usr/bin/env node
/**
 * run-tests.mjs —— 协议层判据的唯一入口
 *
 * 为什么不让接入方各写一条 `node --test tests/*.test.mjs`：
 *   ① **路径归属**。原形态（接入项目的 `package.json` 里直接写死「协议层在某个仓库的某个子目录」）
 *      在协议层独立成仓、或被 clone 到全局时，那条命令指向不存在的路径 —— 而 npm 脚本失败
 *      常被 CI 当成「不稳定」跳过，于是**静默失去全部回归保护**（本轮诊断的 B 点）。
 *      接入方的判据入口应该指向**协议层自己提供的这个脚本**，协议层挪了位置，
 *      需要改的是它自己的 README，不是每一个接入方。
 *   ② **口径统一**。glob 展开方式、退出码、汇总行的读法只有一份，五个接入项目不会跑出五种结果。
 *
 * 三条纪律：
 *   · **按自身位置定位 `tests/`**（`import.meta.url`），不按 cwd —— 在项目根跑和在 `/tmp` 跑必须同结果。
 *   · **找不到 `tests/` 即 exit 2**（用法错误），**绝不静默通过**。那正是 B 点的更隐蔽形态：
 *     一个永远 exit 0 的「自检」，比没有自检更坏 —— 它让人以为判据在跑。
 *   · **透传 TAP 汇总与退出码**，不自己包装摘要（自己算一遍就得维护第二套计数口径）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 协议层根 = 本文件所在目录的上一级（run-tests.mjs 住在 scripts/ 下）。 */
export const PROTOCOL_ROOT = path.resolve(HERE, '..')
export const TESTS_DIR = path.join(PROTOCOL_ROOT, 'tests')

/**
 * 列出测试文件（按名排序，让 TAP 顺序与文件顺序都稳定 —— 不稳定的顺序让「哪条先红」变得不可复现）。
 * @returns {string[]} 绝对路径
 * @throws {Error} tests/ 不存在或一个测试文件都没有
 */
export function listTestFiles(testsDir = TESTS_DIR) {
  if (!existsSync(testsDir)) {
    throw new Error(`找不到测试目录：${testsDir} —— 协议层不完整（clone 未完成？），重装后再试`)
  }
  const files = readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join(testsDir, f))
  if (!files.length) {
    throw new Error(`测试目录里没有任何 *.test.mjs：${testsDir} —— 这不是「通过」，是「没跑」`)
  }
  return files
}

/**
 * 跑全套判据。stdio 直通，TAP 汇总与退出码由 node --test 原样产出。
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd] 子进程工作目录（默认协议层根）
 * @param {string[]} [opts.files] 跑哪些测试文件（默认 `listTestFiles()` 全套）。
 *   存在的理由不是「给测试开后门」：`tests/self-check-hygiene.test.mjs` 需要用**同一套派发路径**
 *   跑一个探针，才能证明隔离对真实调用链成立；自己另写一条 spawnSync 就等于把判据分成两份口径。
 * @param {Array<'inherit'|'pipe'|'ignore'>} [opts.stdio] 子进程 stdio（默认 inherit = 原样透传 TAP）。
 *   嵌在 `node --test` 里跑时必须传 'pipe'：子进程的 TAP 原始行混进父 TAP 流会扰乱汇总解析。
 * @param {Record<string,string>} [opts.env] 追加/覆盖的子进程环境变量（用于把子进程的 tmpdir 指向受控目录）。
 * @returns {number} 退出码
 */
export function runAll(opts = {}) {
  const files = opts.files ?? listTestFiles()
  const env = { ...process.env, ...(opts.env || {}) }
  // 本脚本自己可能是在 `node --test` 里被调起（T3 的端到端验收、自检污染检查都这么干）。
  // 该变量存在时子进程会**静默跳过整个文件并 exit 0** —— 那正是「自检永远绿」的形态：
  // 断言只看退出码就完全失效，必须剥掉，并且 stdout 必须真有 TAP 汇总可查。
  delete env.NODE_TEST_CONTEXT

  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: opts.cwd ?? PROTOCOL_ROOT,
    stdio: opts.stdio ?? 'inherit',
    env,
  })
  if (r.error) {
    console.error(`[run-tests] 无法拉起 node --test：${r.error.message}`)
    return 2
  }
  return r.status === null ? 2 : r.status
}

export function main(argv) {
  const unknown = argv.filter((a) => !a.startsWith('--'))
  if (unknown.length) return usage(`本命令不接受位置参数（收到 ${unknown.join(', ')}）`)
  if (argv.includes('--help') || argv.includes('-h')) return usage('')
  let files
  try {
    files = listTestFiles()
  } catch (e) {
    console.error(`[run-tests] ${e.message}`)
    return 2
  }
  console.log(`[run-tests] 协议层 ${PROTOCOL_ROOT}`)
  console.log(`[run-tests] ${files.length} 个测试文件（cwd 无关：按本文件位置定位）`)
  return runAll()
}

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}`)
  console.error(`用法：node run-tests.mjs
  跑全套协议层判据（TAP 汇总与退出码原样透传）
  退出码：0=全绿 / 非 0=有失败或用例未跑完 / 2=协议层不完整（找不到 tests/）`)
  return msg ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
