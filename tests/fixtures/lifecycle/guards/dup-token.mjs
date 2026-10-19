#!/usr/bin/env node
/**
 * fixture 守卫（node 版）：输入里同一 token 出现两次即命中（exit 2），单次或无命中放行（exit 0）。
 * 契约与原 `dup-token.sh` **逐条等价**（同 token 表、同阈值、同 stderr 文案、同退出码）。
 *
 * 为什么从 bash 换成 node（2026-10-17 · 只动夹具，不动生产代码）：
 *   派发器每次派发都要 spawn 一次守卫，而 run-guard 的 `GUARD_TIMEOUT_MS` 是 **10s**，
 *   超时按「守卫自身异常」fail-open 记 error（**不计绿**）。本机（Windows + Git Bash）实测
 *   空闲时一次 bash spawn ≈ 0.6–1.0s，全套件并行时能到 **10.0s+** → 触发 ETIMEDOUT：
 *     [run-guard] guard-fixture-dup-token · error · exit=null · 10019ms ·
 *     spawn 失败: spawnSync bash ETIMEDOUT（fail-open：守卫自身异常不阻塞提交）
 *   而「一次守卫没跑成」会让 shadow 期少一次绿，攒不满就永远停在 shadow ——
 *   依赖「连跑 N 次碰巧攒满 blocking」的用例会因此间歇性变红（本仓实测 6 轮红 3 轮）。
 *   node 进程 spawn ≈ 0.1s，与负载无关，10s 上限变成事实上的不可达 ⇒ 用例确定。
 *   守卫的**语义**（判据、退出码、fail-open 边界）与哪种解释器无关，故这是纯夹具替换。
 */
import { readFileSync } from 'node:fs'

let input = ''
if (process.argv.includes('--input-stdin')) {
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    input = ''
  }
}
for (const tok of ['dup-token', 'NEUTRALTOKEN']) {
  // 与 bash 版同口径：数的是**出现次数**（含重叠），用 split 而非正则以避免转义差异。
  const n = input.split(tok).length - 1
  if (n >= 2) {
    console.error(`[dup-token] 命中判据：token ${tok} 出现 ${n} 次`)
    process.exit(2)
  }
}
process.exit(0)
