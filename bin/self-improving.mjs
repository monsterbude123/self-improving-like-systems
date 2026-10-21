#!/usr/bin/env node
/**
 * self-improving.mjs —— npm 通道的**分发器**（唯一职责：把子命令转发到既有脚本）
 *
 * 为什么只做转发，不写逻辑：
 *   协议层最硬的一条纪律是「判据只此一份」。分发器里若出现任何业务判断
 *   （怎么算合规、怎么写条目、怎么判失败），就等于**造了第二个事实源** ——
 *   而两份必然漂移，且没人知道该信谁。npm 通道的职责只是「让命令能被找到并跑起来」，
 *   真正干活的一直是 `scripts/*.mjs`（那份代码 clone 与 npm 装到的是同一份）。
 *
 * 「同一份内容」的技术保证：npm 包从 git tag 发布，发布前断言
 * `git describe --tags` == `package.json` 的 `version`（见 `scripts/check-release.mjs`）。
 * GitHub 与 npm 同 tag ⇒ 同一份内容。
 *
 * 两条通道**不共存**：同一台机器上 `~/.agents/skills/self-improving-like-systems`
 * 只能是 clone 副本或 npm 副本其中之一。npm 副本**没有 git 历史**，不要 `git pull`。
 *
 * 零依赖：不引任何三方包，只用 node 内置。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 协议层根 = 本文件所在目录的上一级（bin/ 在根下）。 */
const ROOT = path.resolve(HERE, '..')

/**
 * 子命令 → 脚本的映射表。
 * 每个条目声明「脚本」与「转发前要补的参数」——
 * 补参数只做**参数搬运**（如 doctor = hook-install + --doctor），不做任何判断。
 */
const COMMANDS = {
  'self-test': { script: 'run-tests.mjs', desc: '跑全套判据（唯一入口，cwd 无关）' },
  'test': { script: 'run-tests.mjs', desc: '同 self-test' },
  init: { script: 'init.mjs', desc: '给项目铺一份最小可用实例（--project-dir <目录> [--apply]）' },
  install: { script: 'install-project.mjs', desc: '**一条命令接入本项目**（配置+薄壳+指针+钩子+gitignore+清单）' },
  'collect-logs': { script: 'collect-logs.mjs', desc: '把运行期日志采到用户目录，供维护 agent 分析' },
  doctor: { script: 'hook-install.mjs', desc: '接线体检（--project-dir <目录>）', prepend: ['--doctor'] },
  'hook-install': { script: 'hook-install.mjs', desc: '接线片段 / 体检 / 落盘（--apply）' },
  validate: { script: 'validate.mjs', desc: '校验条目 / 配置 / 注册表（<file...> 或 --all）' },
  capture: { script: 'capture.mjs', desc: '捕获一次失效事件（--source / --kind / --text ...）' },
  'run-guard': { script: 'run-guard.mjs', desc: '派发守卫（--key <key> 或 --all）' },
  inject: { script: 'inject.mjs', desc: '注入相关经验到上下文（--scope <域>）' },
  distill: { script: 'distill.mjs', desc: '从事件库蒸馏提案（草案只落暂存区）' },
  approve: { script: 'approve.mjs', desc: '批准 / 驳回蒸馏草案' },
  trace: { script: 'trace.mjs', desc: '回放一次失效的全过程' },
  migrate: { script: 'migrate-legacy.mjs', desc: '迁移旧版条目格式' },
  'log-query': { script: 'log-query.mjs', desc: '查运行时日志' },
  'check-release': { script: 'check-release.mjs', desc: '发版前断言：tag == version（两条通道发的是同一份）' },
}

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}\n`)
  console.error(`self-improving-like-systems —— 通用经验/自进化系统协议层

用法：
  npx self-improving-like-systems <子命令> [参数...]

子命令：
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(14)}${v.desc}`).join('\n')}

常用：
  npx self-improving-like-systems self-test
  npx self-improving-like-systems install --project-dir . --apply
  npx self-improving-like-systems collect-logs --project-dir . --apply

说明：
  · 协议层本体在 GitHub：https://github.com/monsterbude123/self-improving-like-systems
  · npm 副本**没有 git 历史**，更新走 \`npm i -g self-improving-like-systems\`，不要 git pull
  · 两条通道不共存：~/.agents/skills/self-improving-like-systems 只能是其中一种`)
  return 2
}

/** 把子命令映射到脚本路径。 */
function resolveScript(name) {
  const spec = COMMANDS[name]
  if (!spec) return null
  const p = path.join(ROOT, 'scripts', spec.script)
  if (!existsSync(p)) {
    console.error(`[self-improving] 协议层不完整：找不到 scripts/${spec.script} —— 重装后再试`)
    process.exit(2)
  }
  return { spec, p }
}

function main(argv) {
  if (argv.length === 0) return usage('')
  const [cmd, ...rest] = argv
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return usage('')

  const resolved = resolveScript(cmd)
  if (!resolved) return usage(`未知子命令 ${cmd}`)
  const { spec, p } = resolved

  // 转发：只补参数，不加工、不判断、不吞错误码。
  const childArgs = [...(spec.prepend || []), ...rest]
  const res = spawnSync(process.execPath, [p, ...childArgs], { stdio: 'inherit' })
  if (res.error) {
    console.error(`[self-improving] 启动 ${spec.script} 失败：${res.error.message}`)
    return 2
  }
  // 透传退出码：被调脚本的 0/1/2 语义（合规/违规/用法错误）必须原样传出去。
  return typeof res.status === 'number' ? res.status : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
