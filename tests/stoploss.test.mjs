/**
 * stoploss.test.mjs —— 止损文档与代码极性对拍（node:test，零框架依赖）
 *
 * 事故背景：references/stoploss.md 曾把「停注入」写成 `kill_switch.injection: true`，
 * 而代码判据是 `if (config.kill_switch.X !== true) → 跳过`（**true = 开**）。
 * trace.mjs 判红后的唯一指引就是本文件 —— 照做等于打开注入、只留捕获，把纯事实变成持续污染。
 *
 * 本套件把**极性判据从脚本源码反推**（不硬编码第二份），再把文档里每一个
 * `kill_switch.X: <bool>` 表述按「意图词（停/关 vs 保留/恢复/开/放）」逐条对拍：
 * 写反极性 → 立刻变红。文档若漏写意图词，同样变红（不许有机器判不了的行）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KILL_SWITCH_KEYS } from '../scripts/validate.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const SCRIPTS = path.join(SKILL_ROOT, 'scripts')
const STOPLOSS = path.join(SKILL_ROOT, 'references', 'stoploss.md')

/** 全部 scripts/*.mjs 源码拼一份（判据只可能落在消费方脚本里）。 */
function allScriptSource() {
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => readFileSync(path.join(SCRIPTS, f), 'utf8'))
    .join('\n')
}

/**
 * 从脚本源码反推某个开关的「开启值」。
 *
 * 只看比较式里被比的**那个字面量**：`X !== true`（不是 true 就跳过）与 `X === true`（是 true 才做）
 * 两种写法都把 true 当「开」侧，`!== false` / `=== false` 则把 false 当「开」侧 —— 即
 * 「被比的那个值 = 生效的那个值」。同名开关多处判据必须一致，否则返回多值
 * （= 源码自身极性矛盾，比文档写反更严重，测试直接红）。
 */
function enableValueFromSource(src, name) {
  const re = new RegExp(`kill_switch\\.${name}\\s*(?:===|!==)\\s*(true|false)`, 'g')
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))]
}

/** 抽文档里的开关表述：逐行扫，形如 `kill_switch.<name>: <bool>` 才算一条表述（表内 `<bool>` 占位不算）。 */
function docClaims(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const re = /kill_switch\.([a-z_]+):\s*(true|false)/g
    for (const m of lines[i].matchAll(re)) {
      // 意图词取本行；本行无则回退上一行（执行清单里「停」写在上一行、指令值换行写）
      const intentOf = (s) => (/[停关]/.test(s) ? 'stop' : /[保留恢复开放继续]/.test(s) ? 'keep' : null)
      const intent = intentOf(lines[i]) ?? (i > 0 ? intentOf(lines[i - 1]) : null)
      out.push({ line: i + 1, name: m[1], value: m[2], intent, text: lines[i].trim() })
    }
  }
  return out
}

describe('止损文档极性对拍（写反即事故）', () => {
  it('源码反推：三开关的开启值可判定且同名判据自洽', () => {
    assert.equal(KILL_SWITCH_KEYS.length, 3, `KILL_SWITCH_KEYS 应为三开关，当前 ${KILL_SWITCH_KEYS.join(',')}`)
    const src = allScriptSource()
    for (const k of KILL_SWITCH_KEYS) {
      const vals = enableValueFromSource(src, k)
      assert.equal(vals.length, 1, `kill_switch.${k} 的源码判据极性自相矛盾: ${vals.join(' / ') || '无判据'}`)
    }
  })

  it('stoploss.md 每条开关表述都与源码判据一致（停→关值，保留/恢复→开值）', () => {
    const src = allScriptSource()
    const enable = Object.fromEntries(KILL_SWITCH_KEYS.map((k) => [k, enableValueFromSource(src, k)[0]]))
    const claims = docClaims(readFileSync(STOPLOSS, 'utf8'))

    assert.ok(claims.length > 0, 'stoploss.md 必须仍有 kill_switch 表述，否则它已与代码脱钩')
    assert.deepEqual(
      [...new Set(claims.map((c) => c.name))].sort(),
      [...KILL_SWITCH_KEYS].sort(),
      '三个开关都必须被点名（漏一个 = 事故时无指引）',
    )
    for (const c of claims) {
      assert.ok(c.intent !== null, `stoploss.md:${c.line} 缺意图词（停/关 或 保留/恢复/开/放），机器判不了极性: ${c.text}`)
      const stopValue = enable[c.name] === 'true' ? 'false' : 'true'
      const expect = c.intent === 'stop' ? stopValue : enable[c.name]
      assert.equal(
        c.value,
        expect,
        `stoploss.md:${c.line} 极性写反：源码判据 kill_switch.${c.name}=${enable[c.name]} 为「开」，`
          + `此处是「${c.intent === 'stop' ? '停' : '保留/恢复'}」指令却写 ${c.value}\n    ${c.text}`,
      )
    }
  })

  it('极性图例存在、逐开关与源码一致（事故时第一眼读的那张表不能写反）', () => {
    const src = allScriptSource()
    const lines = readFileSync(STOPLOSS, 'utf8').split('\n')
    assert.match(lines.join('\n'), /`true` = 该路径开/, '缺极性图例（true = 开 / false = 停）')
    for (const k of KILL_SWITCH_KEYS) {
      const row = lines.find((l) => l.includes(`kill_switch.${k}: <bool>`))
      assert.ok(row, `极性图例缺 kill_switch.${k} 一行`)
      const cells = row.split('|').map((s) => s.trim())
      assert.equal(cells.length, 6, `图例 ${k} 应为「键 | 判据出处 | true= | false=」四列: ${row}`)
      const [trueCol, falseCol] = [cells[3], cells[4]]
      assert.ok(/开/.test(trueCol), `图例 ${k} 的 true 列必须写「开」: ${row}`)
      assert.ok(/[停关]/.test(falseCol), `图例 ${k} 的 false 列必须写「停」: ${row}`)
    }
  })

  it('追溯判据直书源码形态「不是 true 就不做」（照抄它的人不会再写反）', () => {
    const md = readFileSync(STOPLOSS, 'utf8')
    assert.match(md, /kill_switch\.X !== true/, '图例须直书源码判据形态（不是 true 就不做）')
  })
})
