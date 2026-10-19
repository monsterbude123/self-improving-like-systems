/**
 * yaml-lite.test.mjs —— 降级 YAML 后端的标量反转义判据
 *
 * 为什么这些用例必须存在：宿主常常**没有** js-yaml（本机就没有），于是全部读路径
 * 走这个零依赖实现。2026-10-20 实测它有个真实数据损坏：双引号标量用四条
 * `.replace()` 顺序替换，`"C:\\nodejs"` 里第二个反斜杠 + `n` 被先当成 `\n`
 * 换成真换行 —— Windows 绝对路径读出来变成两行。Windows 宿主上凡是提到
 * `C:\...` 的条目 claim 全部中招，而注入半句话比不注入更糟。
 *
 * 两条纪律：
 *   1. 每个用例的输入都取自**真实语料形态**（Windows 路径 / 正则 / 引号），
 *      不是 `a\nb` 这种人造串；
 *   2. 末尾有破坏测试自检：拿一份**已确认会坏**的输入证明断言会红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseYamlLite } from '../scripts/lib/yaml-lite.mjs'

/** 取单个字符串键的值（parseYamlLite 直接吃纯 YAML 文本）。 */
function scalar(raw) {
  return parseYamlLite(raw).v
}

/** 拼一个「双引号标量」，省得每条用例里手写转义、正文被反斜杠淹没。 */
const dq = (body) => `v: ${JSON.stringify(body)}`

test('Windows 路径里的 \\n 不被吃成换行（2026-10-20 修复的真损坏）', () => {
  assert.equal(scalar(dq('C:\\nodejs v22')), 'C:\\nodejs v22')
  assert.equal(scalar(dq('C:\\Program Files\\nodejs')), 'C:\\Program Files\\nodejs')
  assert.ok(!scalar(dq('C:\\nodejs')).includes('\n'), '读出来带了真换行 = 损坏未修好')
})

test('反斜杠 + n 的各种组合各自不同（顺序敏感回归）', () => {
  // 同一个字符族的不同写法，单趟扫描下必须互相区分；顺序替换做不到这一点
  assert.equal(scalar(dq('a\\nb')), 'a\\nb')     // 字面反斜杠 + 字面 n
  assert.equal(scalar(dq('a\nb')), 'a\nb')       // 真换行
  assert.equal(scalar(dq('a\\\nb')), 'a\\\nb')   // 字面反斜杠 + 真换行
  assert.equal(scalar(dq('a\tb')), 'a\tb')       // 真制表符
  // 注意：下面这条用的是**手写原文**而不是 dq()。JSON.stringify('a\\tb') 产出的是
  // "a\\tb"，YAML 读出来是「反斜杠 + tb」——它无法表达「\t 这个转义序列」本身，
  // 因为转义在序列化那一步就被吃掉了。要测 YAML 的 \t 规则只能直接写原文。
  assert.equal(scalar('v: "a\\tb"'), 'a\tb')     // 转义制表符
})

test('其余双引号转义仍按 YAML 规范还原', () => {
  assert.equal(scalar(dq('say "hi"')), 'say "hi"')
  assert.equal(scalar(dq('a/b')), 'a/b')
  assert.equal(scalar(dq('\x41\u0042')), 'AB')
  assert.equal(scalar(dq('C:\\Users\\septe\\.zcode')), 'C:\\Users\\septe\\.zcode')
})

test('未知转义宽松放行（不吞字符，也不抛错打断既有条目）', () => {
  assert.equal(scalar(dq('a\\qb')), 'a\\qb')
})

test('损坏输入仍然显式报错，而不是静默产出半个值', () => {
  // 双引号未闭合：值以反斜杠收尾，右引号根本不在（JSON.stringify 表达不了这种坏输入，
  // 同上一节的理由，只能手写原文）
  assert.throws(() => parseYamlLite('v: "abc\\'), /未闭合|孤立|反斜杠/)
  // 反斜杠 u 之后不是合法十六进制
  assert.throws(() => parseYamlLite('v: "\\uZZZZ"'), /十六进制/)
})

test('破坏测试自检：旧的顺序替换实现确实过不了上面第一条', () => {
  // 复刻 2026-10-20 之前的实现（\n 先做、\\ 后做），证明那些断言不是恒真
  const oldWay = (t) => t.slice(1, -1)
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  assert.ok(oldWay(JSON.stringify('C:\\nodejs v22')).includes('\n'), '旧实现应产生换行（否则这条破坏测试无意义）')
  assert.notEqual(
    oldWay(JSON.stringify('C:\\nodejs v22')),
    scalar(dq('C:\\nodejs v22')),
    '新旧实现必须给出不同结果，否则修复没生效',
  )
})
