/**
 * check-release.test.mjs —— 发版前两道闸的判据测试
 *
 * 存在理由（2026-10-21 实测踩到）：协议层有两条分发通道（GitHub clone / npm），
 * 「两条通道发的是同一份内容」这件事**不能靠自觉** ——
 * 它的失效形态极其安静：两边都「能装」都能跑，没有任何报错，只是内容悄悄分叉。
 *
 * 两道闸各钉一个失效形态：
 *   ① **版本一致**：tag == package.json 的 version（第一道闸，2026-10-21 加）。
 *   ② **逐字节一致**：工作区 == tag（第二道闸，2026-10-21 加）——
 *      `npm pack` 打包的是**工作区**而不是 git 对象，工作区行尾被宿主改写成 CRLF 时
 *      （Windows 上写文件默认 CRLF），包里的内容与 tag 不再逐字节相同。
 *      实测 0.1.2 首次发布时 9 个文件就是这样分叉的，而**没有任何判据报红**。
 *
 * 形态纪律：每条断言都必须能被注入的错误打红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CHECK = path.join(ROOT, 'scripts', 'check-release.mjs')

/** 在临时仓里造一个「已提交 + 已打 tag」的状态，用来跑真实的发版闸。 */
function tmpRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'si-release-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  g('init', '-q', '.')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
  g('add', '-A')
  g('commit', '-qm', 'init')
  g('tag', 'v1.2.3')
  return dir
}

function runCheck(dir) {
  // --root 让判据能对着别的仓跑 —— 判据写在别人仓里跑不动，测不了就等于没有判据
  const r = spawnSync(process.execPath, [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

test('版本与 tag 一致 → 放行', () => {
  const dir = tmpRepo()
  try {
    const r = runCheck(dir)
    assert.equal(r.status, 0, `应放行：\n${r.out}`)
    assert.match(r.out, /版本一致/, '要如实报告：\n' + r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('破坏测试：version 与 tag 不一致 → 必须拦下（不得发布出去）', () => {
  const dir = tmpRepo()
  try {
    const pkgPath = path.join(dir, 'package.json')
    writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '9.9.9' }, null, 2) + '\n', 'utf8')
    const r = runCheck(dir)
    assert.notEqual(r.status, 0, '版本不一致必须拦下')
    assert.match(r.out, /版本不一致/, '要说清是版本不一致：\n' + r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('破坏测试：工作区行尾被改成 CRLF → 必须拦下（两条通道发的就不是同一份内容了）', () => {
  // 这一条是 2026-10-21 实测踩到的那一类：Windows 上写文件默认 CRLF，
  // 工作区被改写而 git 对象仍是 LF ⇒ npm 包与 tag 不再逐字节一致。
  const dir = tmpRepo()
  try {
    // 漂移必须落在**会被 npm 打包**的文件上（package.json 在打包集里）——
    // 不在打包集的文件漂了也到不了 npm，那不是这条闸要管的事。
    writeFileSync(path.join(dir, 'package.json'), '{\r\n  "name": "x",\r\n  "version": "1.2.3"\r\n}\r\n', 'utf8')
    const r = runCheck(dir)
    assert.notEqual(r.status, 0, '行尾漂移必须拦下')
    assert.match(r.out, /不逐字节一致/, '要说清是字节不一致：\n' + r.out)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('本仓当前状态：工作区与最新 tag 逐字节一致（发版前自己先过一遍）', () => {
  const r = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' })
  // 本仓的 tag 由发版流程打；在 tag 打好之前跑这道断言没有意义 —— 只在有 tag 时断言。
  const hasTag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' }).status === 0
  if (!hasTag) return
  assert.equal(r.status, 0, `本仓工作区与 tag 不一致，发版会被拦下：\n${r.stdout}${r.stderr}`)
})

test('闸门只读：跑它不会改动任何文件', () => {
  const dir = tmpRepo()
  try {
    const before = readFileSync(path.join(dir, 'package.json'), 'utf8')
    runCheck(dir)
    assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8'), before, '发版闸不得改文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
