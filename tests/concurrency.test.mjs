/**
 * concurrency.test.mjs —— 并发写不丢更新 + 锁不永久死锁（node:test，零框架依赖）
 *
 * 为什么要有这一套（票 H2 · 审计 P1-A 实测）：本系统的设计目标就是「多会话同时写 `.learnings`」，
 * 而守卫状态账与事件账原本是**无锁的读-改-写**。实测 10 个并发 `run-guard` 派发，
 * `shadow_runs` 只从 0 涨到 1（丢 9 次）、条目观测账丢 9 次；12 个并发 `capture` 只记到 count=11。
 * 账本失真会直接污染退役证据（空守卫靠假的「长期覆盖」退役真实条目），故并发是真契约，必须测。
 *
 * 「真并发」的定义（本文件全程遵守，伪并发一律不算数）：
 *   全部用例走 **spawn 多个独立进程 + 同时起跑**，不用 Promise.all 串行 await 单进程里的多次调用；
 *   断言落在**最终落盘的文件**上（进程各自 exit code 相同不足以证明没丢更新）。
 *
 * fixture = tests/fixtures/{lifecycle,capture}/（整目录拷到临时目录；项目实例配置不动）。
 * 双后端：YAML 读取经 scripts/lib/yaml-lite.mjs（宿主无 js-yaml → 降级；容器有 js-yaml → js-yaml）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWrite, withFileLock } from '../scripts/lib/atomic-file.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const RUNNER = path.join(SKILL_ROOT, 'scripts', 'run-guard.mjs')
const CAPTURE = path.join(SKILL_ROOT, 'scripts', 'capture.mjs')
const LOCK_LIB = path.join(SKILL_ROOT, 'scripts', 'lib', 'atomic-file.mjs')
const LIFECYCLE_FIXTURE = path.join(HERE, 'fixtures', 'lifecycle')
const CAPTURE_FIXTURE = path.join(HERE, 'fixtures', 'capture')
const GUARD_KEY = 'guard-fixture-dup-token'
const CLEAN = 'chore: nothing to see here'
const ERROR_TEXT = 'boom dup-token failure in module foo'

function freshTmp(fixture, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cpSync(fixture, dir, { recursive: true })
  return dir
}

/** 起一个进程并等它退出（预热等串行步骤用）。 */
function spawnCli(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, SELF_IMPROVING_CONFIG: '' } })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout: '', stderr }))
  })
}

/** N 个进程同时起跑同一命令（起跑时刻对齐靠「全部 spawn 完成后再统一收集」+ 断言最终账）。 */
function spawnConcurrent(count, makeArgs) {
  const procs = []
  for (let i = 0; i < count; i++) {
    const args = makeArgs(i)
    procs.push(new Promise((resolve) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, SELF_IMPROVING_CONFIG: '' } })
      let err = ''
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => resolve({ code, stderr: err }))
    }))
  }
  return Promise.all(procs)
}

const readState = (dir) => JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'))
const todayShards = (dir) => readdirSync(path.join(dir, 'events')).filter((f) => /^events-\d{8}\.jsonl$/.test(f))
const readShardLines = (dir) =>
  todayShards(dir).flatMap((f) =>
    readFileSync(path.join(dir, 'events', f), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l)),
  )

describe('并发写不丢更新（真并发：多进程同时起跑）', () => {
  it('10 个并发 run-guard 派发：账本计数 + 已告警丢失数 == 10（不**静默**丢 —— 丢必须逐次可见）', async () => {
    const dir = freshTmp(LIFECYCLE_FIXTURE, 'conc-guard-')
    try {
      const results = await spawnConcurrent(10, () => [RUNNER, '--key', GUARD_KEY, '--text', CLEAN, '--config', path.join(dir, 'config.yaml')])
      assert.equal(results.filter((r) => r.code === 0).length, 10, '每个派发都应 exit 0')
      // 三条降级通道，契约只要求「全部显式可见」，不要求「一条都不发生」：
      //   ① 锁降级：等锁三轮重试耗尽 → 本次不落状态账、审计留痕（stderr 逐次告警）
      //   ② 守卫自身 error：起不来 / 超时 / 非约定退出码 → 计入 shadow_runs 但**不计** green
      //      （run-guard.mjs 的既定纪律：不该因守卫自己坏了就发绿），账上分列 error_runs
      //   ③ 正常 pass：计入 runs 且计入 green
      // 另有 ④ 状态账读失败（锁内重试 3 轮仍读不到）→ 同样跳过写 + 告警 + 审计留痕。
      // 原断言写死「全放行 → green + 锁降级 == 10」，把 ② 当成了静默丢。实测机器饱和时
      // 10 个派发每个 ~9s（单发仅 2.5s），守卫大批 error，green=0 / error_runs=10 —— 账本
      // 其实分毫不差，是断言的前提「全放行」不成立。判据应是「每次派发都被某个通道归类」。
      // 降级判据两条告警串都算：只认其中一条会把另一条读成静默丢（这正是 2026-10-17 踩的坑）。
      const degraded = results.reduce((n, r) => n + (
        (r.stderr.includes('状态锁获取失败') || r.stderr.includes('状态账读取失败')) ? 1 : 0
      ), 0)
      const state = readState(dir)
      const guard = state.guards[GUARD_KEY]
      const runs = guard.shadow_runs
      const green = guard.shadow_green
      const errs = Number.isInteger(guard.error_runs) ? guard.error_runs : 0
      assert.equal(runs + degraded, 10, `shadow_runs(${runs}) + 锁降级(${degraded}) 必须 == 派发数（差额 = 静默丢 = 账本失真）`)
      assert.equal(green + errs, runs, `每次派发必须被归类：绿(${green}) + 守卫错(${errs}) == 账上派发数(${runs})；差额 = 没人认领的派发`)
      // 条目观测账同样要每条都对平（error 分流到 observed_error_runs，不计入 observed_runs）
      for (const id of ['LRN-20261016-010', 'LRN-20261016-011', 'ERR-20261016-012']) {
        const rec = state.entries[id]
        const observed = rec.observed_runs
        const e = Number.isInteger(rec.observed_error_runs) ? rec.observed_error_runs : 0
        assert.equal(observed + e, runs, `${id} 观测账未对平：观测(${observed}) + 守卫错(${e}) != 账上派发数(${runs})`)
      }
      // 审计行数 = 派发次数（降级写不进状态账，但审计照样逐行留痕），且每行都是可解析的完整 JSON
      const auditLines = readFileSync(path.join(dir, 'audit', 'audit.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
      assert.equal(auditLines.length, 10, '审计行数必须等于派发次数（丢失必须可从审计对账）')
      for (const line of auditLines) assert.doesNotThrow(() => JSON.parse(line), '审计行必须是完整 JSON（并发追加不得交错）')
      // 健康负载（零降级、零守卫错）下恢复严格契约：一票一次绿，分毫不差
      if (degraded === 0 && errs === 0) {
        assert.equal(runs, 10, '零降级时账本必须分毫不差')
        assert.equal(green, 10, '零降级时绿次数必须等于派发数')
      }
      // 锁必须自清理：不得留下残留锁目录（残留 = 下次必然踩到死锁路径）
      assert.equal(existsSync(path.join(dir, 'guard-state.json.lock')), false, '记账锁必须自清理')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('12 个并发 capture 同一错误：分片单行 count == 12（不丢计数、不重复出行）', async () => {
    const dir = freshTmp(CAPTURE_FIXTURE, 'conc-capture-')
    try {
      const results = await spawnConcurrent(12, () => [
        CAPTURE, '--source', 'gate', '--kind', 'gate_block', '--text', ERROR_TEXT,
        '--config', path.join(dir, 'config-on.yaml'), '--no-block',
      ])
      assert.equal(results.filter((r) => r.code === 0).length, 12, '每次捕获都应 exit 0')
      const lines = readShardLines(dir)
      assert.equal(lines.length, 1, '同一 fingerprint 必须归并成一行（归并契约）')
      assert.equal(lines[0].count, 12, 'count 必须等于捕获次数（丢计数会让近邻合并判据失真）')
      assert.equal(existsSync(path.join(dir, 'events', '.events.lock')), false, '事件锁必须自清理')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('12 个并发 capture 不同错误：12 行各 count=1（不整行互相覆盖）', async () => {
    const dir = freshTmp(CAPTURE_FIXTURE, 'conc-capture-diff-')
    try {
      const results = await spawnConcurrent(12, (i) => [
        CAPTURE, '--source', 'gate', '--kind', 'gate_block', '--text', `boom distinct failure case ${'abcdefghijkl'[i]} in module foo`,
        '--config', path.join(dir, 'config-on.yaml'), '--no-block',
      ])
      assert.equal(results.filter((r) => r.code === 0).length, 12)
      const lines = readShardLines(dir)
      assert.equal(lines.length, 12, '不同 fingerprint 必须各占一行（整分片覆盖会互相吃掉）')
      assert.deepEqual(lines.map((l) => l.count), Array(12).fill(1), '每行 count 都应为 1')
      // 事件 id 不得重号（同日序号由锁内重读后的行数派生，撞号会让审计对不上账）
      assert.equal(new Set(lines.map((l) => l.id)).size, 12, '事件 id 必须唯一（序号撞号 = 事实丢失）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('10 个并发 run-guard 命中断言（blocking 期）：wild_hits / pending_hits == 10（命中账也不许丢）', async () => {
    const dir = freshTmp(LIFECYCLE_FIXTURE, 'conc-guard-hit-')
    try {
      // 先攒满 shadow 升 blocking：shadow 期命中只 warn-only、不记 hit（拦截权要挣），升 blocking 才有 hit 账
      for (let i = 0; i < 3; i++) {
        const r = await spawnCli([RUNNER, '--key', GUARD_KEY, '--text', CLEAN, '--config', path.join(dir, 'config.yaml')], { cwd: dir })
        assert.equal(r.code, 0)
      }
      assert.equal(readState(dir).guards[GUARD_KEY].mode, 'blocking', '三次全绿后应升 blocking')

      const results = await spawnConcurrent(10, () => [
        RUNNER, '--key', GUARD_KEY, '--text', 'chore: touch dup-token twice -> dup-token', '--config', path.join(dir, 'config.yaml'),
      ])
      assert.equal(results.filter((r) => r.code === 2).length, 10, 'blocking 期命中判据应 10 次全部阻断（exit 2）')
      const state = readState(dir)
      assert.equal(state.guards[GUARD_KEY].shadow_runs, 13, '3 次预热 + 10 次并发，运行数不许丢')
      const rec = state.entries['LRN-20261016-010']
      assert.equal(rec.wild_hits, 10, '命中账丢更新')
      assert.equal(rec.pending_hits, 10, '待回写命中数丢更新（= sweep 会漏回写）')
      assert.equal(rec.pending_records.length, 10, '命中明细必须每条都在（sweep 靠它回写）')
      assert.equal(state.guards[GUARD_KEY].ever_hit, true, 'ever_hit 必须为真（判据在野外出过事的正证据）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('锁的原语（不丢更新 / 不永久死锁）', () => {
  it('8 个进程各自持锁写一行：最终 8 行（互斥真的互斥）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conc-lock-'))
    try {
      const target = path.join(dir, 'counter.log')
      writeFileSync(target, '', 'utf8') // 已存在的账本（真实场景：账先有数据，后来者重读再叠加）
      const lock = `${target}.lock`
      // 子进程直接 import 本仓的锁原语做「持锁 → 重读 → 整文件写回」，模拟最典型的读-改-写。
      // 刻意用**非原子**覆盖写：无锁时这就是教科书式丢更新（后写者覆盖先写者），有锁时才 8 行齐全。
      // 临界区里同步睡 60ms **是测试设计的一部分**：临界区太窄时「读—写」几乎瞬间完成，无锁也常常
      // 侥幸串行，本用例会退化成永远绿的摆设（实测：把锁改成 no-op 后它仍然通过）。
      const child = `
        import { withFileLock } from ${JSON.stringify(pathToUrl(LOCK_LIB))}
        import { readFileSync, writeFileSync } from 'node:fs'
        const [target, lock] = process.argv.slice(1)
        withFileLock(lock, () => {
          const prev = readFileSync(target, 'utf8')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
          writeFileSync(target, prev + 'x\\n')
        })
      `
      const results = await spawnConcurrent(8, () => ['--input-type=module', '-e', child, target, lock])
      assert.equal(results.filter((r) => r.code === 0).length, 8)
      const lines = readFileSync(target, 'utf8').split('\n').filter((l) => l !== '')
      assert.equal(lines.length, 8, '持锁写必须 8 行齐全（少行 = 丢更新 = 锁失效）')
      assert.equal(existsSync(lock), false, '锁必须自清理')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('陈旧锁（死 pid + 超龄）被回收：不永久死锁，临界区照常执行', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conc-stale-'))
    try {
      const lock = path.join(dir, 'x.lock')
      mkdirSync(lock, { recursive: true })
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999999, host: hostname(), at: new Date().toISOString() }), 'utf8')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old) // 超龄（staleMs 默认 15s）
      const started = Date.now()
      const out = withFileLock(lock, () => 'critical-section-ran', { timeoutMs: 1_000 })
      assert.equal(out, 'critical-section-ran', '陈旧锁必须被回收而不是干等')
      assert.ok(Date.now() - started < 3_000, '陈旧锁回收必须是毫秒级，不许挂住调用方')
      assert.equal(existsSync(lock), false, '回收后临界区结束应清掉锁')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未超龄但被活进程占着的锁：等锁超时返回 null 而不是无限等（调用方据此降级）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conc-live-'))
    try {
      const lock = path.join(dir, 'y.lock')
      mkdirSync(lock, { recursive: true })
      // owner = 本进程（活着）+ 锁龄远小于 staleMs：既不该被回收成死锁，也不该无限等 → 走超时分支
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), 'utf8')
      let ran = false
      const started = Date.now()
      const out = withFileLock(lock, () => { ran = true; return 'critical-ran' }, { timeoutMs: 120, staleMs: 15_000 })
      const elapsed = Date.now() - started
      assert.equal(out, null, '拿不到锁必须返回 null（不是抛错、不无限等）')
      assert.equal(ran, false, '没拿到锁就不许执行临界区')
      assert.ok(elapsed < 3_000, `超时必须按 timeoutMs 收敛（实测 ${elapsed}ms）`)
      rmSync(lock, { recursive: true, force: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('atomicWrite：内容完整落盘且不留 tmp 残留', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conc-atomic-'))
    try {
      const target = path.join(dir, 'state.json')
      atomicWrite(target, '{"a":1}\n')
      assert.equal(readFileSync(target, 'utf8'), '{"a":1}\n')
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
      assert.deepEqual(leftovers, [], '原子写不得留 tmp 残留')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Windows / POSIX 通用的 file:// URL（子进程 import 用）。 */
function pathToUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/')
  return `file:///${abs.startsWith('/') ? abs.slice(1) : abs}`
}
