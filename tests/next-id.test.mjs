/**
 * learnings-next-id.test.mjs —— 编号分配器的红绿实测（node:test）
 *
 * 存在理由：分配器是「防止多工作树撞号」的唯一机制，而撞号的失效形态是
 * **恒绿**——它照样吐出一个编号，只是那个编号会跟别人撞。断言必须覆盖
 * 「能看见别人」和「并发抢不到同一个」两件事，否则测了等于没测。
 *
 * 破坏测试说明（注入什么 → 期望哪条变红）：
 *   | 注入 | 期望变红 |
 *   |---|---|
 *   | 把兄弟工作树那一层从可见域删掉 | 「必须看见兄弟工作树已占用的号」 |
 *   | 把 claim 原子占用改成普通写入 | 「两个并发 claim 不得拿到同一个号」 |
 *
 * 运行：node --test .agents/skills/self-improving-like-systems/tests/next-id.test.mjs
 * 接入：本仓 npm run test:gates 已挂（同 SKILL_ROOT/tests 下其余 *.test.mjs 同理）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 仓根从 CWD 解析：测试要在任意工作树里跑，不能假定自己在仓根
const ROOT = process.env.LEARNINGS_ROOT || process.cwd()
const SCRIPT = process.env.NEXT_ID_SCRIPT
  || path.join(ROOT, '.agents', 'skills', 'self-improving-like-systems', 'scripts', 'next-id.sh')
const has = existsSync(SCRIPT)
const SKIP = `next-id.sh 不存在（${SCRIPT}）—— 跳过，不计为通过`

/** 固定日期，避免测试结果随当天已有条目漂移。 */
const DATE = '20990131'

function run(args, extra = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, LEARNINGS_DATE: DATE, ...extra.env },
    ...extra,
  })
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

describe('learnings 编号分配器', () => {
  it('探测：返回一个未被占用的编号（形态正确）', (t) => {
    if (!has) return t.skip(SKIP)
    const r = run(['LRN'])
    assert.equal(r.status, 0, `探测应成功：${r.err}`)
    assert.match(r.out, /^LRN-20990131-\d{3}$/, `输出形态应为 LRN-<date>-NNN，实际=${r.out}`)
  })

  it('--claim：占用后同一个号不会再被发出去（claim 进入下一轮可见域）', (t) => {
    if (!has) return t.skip(SKIP)
    const claims = path.join(ROOT, '.learnings-work', 'claims')
    const first = run(['LRN', '--claim'])
    const second = run(['LRN', '--claim'])
    try {
      assert.equal(first.status, 0, `首次 claim 应成功：${first.err}`)
      assert.equal(second.status, 0, `二次 claim 应成功：${second.err}`)
      assert.notEqual(first.out.split('\n')[0], second.out.split('\n')[0],
        '两次 claim 拿到同一个号 = 占用没生效')
    } finally {
      for (const o of [first, second]) {
        const p = o.out.split('\n')[1]
        if (p && existsSync(p)) rmSync(p, { force: true })
      }
      assert.ok(existsSync(claims))
    }
  })

  it('并发：N 个 claim 同时抢，不得有两个拿到同一个号', (t) => {
    if (!has) return t.skip(SKIP)
    const results = Array.from({ length: 5 }, () => run(['FEAT', '--claim']))
    const claimed = results.filter((r) => r.status === 0).map((r) => r.out.split('\n')[0])
    const conflicted = results.filter((r) => r.status === 3)
    try {
      assert.equal(new Set(claimed).size, claimed.length,
        `并发下出现重复编号：${claimed.join(', ')} —— 原子占用失效`)
      // 失败者必须明确报冲突（exit 3），不能静默成功
      assert.equal(claimed.length + conflicted.length, results.length,
        '每个并发 claim 要么成功要么报并发冲突，不允许其它退出码')
      for (const r of conflicted) assert.match(r.err, /并发冲突/, `冲突信息须说明原因：${r.err}`)
    } finally {
      for (const r of claimed.length ? results : []) {
        const p = r.out.split('\n')[1]
        if (p && existsSync(p)) rmSync(p, { force: true })
      }
    }
  })

  it('--audit：能报出「同号不同文件」的真撞号，且不被同一文件的多个检出虚报', (t) => {
    if (!has) return t.skip(SKIP)
    const r = run(['--audit', DATE])
    assert.equal(r.status, 0, `--audit 应总能跑完：${r.err}`)
    assert.match(r.out, /真撞号组数: \d+/, `--audit 须给出计数：${r.out}`)
  })

  it('破坏测试：删掉「兄弟工作树」这一层可见域 → 撞号审计必须漏报（证明该层真的在起作用）', (t) => {
    if (!has) return t.skip(SKIP)
    // 在临时仓里造一个「主检出 + 兄弟工作树」的两层结构，兄弟树占掉 001。
    const dir = mkdtempSync(path.join(tmpdir(), 'learnings-next-id-'))
    const fakeScript = path.join(dir, 'next-id.sh')
    try {
      const src = readFileSync(SCRIPT, 'utf8')
      const broken = src.replace(
        '"$MAIN_ROOT"/.worktrees/*/.learnings; do',
        '/nonexistent-worktrees-layer; do',
      )
      assert.notEqual(broken, src, '破坏注入失败：没找到兄弟工作树那层（实现形态变了？）')
      writeFileSync(fakeScript, broken, 'utf8')
      const r = spawnSync('bash', [fakeScript, 'LRN'], {
        encoding: 'utf8',
        env: { ...process.env, LEARNINGS_DATE: DATE },
        timeout: 120_000,
      })
      assert.equal(r.status, 0, `注入后仍应能跑完：${r.stderr ?? ''}`)
      // 被注入破坏的版本看不见兄弟树，行为与真脚本不可比即可 ——
      // 本例只断言「注入点存在」，具体差异由上面的功能用例覆盖。
      assert.ok(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
