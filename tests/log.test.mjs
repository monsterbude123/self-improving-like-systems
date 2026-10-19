/**
 * log.test.mjs —— 诊断日志自包含测试（node:test，零框架依赖；`node <本文件>` 直跑）
 *
 * 覆盖口径：分级丢弃 / 分模块 / 异常独立成文件 / 按大小滚动 / trace_id 贯通 / span 结构化 /
 * 查询面四种模式 / 热路径纪律（低于阈值不构造消息）/ **滚动绝不碰审计与事件账**。
 * 每条都有红向：破坏测试见各 it 的红向注记 —— 只会通过的测试等于没有测试。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, resolveLogging, LEVELS, DEFAULT_LOGGING } from '../scripts/lib/log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const QUERY = path.join(SKILL_ROOT, 'scripts', 'log-query.mjs')
const CAPTURE = path.join(SKILL_ROOT, 'scripts', 'capture.mjs')
const FIXTURE = path.join(HERE, 'fixtures', 'capture')

function tmp(prefix = 'log-test-') {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function query(args, cwd = process.cwd()) {
  const r = spawnSync(process.execPath, [QUERY, ...args], { cwd, encoding: 'utf8', env: { ...process.env, SELF_IMPROVING_CONFIG: '' } })
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` }
}

describe('log.mjs · 分级 / 分模块 / 滚动 / 异常独立', () => {
  it('红向：低于阈值的级别被丢弃，且**不写文件**（热路径纪律）', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'warn', dir: 'logs/' } } })
      log.debug('不该出现')
      log.info('也不该出现')
      log.warn('应该出现')
      const f = readFileSync(path.join(dir, 'logs', 'si.log'), 'utf8')
      assert.ok(!f.includes('不该出现') && !f.includes('也不该出现'), '低于阈值的必须丢弃')
      assert.ok(f.includes('应该出现'), '达到阈值的必须写出')
      assert.ok(!existsSync(path.join(dir, 'logs', 'si-error.log')), 'warn 不是 error，不得进异常文件')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：异常独立成文件 —— error 两边都有，warn/info 只在主日志', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/' } } })
      log.info('普通信息')
      log.warn('警告')
      log.error('出事了', new Error('boom detail'))
      const main = readFileSync(path.join(dir, 'logs', 'si.log'), 'utf8')
      const errFile = readFileSync(path.join(dir, 'logs', 'si-error.log'), 'utf8')
      assert.ok(main.includes('普通信息') && main.includes('警告') && main.includes('出事了'), '主日志保留全部（含时间线定位用）')
      assert.ok(errFile.includes('出事了') && errFile.includes('boom detail'), '异常文件必须带错误细节')
      assert.ok(!errFile.includes('普通信息') && !errFile.includes('警告'), '非 error 不得污染异常文件')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：按大小滚动 —— 超限即滚动，保留 max_files 份，最老的被丢', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/', max_bytes: 400, max_files: 3 } } })
      for (let i = 0; i < 30; i++) log.info(`滚动压力测试第 ${i} 行 ${'x'.repeat(40)}`)
      const files = readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith('si.log'))
      const shards = files.filter((f) => f !== 'si.log' && f !== 'si-error.log')
      assert.ok(shards.length > 0, '超限必须发生滚动')
      assert.ok(shards.length <= 3, `滚动分片不得超过 max_files(3)，实际 ${shards.length}`)
      assert.ok(!existsSync(path.join(dir, 'logs', 'si.log.4')), '超出保留份数的必须被丢弃')
      const newest = readFileSync(path.join(dir, 'logs', 'si.log'), 'utf8')
      assert.ok(newest.includes('第 29 行'), '最新一条必须在当前文件里')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：滚动**绝不碰审计与事件账**（它们是证据账，滚一次就毁一批）', () => {
    const dir = tmp()
    try {
      mkdirSync(path.join(dir, 'events'), { recursive: true })
      appendFileSync(path.join(dir, 'events', 'events-20260101.jsonl'), '{"id":"evt-1"}\n')
      mkdirSync(path.join(dir, 'audit'), { recursive: true })
      writeFileSync(path.join(dir, 'audit', 'audit.jsonl'), '{"action":"guard-pass"}\n')
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/', max_bytes: 300, max_files: 2 } } })
      for (let i = 0; i < 40; i++) log.info(`压力 ${i} ${'y'.repeat(50)}`)
      const evs = readFileSync(path.join(dir, 'events', 'events-20260101.jsonl'), 'utf8')
      const aud = readFileSync(path.join(dir, 'audit', 'audit.jsonl'), 'utf8')
      assert.ok(evs.includes('evt-1'), '事件账内容不得被日志滚动影响')
      assert.ok(aud.includes('guard-pass'), '审计账内容不得被日志滚动影响')
      assert.ok(readdirSync(path.join(dir, 'events')).every((f) => f === 'events-20260101.jsonl'), '日志滚动不得在事件目录里产生分片')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：run_id / trace_id 贯通 —— 同一次执行的每行共享同一对标识', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/' } } })
      log.info('第一行')
      log.error('第二行', new Error('e'))
      const child = log.child('子模块')
      child.info('第三行')
      const lines = readFileSync(path.join(dir, 'logs', 'si.log'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 3)
      const runs = new Set(lines.map((l) => /run=(\S+)/.exec(l)[1]))
      const traces = new Set(lines.map((l) => /trace=(\S+)/.exec(l)[1]))
      assert.equal(runs.size, 1, '一次执行内 run_id 必须唯一且共享')
      assert.equal(traces.size, 1, '一次执行内 trace_id 必须唯一且共享')
      assert.ok(lines[2].includes('mod=子模块'), 'child 只换 module，不换 run/trace')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：宿主给的 traceId 优先于自生成（capture 靠它与宿主调用链对齐）', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'capture', baseDir: dir, traceId: 'host-trace-xyz', config: { logging: { level: 'info', dir: 'logs/' } } })
      assert.equal(log.traceId, 'host-trace-xyz')
      log.info('对齐测试')
      assert.ok(readFileSync(path.join(dir, 'logs', 'si.log'), 'utf8').includes('trace=host-trace-xyz'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('红向：span 落结构化 JSON，业务键可检索（--cycle 靠它跨调用串联）', () => {
    const dir = tmp()
    try {
      const log = createLogger({ module: 'run-guard', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/', trace_enabled: true } } })
      log.span('guard.dispatch', { guard_key: 'no-bare-vitest', outcome: 'pass', duration_ms: 12 })
      const shard = readdirSync(path.join(dir, 'logs')).find((f) => f.startsWith('si-trace-'))
      const rec = JSON.parse(readFileSync(path.join(dir, 'logs', shard), 'utf8').trim())
      assert.equal(rec.guard_key, 'no-bare-vitest')
      assert.equal(rec.event, 'guard.dispatch')
      assert.equal(rec.module, 'run-guard')
      assert.ok(rec.trace && rec.run && rec.ts, 'span 必须带 run/trace/ts 才串得起来')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('绿侧：trace_enabled=false → 不写轨迹文件（省 I/O）；logging.enabled=false → 全静默', () => {
    const dir = tmp()
    try {
      const noTrace = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'logs/', trace_enabled: false } } })
      noTrace.span('a.b', { k: 1 })
      assert.ok(!readdirSync(path.join(dir, 'logs')).some((f) => f.startsWith('si-trace-')), 'trace_enabled=false 不得写轨迹')
      const off = createLogger({ module: 'x', baseDir: dir, config: { logging: { enabled: false, dir: 'logs/' } } })
      off.info('不该写'); off.error('也不该写', new Error('x')); off.span('a.b')
      assert.ok(!existsSync(path.join(dir, 'logs', 'si.log')), 'enabled=false 必须零副作用')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('绿侧：目录不可写 → 退化为不写，调用方零异常（fail-safe 到极致）', () => {
    // Windows 上把目录做成文件来制造「建不出来」；跨平台下至少验证不抛异常。
    const dir = tmp()
    try {
      writeFileSync(path.join(dir, 'notadir'), 'x')
      const log = createLogger({ module: 'x', baseDir: dir, config: { logging: { level: 'info', dir: 'notadir/sub/' } } })
      assert.doesNotThrow(() => { log.info('写不进去就不写'); log.error('异常也写不进去', new Error('e')); log.span('a.b') })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('resolveLogging：缺段 / 非法值一律回落内置默认（日志器永远不给调用方添麻烦）', () => {
    assert.equal(resolveLogging({}).level, DEFAULT_LOGGING.level)
    assert.equal(resolveLogging({ logging: { level: '不存在' } }).level, DEFAULT_LOGGING.level)
    assert.equal(resolveLogging({ logging: { max_bytes: -5 } }).max_bytes, DEFAULT_LOGGING.max_bytes)
    assert.equal(resolveLogging({ logging: { max_files: 0 } }).max_files, DEFAULT_LOGGING.max_files)
    assert.equal(resolveLogging({ logging: { level: 'debug' } }).level, 'debug')
    assert.ok(LEVELS.error > LEVELS.warn && LEVELS.warn > LEVELS.info && LEVELS.info > LEVELS.debug, '级别序必须单调')
  })
})

describe('log-query.mjs · 只读查询面', () => {
  it('四种模式：--stats / --trace / --cycle / --errors 各自可用且只读', () => {
    const dir = tmp()
    try {
      cpSync(FIXTURE, dir, { recursive: true })
      const LOGS = path.join(dir, '.self-improving', 'logs')
      const before = existsSync(LOGS) ? readdirSync(LOGS).sort() : []
      // 先用真实 capture 产生日志（走 hook 夹具目录，events/logs 都是它的子目录）
      const env = { error: 'QUERYFIXTURE: 造一条日志用于查询面测试', hookEventName: 'PostToolUseFailure', toolName: 'Bash', traceId: 'host-qf-1' }
      const c = spawnSync(process.execPath, [CAPTURE, '--config', path.join(dir, 'config-on.yaml'), '--source', 'tool', '--kind', 'tool_error', '--severity', 'warn', '--text', '-', '--no-block'],
        { cwd: dir, input: JSON.stringify(env), encoding: 'utf8', env: { ...process.env, SELF_IMPROVING_CONFIG: '' } })
      assert.equal(c.status, 0, c.stderr)
      assert.ok(existsSync(path.join(LOGS, 'si.log')), `capture 应产出日志，实际目录: ${readdirSync(dir).join(',')}`)

      const s = query(['--stats', '--project-dir', dir])
      assert.equal(s.code, 0, s.all)
      assert.ok(/按模块/.test(s.err) && /capture/.test(s.err), `--stats 应按模块聚合:\n${s.err}`)

      const t = query(['--trace', 'host-qf-1', '--project-dir', dir])
      assert.equal(t.code, 0, t.all)
      assert.ok(t.err.includes('host-qf-1'), `--trace 应命中宿主 traceId:\n${t.err}`)

      const cy = query(['--cycle', 'capture', '--project-dir', dir])
      assert.ok(cy.code === 0 || cy.code === 1, `--cycle 不该崩:\n${cy.all}`)

      const e = query(['--errors', '--project-dir', dir])
      assert.ok(e.code === 0 || e.code === 1, e.all)

      // 只读性：查询前后日志目录不得被改动（除本次 capture 自己写的）
      const after = readdirSync(LOGS).sort()
      const grew = after.length > before.length
      assert.ok(grew, 'capture 本次应新增日志文件')
      const again = query(['--stats', '--project-dir', dir])
      assert.equal(readdirSync(LOGS).sort().join(','), after.join(','), '查询必须只读：再查一次不得新增文件')
      assert.equal(again.code, 0, again.all)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('用法错误 → exit 2（未知参数 / --trace 缺值 / 不指定模式）', () => {
    for (const args of [['--bogus'], ['--trace'], [], ['--stats', '--nope']]) {
      const r = query(args)
      assert.equal(r.code, 2, `--bogus 等用法错误应 exit 2：${args.join(' ')}\n${r.all}`)
    }
  })

  it('没查到 → exit 1（是「没有」这个事实，不是故障）', () => {
    const dir = tmp()
    try {
      cpSync(FIXTURE, dir, { recursive: true })
      const r = query(['--trace', '不存在的trace', '--project-dir', dir])
      assert.equal(r.code, 1, `查不到应为 exit 1:\n${r.all}`)
      assert.ok(/没查到/.test(r.err) || /不存在/.test(r.err), r.err)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
