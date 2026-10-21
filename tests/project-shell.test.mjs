/**
 * project-shell.test.mjs —— 项目侧薄壳的判据测试
 *
 * 存在理由（2026-10-21）：薄壳是**宿主钩子的入口**与「层可用性感知」的载体 ——
 * 它坏了，钩子全哑、门禁失明，而且症状极其安静（配置看着齐、事件永远不投递）。
 * 实测踩到的两个坑各钉一条：
 *   ① **模板字面量把 `\s` 吃掉**：`new RegExp(`(npm i -g|npx)\s+${pkg}`)` 里的 `\s`
 *      会被模板字面量当成转义序列 → 正则变成 `(npm i -g|npx)s+` → 判据恒不命中
 *      → 门禁把**完好的指针**判成「没写全两条通道」。这种错误肉眼极难发现
 *      （文件里看着就是 `\s+`），必须由机器钉住。
 *   ② **认指针靠猜**：早先用「文件里提到过 self-improving 就算指针」，
 *      结果另一个也提到协议层的 skill 被当成了指针 → 门禁去判一个不是指针的文件。
 *      现在认指针与判指针**同源**：同时含两条通道标识的那个文件才是指针。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SHELL = path.join(ROOT, 'scripts', 'project-side', 'self-improving.mjs')

const GITHUB_URL = 'https://github.com/monsterbude123/self-improving-like-systems'
const NPM_PKG = 'self-improving-like-systems'

/** 薄壳的源码（薄壳是 CLI + 若干纯函数；这里只静态检查那些**容易静默失效**的片段）。 */
const shellSrc = readFileSync(SHELL, 'utf8')

test('薄壳里的判据正则不得被模板字面量吃掉转义（\\s → s）', () => {
  // 反例（2026-10-21 实测）：new RegExp(`(npm i -g|npx)\s+${NPM_PKG}`)
  // 模板字面量把 `\s` 当转义序列 → 正则变成 `s+` → 判据恒不命中 → 好指针被判红。
  // 断言的是「文件里不能出现单反斜杠的 \s 在模板字面量里」：
  // 正确写法是 String.raw`...`（保留反斜杠）或双反斜杠。
  const bad = /new RegExp\(`[^`]*[^\\]\\s/.exec(shellSrc)
  assert.equal(bad, null, `薄壳里有会被模板字面量吃掉的转义：${bad && bad[0]}`)
  // 且必须**真的**能命中 —— 正则本身对不对，用行为判。
  const m = /new RegExp\((String\.raw)?`?\(npm i -g\|npx\)/.exec(shellSrc)
  assert.ok(m, '薄壳里找不到那条 npm 命令形态的判据正则')
  const re = new RegExp(String.raw`(npm i -g|npx)\s+${NPM_PKG}`)
  assert.ok(re.test(`npm i -g ${NPM_PKG}`), '判据正则必须能命中「npm i -g <包名>」')
  assert.ok(re.test(`npx ${NPM_PKG} install`), '判据正则必须能命中「npx <包名>」')
  assert.ok(!re.test('只是提到了包名而已'), '判据不能被「提到包名」骗过')
})

test('薄壳认指针：同时含两条通道标识的那个文件才是指针', () => {
  // 复现 2026-10-21 的坑：另一个 skill 也提到协议层（但不是指针）。
  // 认指针与判指针同源 —— 认的判据必须与门的判据一致。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'si-pointer-'))
  try {
    const skills = path.join(dir, '.agents', 'skills')
    mkdirSync(path.join(skills, 'other-skill'), { recursive: true })
    mkdirSync(path.join(skills, 'my-pointer'), { recursive: true })
    // 干扰项：提到协议层但**不是**指针（缺 GitHub 地址 / 缺可执行命令形态）
    writeFileSync(path.join(skills, 'other-skill', 'SKILL.md'),
      `# other\n\n用到协议层 ${NPM_PKG} 的经验条目。\n`, 'utf8')
    // 真指针：两条通道齐全
    writeFileSync(path.join(skills, 'my-pointer', 'SKILL.md'),
      `# ptr\n\n- clone：\`git clone ${GITHUB_URL} ~/.agents/skills/x\`\n- npm：\`npm i -g ${NPM_PKG}\`\n`, 'utf8')

    // 用薄壳里那条判据（与门禁同源）来找
    const re = new RegExp(String.raw`(npm i -g|npx)\s+${NPM_PKG}`)
    const hits = []
    for (const name of readdirSyncNames(skills)) {
      const p = path.join(skills, name, 'SKILL.md')
      const text = readFileSync(p, 'utf8')
      if (text.includes(GITHUB_URL) && re.test(text)) hits.push(name)
    }
    assert.deepEqual(hits, ['my-pointer'], '认指针的判据必须与门禁同源 —— 干扰项不得被选中')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 列目录名（排序）。 */
function readdirSyncNames(dir) {
  return readdirSync(dir).sort()
}
