/**
 * layer-gate.mjs —— 「协议层装没装好 / 项目侧接线对不对」的可复用判据（协议层自带）
 *
 * ## 为什么它住在协议层里
 *
 * 这套判据过去长在**某一个接入项目**的 `scripts/gates/` 下。于是别的项目接协议层时
 * 没有这套判据 —— 「层没装」在那边表现为一片互不相干的 ENOENT，而不是一条说清根因的红。
 * 接入项目要能**感知协议层可用 / 不可用**，这条判据就是「感知」的载体，
 * 所以它必须随协议层一起分发。
 *
 * ## 三条自治判据
 *
 *   ① 仓内副本不许回来（项目内不得 vendor 一份协议层 —— 两份事实源会悄悄分叉）。
 *   ② 层必须**装好**（标记文件在才算；空目录不算）。
 *   ③ 项目侧指针必须写全**两条分发通道**（GitHub 仓地址 + 可执行的 npm 命令形态）——
 *      防的是「换个会话的 agent 根本不知道还有另一条路」。
 *
 * 本文件只出**判据与消息**；怎么跑（pre-commit？CI？手工？）由接入项目自己接。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import {
  LAYER_ENV_VAR,
  LAYER_GITHUB_URL,
  LAYER_MARKER_REL,
  LAYER_NPM_PACKAGE,
  LAYER_REPO_COPY_REL,
  LAYER_RUNTIME_STATE_REL,
  LAYER_SKILL_NAME,
  candidateLayers,
  resolveLayerCandidate,
} from './layer-resolve.mjs'

/**
 * 指针默认位置（接入项目可覆盖）。
 *
 * ⚠️ 默认名**刻意不等于层名**：`.agents/skills/<层名>/` 在判据①里是「仓内副本回来」的判红位置，
 * 指针若落在那儿，会被自己的门禁当成副本回流判红 —— 自己告自己。
 */
export const DEFAULT_POINTER_REL = '.agents/skills/self-improving/SKILL.md'

/**
 * 指针里必须同时出现的两条通道标识。
 *
 * npm 那条刻意要求**可执行的命令形态**（`npm i -g <包名>` 或 `npx <包名>`），
 * 而不是「文本里出现过这个包名」—— 后者太松：指针里任何一行提到包名都算数，
 * 哪怕那行只是路径。判据要钉住的是「读者能直接抄这条命令去用」。
 */
export function pointerRequiredFacts() {
  return [
    { id: 'github', label: 'GitHub 公开仓地址', re: new RegExp(LAYER_GITHUB_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) },
    { id: 'npm', label: 'npm 包名（可执行命令形态）', re: new RegExp(`(npm i -g|npx)\\s+${LAYER_NPM_PACKAGE}`) },
  ]
}

/**
 * 指针缺了哪些通道信息。返回缺失项的 id 数组（空 = 齐全）。
 * 指针文件不存在 → 视为全缺（那比缺通道更严重）。
 * @param {string} repoRoot 项目根
 * @param {string} pointerRel 指针相对路径（POSIX）
 */
export function pointerMissingFacts(repoRoot, pointerRel = DEFAULT_POINTER_REL) {
  const facts = pointerRequiredFacts()
  const p = path.join(repoRoot, ...pointerRel.split('/'))
  if (!existsSync(p)) return facts.map((f) => f.id)
  let text = ''
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return facts.map((f) => f.id)
  }
  return facts.filter((f) => !f.re.test(text)).map((f) => f.id)
}

/**
 * 自治判据 ①：仓内副本回来没有。返回第一个违例**文件**的绝对路径，干净则返回 null。
 *
 * ## 为什么判「文件」而不是判「目录存在」
 *
 * git 删掉被跟踪的副本文件后，会在原地留下运行时日志目录（gitignored 产物）。
 * 于是「目录还在」判红，而它挡掉的不是「有人把副本加回来」，是「这台机器以前跑过旧副本」。
 * 后果：任何跑过旧副本的开发者升级后，**每次提交都被一条与真实问题无关的红挡住**。
 * 这与「层装没装好」的判据是同一条纪律：**残骸不算存在**。
 *
 * 例外只给运行时状态目录（层自己的日志），不做「忽略一切 gitignored 文件」的泛化 ——
 * 那种写法会把「有人 git add 了一份副本进来」一起放过去。
 */
export function repoCopyViolation(rootDir, repoCopyRel = LAYER_REPO_COPY_REL, runtimeStateRel = LAYER_RUNTIME_STATE_REL) {
  const dir = path.join(rootDir, ...repoCopyRel.split('/'))
  if (!existsSync(dir)) return null
  const hit = firstNonRuntimeFile(dir, runtimeStateRel)
  return hit === null ? null : path.join(dir, ...hit.split('/'))
}

/** 目录树里第一个不属于 runtimeState 前缀的文件（相对 POSIX 路径）；没有则 null。 */
function firstNonRuntimeFile(dir, runtimeState) {
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()
    const abs = rel === '' ? dir : path.join(dir, ...rel.split('/'))
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue // 读不动（权限/竞态）：不当违例，也不当干净 —— 交给别的判据
    }
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (child === runtimeState || child.startsWith(`${runtimeState}/`)) continue
      if (e.isDirectory()) stack.push(child)
      else return child
    }
  }
  return null
}

/** 装法提示（两条通道 + 免安装试用），供「层没装」时打印。 */
export function installHints() {
  return [
    '装法（二选一，同一台机器上不共存）：',
    `  1. npm i -g ${LAYER_NPM_PACKAGE}          ← npm 通道（免安装试用；无 git 历史，不要 git pull）`,
    `  2. npm run si:install                   ← clone 通道（接入命令写进清单的脚本形态）`,
    `     或 git clone ${LAYER_GITHUB_URL} ~/.agents/skills/${LAYER_SKILL_NAME}（更新走 git pull）`,
    `     或免安装直接用：npx ${LAYER_NPM_PACKAGE} install --project-dir . --apply`,
    `两条通道发的是同一份内容（协议仓同 tag 发布），但**同一台机器上不共存**。`,
    `或显式指定层位置：set ${LAYER_ENV_VAR}=<层根绝对路径>（Unix 用 export）。`,
  ]
}

/**
 * 跑一遍三条自治判据。
 * @param {{repoRoot:string, pointerRel?:string, opts?:object}} p
 * @returns {{ok:boolean, code:number, lines:string[], kind:string}}
 */
export function runLayerGate(p) {
  const repoRoot = p.repoRoot
  const pointerRel = p.pointerRel ?? DEFAULT_POINTER_REL
  const opts = p.opts ?? {}
  const lines = []
  const fail = (msg) => ({ ok: false, code: 2, lines: [...lines, msg], kind: 'fail' })

  // ① 副本回流：放在安装检查之前 —— 副本回流时层往往是装好的，
  //    若先判安装，这条红会被 PASS 盖掉，等于门禁对最该抓的形态失明。
  const repoCopy = repoCopyViolation(repoRoot)
  if (repoCopy !== null) {
    lines.push(`FAIL: 仓内协议层副本回来了：${repoCopy}`)
    lines.push('')
    lines.push('协议层必须只有一个事实源（仓外安装的层）。仓内副本的存在意味着：')
    lines.push('  · 别人 clone 到本仓拿到的是**过期的判据**，且看不出过期；')
    lines.push('  · 层里修过的 bug 在仓内这份上永远修不到，两边悄悄分叉；')
    lines.push('  · 解析器刻意不把它列为候选，所以它此刻是**死的** —— 一份没人用、也没人删的代码。')
    lines.push('')
    lines.push(`处置：删掉 ${LAYER_REPO_COPY_REL}/ 下的这个文件（连带整份副本）。`)
    lines.push(`      只剩 ${LAYER_RUNTIME_STATE_REL}/logs 这类运行时日志的话不算违规。`)
    lines.push(`      项目专属的接线/配置属于本项目的 scripts/ 与 .self-improving*.yaml，不属于协议正文。`)
    return fail(lines.join('\n'))
  }

  // ③ 指针写全两条通道：放在安装检查**之前** —— 装过了不代表「别的 agent 找得到」。
  const missingFacts = pointerMissingFacts(repoRoot, pointerRel)
  if (missingFacts.length > 0) {
    const facts = pointerRequiredFacts()
    const labels = missingFacts.map((id) => facts.find((f) => f.id === id)?.label ?? id)
    lines.push(`FAIL: 协议层指针没写全分发通道：${labels.join('、')}`)
    lines.push('')
    lines.push(`指针文件 = ${pointerRel}`)
    lines.push('指针是别的 agent 检索「经验系统 / self-improving」时**唯一会读到**的地方。')
    lines.push('它必须同时给出：')
    lines.push('  · GitHub 公开仓地址 —— clone 通道（宿主技能发现走这条，可 git pull 更新）')
    lines.push(`  · npm 包名 ${LAYER_NPM_PACKAGE} —— npm 通道（免安装试用；无 git 历史，不要 git pull）`)
    lines.push('')
    lines.push('少一条的后果不是「文档不全」，是**换个会话的 agent 根本不知道还有另一条路**。')
    lines.push('处置：把缺的那条补进指针文件（只写「在哪、怎么装」，不复述协议正文）。')
    return fail(lines.join('\n'))
  }

  // ② 层装没装好
  const hit = resolveLayerCandidate(opts)
  if (hit !== null) {
    const kind = hit.isNpm ? 'npm 副本' : 'clone 副本'
    lines.push(`PASS: 自改进协议层已就位（${hit.dir}）；${kind}，更新方式 = ${hit.update}；仓内无副本；指针两条通道齐全。`)
    if (hit.isNpm) {
      lines.push(`      注：npm 副本**没有 git 历史**，不要 git pull —— 更新用 ${hit.update}。`)
      lines.push(`      两条通道不共存：~/.agents/skills/${LAYER_SKILL_NAME} 只能是其中一种。`)
    }
    return { ok: true, code: 0, lines, kind: 'pass' }
  }

  lines.push('FAIL: 自改进协议层未安装或安装不完整 —— 依赖它的判据此刻全部不跑。')
  lines.push('已按顺序找过：')
  for (const c of candidateLayers(opts)) {
    const marker = path.join(c.dir, LAYER_MARKER_REL)
    let why = '目录不存在'
    if (existsSync(c.dir)) {
      try {
        if (!statSync(c.dir).isDirectory()) why = '存在但不是目录'
        else if (existsSync(marker)) {
          why = '已安装，但按设计未被选用（env 显式指定优先，装不完整时不回落）'
        } else why = `缺标记文件 ${LAYER_MARKER_REL}`
      } catch {
        why = '读不动（权限或竞态）'
      }
    }
    lines.push(`  · [${c.from}] ${c.dir}  —— ${why}${c.explicit ? '  ← 显式指定，装不完整时不回退到默认位置' : ''}`)
  }
  lines.push(`判据 = 标记文件 ${LAYER_MARKER_REL} 存在（只有空目录不算装好）。`)
  lines.push('')
  if (candidateLayers(opts)[0]?.explicit) {
    lines.push(`注意：${LAYER_ENV_VAR} 已显式指向一个装不完整的层，此时**不会**静默回落到默认位置。`)
    lines.push('      这是刻意的 —— 你以为让提交按这一层判据判红，实际判的是另一层。')
    lines.push('')
  }
  lines.push(...installHints())
  return fail(lines.join('\n'))
}
