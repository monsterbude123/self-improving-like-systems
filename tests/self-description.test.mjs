/**
 * 自描述守卫 —— 协议仓根 `AGENTS.md` 的关键事实不许被悄悄删掉。
 *
 * 存在理由（2026-10-21）：协议层独立成仓后，接盘的人（别人、或换了会话的我自己）
 * 打开的第一个文件是 `AGENTS.md`。它回答「这是什么、判据从哪跑、改动红线是什么、怎么发版」。
 * 只要这几条里少了任何一条，读者就会卡在一个**本该一分钟解决**的问题上
 * ——「判据怎么跑」「npm 包叫什么」「发版前要断言什么」。
 *
 * 而纯散文是守不住的：`AGENTS.md` 是一份会被顺手编辑的 markdown，
 * 哪天有人「精简一下」把判据入口命令删了，或者把包名换了个写法，
 * 没有任何东西会变红 —— 直到某天有人在一个陌生目录里发现自己不知道该怎么跑判据。
 * 所以这五条事实必须是**机器判据**。
 *
 * 判据是**双向**的，缺一不可：
 *   · 正向：真实的 `AGENTS.md` 必须同时含全部五条；
 *   · 反向：把任意一条**拿掉**或**换名**后，同一套检查必须判红 ——
 *     否则这条事实就是摆设（改到最后总能通过 = 恒绿 = 形同没加）。
 *
 * 与 `tests/no-local-path.test.mjs` 的分工（两个判据刻意不合并）：
 *   · no-local-path —— 分发面不许泄露机器本地绝对路径（扫文档与脚本）
 *   · 本守卫       —— 分发面不许丢掉「怎么维护 / 怎么验 / 怎么发」的关键事实（扫 `AGENTS.md`）
 * 合并的话，本守卫就得自己再实现一遍路径识别 —— 那等于造第二份判据，
 * 而「判据只此一份」正是本仓最硬的一条纪律。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AGENTS = path.join(ROOT, 'AGENTS.md')

/**
 * 五条关键事实。每条给出「怎么认出它」与「怎么破坏它」。
 *
 * `mutate` 必须是**真的**把那条事实从文本里去掉 / 改名，
 * 否则反向断言会因为「变异没生效」而假红 —— 那不是守卫在工作，是测试写错了。
 * 变异后的文本若与原文相同，测试会当场报「变异逻辑坏了」而不是给出误导性的通过。
 */
const FACTS = [
  {
    id: 'criteria-entry',
    label: '判据入口命令',
    // 认它：出现了跑全套判据的那条命令
    re: /node\s+scripts\/run-tests\.mjs/,
    // 破坏：把它换成另一个不存在的脚本名
    mutate: (s) => s.replace(/node\s+scripts\/run-tests\.mjs/g, 'node scripts/run-all-checks.mjs'),
  },
  {
    id: 'github-repo',
    label: 'GitHub 仓库地址',
    re: /https:\/\/github\.com\/monsterbude123\/self-improving-like-systems/,
    // 破坏：换成另一个仓地址（协议内容还留着，但读者会被指到错的地方）
    mutate: (s) => s.replace(/https:\/\/github\.com\/monsterbude123\/self-improving-like-systems/g,
      'https://github.com/monsterbude123/some-other-repo'),
  },
  {
    id: 'npm-package',
    label: 'npm 包名',
    // 认它：包名与「npm」出现在同一行（否则 GitHub 地址里的同名串会误判为已写）
    re: /npm[^\n]*self-improving-like-systems/,
    // 破坏：包名换成别的（npm 上没有这个名字 ⇒ 按它装会失败）
    mutate: (s) => s.replace(/npm[^\n]*self-improving-like-systems/g, 'npm 包名：`si-protocol-x`'),
  },
  {
    id: 'zero-coupling',
    label: '零项目耦合禁令',
    re: /零项目耦合/,
    // 破坏：把禁令字样换掉（红线消失 ⇒ 后来者可能把项目名词写进协议）
    mutate: (s) => s.replace(/零项目耦合/g, '通用性要求'),
  },
  {
    id: 'onboard-one-command',
    label: '接入一个项目的标准动作 = 一条命令',
    re: /self-improving-like-systems\s+install\s+--project-dir/,
    // 破坏：把那条一键接入命令改掉 —— 于是后来的 agent 以为「接入 = 手工若干步」，
    // 就会去教人手工做（那份清单会随时间漂移，且没人再维护它）
    mutate: (s) => s.replace(/npx self-improving-like-systems install --project-dir \./, '（删掉的一键接入命令）'),
  },
  {
    id: 'release-flow',
    label: '发版流程（含发布前的一致性断言）',
    // 认它：发布动作与「tag 与 version 必须一致」的断言**都在**（顺序无关 ——
    // 发版步骤的排列顺序是叙述细节，判据要钉住的是「两者都在」这件事）
    res: [/npm\s+publish/, /git\s+describe\s+--tags/],
    // 破坏：把断言那句改掉（失去「两条通道发的是同一份内容」的最后一道闸）
    mutate: (s) => s.replace(/npm\s+publish/g, 'npm 打包上传')
      .replace(/git\s+describe\s+--tags/g, 'git rev-parse HEAD'),
  },
]

/** 文本里缺了哪些关键事实。 */
function missingFacts(content) {
  return FACTS.filter((f) => {
    if (f.res) return !f.res.every((re) => re.test(content))
    return !f.re.test(content)
  }).map((f) => f.id)
}

describe('协议仓自描述：AGENTS.md 的关键事实不许消失', () => {
  it('AGENTS.md 存在', () => {
    assert.ok(existsSync(AGENTS), `协议仓根缺 AGENTS.md：${AGENTS}`)
  })

  it('关键事实齐全（判据入口 / GitHub 地址 / npm 包名 / 零耦合禁令 / 一键接入 / 发版流程）', () => {
    const content = readFileSync(AGENTS, 'utf8')
    const missing = missingFacts(content)
    assert.equal(missing.length, 0,
      `AGENTS.md 缺这些关键事实：${missing.join('、')} —— 读者会在这些点上卡住`)
  })

  it('破坏测试自检：把任意一条事实换掉后必须判红（防守卫恒绿）', () => {
    const content = readFileSync(AGENTS, 'utf8')
    for (const f of FACTS) {
      const mutated = f.mutate(content)
      assert.notEqual(mutated, content,
        `事实「${f.label}」的破坏变异没生效 —— 变异逻辑本身坏了，这条断言会在给假红`)
      const missing = missingFacts(mutated)
      assert.ok(missing.includes(f.id),
        `把「${f.label}」换掉后判据仍然通过 ⇒ 这条事实形同没钉住`)
    }
  })

  it('反向对照：真实文本必须通过（变异逻辑没把文件改坏）', () => {
    const content = readFileSync(AGENTS, 'utf8')
    assert.equal(missingFacts(content).length, 0, '真实 AGENTS.md 反而缺事实 —— 与上面那条矛盾，先查文件')
  })

  it('AGENTS.md 不写协议正文（只留指针行，避免造第二份事实源）', () => {
    const content = readFileSync(AGENTS, 'utf8')
    // 四实体契约的完整定义在 references/schema.md；AGENTS.md 若自己抄一份，
    // 两份必然漂移 —— 而漂移的那份没人知道该信谁。
    assert.ok(!/##\s*四实体契约(全文|：)/.test(content),
      'AGENTS.md 不得承载四实体契约正文（那属于 references/schema.md）')
    assert.ok(content.includes('references/schema.md'),
      'AGENTS.md 必须指向协议正文所在的 references/schema.md')
  })
})
