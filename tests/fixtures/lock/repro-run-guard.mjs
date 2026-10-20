/**
 * 复现脚本（诊断用）：反复跑「10 个并发 run-guard 派发」这个真实场景，
 * 把账本计数、降级数、审计行数三者打出来 —— 判据只说「不等」，这里要说「哪一环不等」。
 *
 * 用法：node tests/fixtures/lock/repro-run-guard.mjs [轮数]
 */
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL_ROOT = path.resolve(HERE, '..', '..', '..')
const RUNNER = path.join(PROTOCOL_ROOT, 'scripts', 'run-guard.mjs')
const LIFECYCLE_FIXTURE = path.join(PROTOCOL_ROOT, 'tests', 'fixtures', 'lifecycle')
const GUARD_KEY = 'guard-fixture-dup-token'
const CLEAN = 'chore: nothing to see here'

const ROUNDS = Number(process.argv[2] || 5)

function spawnConcurrent(count, dir) {
  const procs = []
  for (let i = 0; i < count; i++) {
    procs.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNNER, '--key', GUARD_KEY, '--text', CLEAN, '--config', path.join(dir, 'config.yaml')], {
        env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
      })
      let err = ''
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => resolve({ code, stderr: err }))
    }))
  }
  return Promise.all(procs)
}

const dir = mkdtempSync(path.join(tmpdir(), 'repro-rg-'))
cpSync(LIFECYCLE_FIXTURE, dir, { recursive: true })
try {
  let bad = 0
  for (let r = 1; r <= ROUNDS; r++) {
    const results = await spawnConcurrent(10, dir)
    const state = JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8'))
    const g = state.guards[GUARD_KEY]
    const degraded = results.reduce((n, x) => n + ((x.stderr.includes('状态锁获取失败') || x.stderr.includes('状态账读取失败')) ? 1 : 0), 0)
    const auditLines = readFileSync(path.join(dir, 'audit', 'audit.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').length
    const nonzeroExit = results.filter((x) => x.code !== 0).length
    const ok = g.shadow_runs + degraded === 10
    if (!ok) bad++
    console.log(
      `第 ${r} 轮: shadow_runs=${g.shadow_runs} green=${g.shadow_green} err_runs=${g.error_runs ?? '-'} ` +
      `降级=${degraded} 审计行=${auditLines} 非零退出=${nonzeroExit} ${ok ? 'OK' : '★ 账不平'}`,
    )
    if (!ok) {
      console.log('   账本:', JSON.stringify(g).slice(0, 400))
      const suspicious = results.map((x) => x.stderr.split('\n').filter((l) => /状态写入失败|写入失败|EPERM|EBUSY|EACCES|ENOTEMPTY/.test(l)))
      console.log('   写失败行:', JSON.stringify(suspicious.filter((a) => a.length > 0)))
      console.log('   stderr 前 260 字符:', JSON.stringify(results.map((x) => x.stderr.slice(0, 260))))
    }
    // 复位账本，下一轮从零开始（否则计数只增不减，看不出这一轮丢没丢）
    rmSync(path.join(dir, 'guard-state.json'), { force: true })
    rmSync(path.join(dir, 'audit', 'audit.jsonl'), { force: true })
  }
  console.log(`\n结论：${ROUNDS} 轮里 ${bad} 轮账不平`)
  process.exitCode = bad ? 1 : 0
} finally {
  rmSync(dir, { recursive: true, force: true })
}
