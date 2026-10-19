/**
 * atomic-file.mjs —— 跨进程互斥与原子写（通用技能，零项目耦合，宿主可跑）
 *
 * 存在理由（本系统的设计目标就是「多会话同时写同一个经验库」，而守卫状态账与事件账
 * 原本是**无锁的读-改-写**：实测 10 个并发 `run-guard` 派发，`shadow_runs` 只从 0 涨到 1，
 * 丢 9 次 —— 账本失真会直接污染退役证据，故记账必须互斥）。
 *
 * 两个原语，各管一件事：
 *   - `atomicWrite(file, data)`：tmp 文件 + `rename` 覆盖 —— 防「读到写了一半的文件」
 *     （读者永远只看到旧版或新版完整内容）。单靠它**不能**解决丢更新：两个进程仍可能
 *     都读到旧值再各自写回，后者覆盖前者。
 *   - `withFileLock(lockPath, fn, opts)`：把「读-改-写」整段圈进互斥区 —— 这才治丢更新。
 *
 * 锁的形态与跨后端可用性：锁 = `mkdir`（独占创建，Windows 与 POSIX 都是原子的，
 * `EEXIST` 即已占用），锁内写 `owner.json`（pid + host + 时间戳）供回收判定。
 * 选 mkdir 而非 fd 扫描是 ERR-20261012-005 的直接教训（fd 扫描判不出自锁）。
 *
 * **绝不留下永久死锁**：
 *   ① 等锁有上限（`timeoutMs`，默认 5s），超时返回 `null` 由调用方降级；
 *   ② 陈旧锁回收（`staleMs`，默认 15s）：**owner 确证已死则立刻回收**；owner 判不出（无
 *      owner.json / 异主机 / 元数据损坏）且已超龄才回收。**owner 确证还活着时绝不按龄回收** ——
 *      那样会把「罕见的死锁」换成「罕见的静默丢更新」，后者更糟（见循环内注释的实测复现链）；
 *   ③ 拿不到锁时**不抛异常**（丢一次计数可恢复，卡住提交不可恢复 —— 与本系统 fail-open 纪律一致）。
 *
 * 锁序纪律（防死锁的另一半）：调用方**不得嵌套**两把不同的锁；若必须覆盖多文件，
 * 用一把目录级锁把整个临界区圈起来（见 capture.mjs 的 events 锁）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'

/** 默认等锁上限（ms）—— 超时即放弃互斥，降级为「不带锁地写」，绝不挂住调用方。 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
/** 默认陈旧锁阈值（ms）—— 超过即判为死进程遗留，回收。 */
const DEFAULT_LOCK_STALE_MS = 15_000
/** 等锁轮询间隔（ms）。 */
const POLL_MS = 8
/** 判 pid 存活时的最小锁龄（ms）：刚建的锁 owner 元数据可能还没落盘，不立即判死。 */
const PID_LIVENESS_GRACE_MS = 1_000

/** 同步睡（零依赖；临界区前后都要同步语义，setTimeout 不适用）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 锁 owner 是否已死。
 * @returns {boolean|null} true=确定已死 / false=活着 / null=判不出（异主机或元数据缺失）
 */
function ownerIsDead(lockDir) {
  let owner
  try {
    owner = JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'))
  } catch {
    return null
  }
  if (!owner || typeof owner.pid !== 'number') return null
  if (owner.host && owner.host !== hostname()) return null
  let age
  try { age = Date.now() - statSync(lockDir).mtimeMs } catch { return null }
  if (age < PID_LIVENESS_GRACE_MS) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (e) {
    // ESRCH = 进程没了 → 锁必为遗留；EPERM = 进程在但无权发信号 → 仍算活着
    return Boolean(e) && e.code === 'ESRCH'
  }
}

/**
 * 原子写：写 tmp 再 rename 覆盖。
 *
 * tmp 名必须唯一（pid + 随机后缀）：两进程同写一个目标时若共用 tmp，会出现
 * 「A 写了一半 B 来 rename」的错位。rename 在同目录（同卷）内原子，且 Windows 上会覆盖
 * 已存在文件，故两后端语义一致。
 * @param {string} file 目标文件
 * @param {string|Buffer} data 内容
 * @param {string} [encoding]
 * @returns {string} 目标路径
 */
export function atomicWrite(file, data, encoding = 'utf8') {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  )
  try {
    writeFileSync(tmp, data, encoding)
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* tmp 清理失败不该盖掉真错误 */ }
    throw e
  }
  return file
}

/**
 * 目录锁：圈一段「读-改-写」临界区。
 *
 * 用法：`withFileLock(lockPath, () => { 读 → 改 → 原子写 }, { timeoutMs })`
 * 返回 `fn()` 的结果；**拿不到锁时返回 `null`**（不是抛错），由调用方决定降级行为。
 * @param {string} lockPath 锁路径（粒度由调用方定：单文件 → `<file>.lock`；多文件 → 目录级锁）
 * @param {() => any} fn 临界区（必须短：无 spawn、无网络、无外部等待）
 * @param {{timeoutMs?:number, staleMs?:number}} [opts]
 * @returns {any|null} 临界区返回值；超时/锁不可用返回 null
 */
export function withFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_LOCK_STALE_MS
  const deadline = Date.now() + timeoutMs
  // 父目录先备好（锁目录本身必须用**非递归** mkdir，见循环内注释）
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch {
    return null // 目录都建不出来（只读文件系统等）→ 降级，不当成锁竞争死等
  }
  for (;;) {
    try {
      // **必须**非递归：`mkdirSync(p, { recursive: true })` 在 p 已存在时**不抛 EEXIST**（该模式是幂等的），
      // 那样每个进程都会「拿到锁」，互斥形同虚设 —— 实测 10 并发仍丢 1 次计数（shadow_runs=9 而非 10）。
      mkdirSync(lockPath)
      break
    } catch (e) {
      // 非 EEXIST（权限、只读文件系统…）不是并发冲突 —— 直接降级，不当成锁竞争死等
      if (!e || e.code !== 'EEXIST') return null
    }
    // 已占用：判陈旧。**owner 确证还活着时绝不回收** —— 这条是并发正确性的要害。
    // 原判据 `age > staleMs || ownerIsDead() === true` 让「超龄」单独即可回收，于是在饱和
    // 负载下（实测 10 并发时单次派发 ~9s，进程被调度出去 15s 完全可能）会连锁出：
    //   A 持锁被挂起 → B 判超龄回收 A 的**活**锁 → B 自己进临界区
    //   → A 醒来执行 finally 无条件 rmSync，把 **B 的**锁也删了
    //   → C 也能进临界区 → B/C 读到同一份快照各写 runs+1 → **静默丢一次更新**
    // 实测症状：10 并发跑出 shadow_runs=9 且**零降级告警**（2026-10-17）。
    // 改成：只有「owner 确证已死」或「owner 判不出（无 owner.json / 异主机 / 元数据损坏）
    // 且已超龄」才回收。防死锁能力不受影响 —— 崩在 mkdir 与写 owner.json 之间的锁属于
    // 「判不出 + 超龄」，照样回收；真死进程走 ownerIsDead 快速通道；而等待方另有
    // timeoutMs 兜底（拿不到锁返回 null 由调用方降级），不存在永久挂死。
    let age = Infinity
    try { age = Date.now() - statSync(lockPath).mtimeMs } catch { age = Infinity }
    const ownerDead = ownerIsDead(lockPath)
    if (ownerDead === true || (ownerDead === null && age > staleMs)) {
      try { rmSync(lockPath, { recursive: true, force: true }) } catch { /* 别人可能刚好在回收 */ }
      continue
    }
    if (Date.now() >= deadline) return null
    sleepSync(POLL_MS)
  }
  try {
    try {
      const owner = `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`
      writeFileSync(path.join(lockPath, 'owner.json'), owner, 'utf8')
    } catch { /* 元数据写不进去不影响互斥本身（回收退化为纯超龄判据） */ }
    return fn()
  } finally {
    try { rmSync(lockPath, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  }
}
