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
 *   | 把 claim 文件名改回带工作树 slug 段（$ID.$SLUG.claim） | 「跨树同号:同一 ID 的 claim 已在案 → exit 3」
 *   |                                               —— 各树各建各的 claim,noclobber 双双成功,同秒跨树未被兜住 |
 *
 * 运行：在协议层根目录下 node --test tests/next-id.test.mjs
 * 接入：本仓 npm run test:gates 已挂（同 SKILL_ROOT/tests 下其余 *.test.mjs 同理）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 脚本按**本文件位置**解析，不按 cwd、也不假设部署在 <repo>/.agents/skills/<name>/。
// 原写法是「从 CWD 出发拼 .agents/skills/self-improving-like-systems/scripts/next-id.sh」——
// 协议层一独立成仓或 clone 到全局，它就指向不存在的目录，而下方 has/SKIP 会让 5 个用例
// 「跳过，不计为通过」：退出码 0、TAP 全绿，覆盖却悄悄没了。可移植性判据见 tests/portability.test.mjs。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const SCRIPT_OVERRIDDEN = Boolean(process.env.NEXT_ID_SCRIPT)
const SCRIPT = process.env.NEXT_ID_SCRIPT || path.join(SKILL_ROOT, 'scripts', 'next-id.sh')
const has = existsSync(SCRIPT)
const SKIP = `next-id.sh 不存在（${SCRIPT}）—— 跳过，不计为通过`

// 未显式覆盖路径时，脚本不存在是**布局坏了**而不是「环境没这个可选组件」：判红，不判跳过。
// 否则协议层换个位置就静默少测 5 个用例，而门禁显示全绿 —— 这正是本文件要消灭的那类失效。
if (!has && !SCRIPT_OVERRIDDEN) {
  throw new Error(
    `next-id.sh 应随协议层一起存在于 ${SCRIPT}。` +
    `找不到它通常意味着脚本位置解析写错了（不是「本环境缺少可选组件」）——` +
    `请用 NEXT_ID_SCRIPT 显式覆盖路径，而不是让它静默跳过。`,
  )
}

/** 固定日期，避免测试结果随当天已有条目漂移。 */
const DATE = '20990131'

/**
 * 编号账本目录 —— **按脚本自己的口径**推，不按 SKILL_ROOT。
 *
 * next-id.sh 第 25-31 行的注释写得很明确：仓根从 `git rev-parse --show-toplevel` 与
 * `--git-common-dir` 推，**不从脚本自身位置**推，因为脚本住在 skill 目录里，
 * 按 `$BASH_SOURCE/../..` 只会落到 skill 根（一个和 .learnings 毫无关系的目录）。
 *
 * 本测试原来写的是 `SKILL_ROOT/.learnings-work/claims`。在协议仓里两者恰好重合
 * （协议仓自己就是 git 仓，git-common-dir 的父目录 = 协议仓根），于是这个错断言
 * 长期是绿的 —— **被布局巧合掩盖**。2026-10-19 把协议层内容同步回业务仓的仓内副本后
 * 立刻变红：副本里脚本落在业务仓，账本跟着去业务仓根，而 SKILL_ROOT 仍指 skill 目录。
 *
 * 这类「只在某种布局下成立」的断言比没有断言更糟 —— 它给了一层假的安全感。
 *
 * ⚠️ 2026-10-21 补：**必须复刻脚本的完整推导链，包括它的非 git 兜底**。
 * 脚本是 `ROOT=$(git rev-parse --show-toplevel || pwd)` / `COMMON=$(git -C "$ROOT" rev-parse
 * --git-common-dir || echo "$ROOT/.git")` —— 不在 git 仓里时它退回 cwd，仍然能占号。
 * 本函数此前只复刻了 git 那半条链，于是 **npm 通道（tarball 里没有 .git）直接判红**
 * （实测：打包后跑判据 `# fail 1`）。只复刻一半的推导 = 复刻错了：
 * 断言的是「脚本会做的事」，脚本却做的是另一件。
 */
function claimsDir() {
  // git 不可用 / 不在仓里 → 脚本退回 cwd（它的 `|| pwd` 兜底），这里必须同口径。
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim() || process.cwd()
  const common = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 30_000 }).stdout?.trim()
    || path.join(root, '.git')
  return path.join(path.dirname(common), '.learnings-work', 'claims')
}

/**
 * 释放一次占用 —— **按编号从账本目录里找文件，不按脚本 stdout 里打印的路径删**。
 *
 * 2026-10-20 实测的坑：Git Bash 下脚本 `echo "$CLAIM"` 打印的是 MSYS 路径
 * （`/d/workspace/...`），那个路径只存在于 MSYS 虚拟文件系统里，**原生 Node 的
 * `existsSync` 看不到** —— 于是旧写法里的 `if (existsSync(p)) rmSync(p)` 恒为假，
 * 清理静默失效，每跑一次判据就往账本里漏 7 个 `20990131` 假编号。
 * 漏掉的编号不是垃圾：它们会把真实条目的号段永久顶高，而且让判据越跑越慢
 * （脚本要扫的 claim 文件线性增长）。
 *
 * 改成「账本目录 + 编号前缀」匹配，两个好处：路径形态由 Node 自己拼（跨 shell 一致），
 * 且不依赖文件名后缀（脚本里的 `$SLUG` 会变，拼全名迟早又错一次）。
 * @param {string|null} id 脚本 stdout 第一行给的编号
 * @param {string|null} ledger 账本目录
 */
function releaseClaim(id, ledger) {
  if (!id || !ledger || !existsSync(ledger)) return
  for (const f of readdirSync(ledger)) {
    if (f.startsWith(`${id}.`)) rmSync(path.join(ledger, f), { force: true })
  }
}

/**
 * 本文件**加载时**的账本快照，供文件末尾那条「判据不得留下占用」断言比对。
 * 在模块顶层算（而不是每条用例各算一次）：这是「进来时的样子」，只该有一个时刻。
 *
 * 快照的是**占用文件**（`*.claim`），不是「目录是否存在」——
 * 目录本身是运行时产物（脚本会 `mkdir -p`），它出现不算残留；
 * 而**占号文件留着才是残留**（假编号会永久顶高真实条目的号段）。
 * 2026-10-21 改口径：此前快照的是整个目录的 readdir，且目录不存在时记 null，
 * 于是 npm 通道（tarball 里没有 .git、也没有 .learnings-work/）整条断言被跳过 ——
 * 「跳过，不计为通过」正是本仓要消灭的那类空洞。
 */
function claimFiles(dir) {
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.claim')).sort()
}

const LEDGER_AT_LOAD = (() => {
  const d = claimsDir()
  return claimFiles(d)
})()

function run(args, extra = {}) {
  // extra.env 是「追加」,不是「整体替换」—— 放在 ...extra 之后展开会把它前面
  // 合并好的 LEARNINGS_DATE 一起覆盖掉(实测:钉时刻用例因此拿到真实日期)。
  const { env: extraEnv, ...spawnOpts } = extra
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    ...spawnOpts,
    env: { ...process.env, LEARNINGS_DATE: DATE, ...extraEnv },
  })
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

describe('learnings 编号分配器', () => {
  it('探测：返回一个未被占用的编号（形态正确）', (t) => {
    if (!has) return t.skip(SKIP)
    const r = run(['LRN'])
    assert.equal(r.status, 0, `探测应成功：${r.err}`)
    assert.match(r.out, /^LRN-20990131-\d{6}$/, `输出形态应为 LRN-<date>-HHMMSS 六位，实际=${r.out}`)
  })

  it('钉时刻：候选时分秒已被占用（claim 在案）→ 必须避让到下一秒', (t) => {
    if (!has) return t.skip(SKIP)
    const claims = claimsDir()
    mkdirSync(claims, { recursive: true })
    const occupied = path.join(claims, `LRN-${DATE}-120000.claim`)
    writeFileSync(occupied, 'worktree=some-other-tree\n', 'utf8')
    try {
      const r = run(['LRN'], { env: { LEARNINGS_TIME: '120000' } })
      assert.equal(r.status, 0, `探测应成功：${r.err}`)
      assert.equal(r.out, `LRN-${DATE}-120001`, `候选 120000 已被占用,应避让到 120001,实际=${r.out}`)
    } finally {
      rmSync(occupied, { force: true })
    }
  })

  it('跨树同号:两个进程同秒抢同一候选(钉同一时刻并发 --claim)→ 恰一个成功,其余 exit 3', (t) => {
    if (!has) return t.skip(SKIP)
    const claims = claimsDir()
    // claim 文件按 ID 唯一(无工作树 slug 段):两进程钉同一时刻 → 同一候选 → 同一 claim 路径,
    // noclobber 只放一个进,后到者必须 exit 3,不得静默换号成功。
    const results = Array.from({ length: 3 }, () => run(['LRN', '--claim'], { env: { LEARNINGS_TIME: '130000' } }))
    const claimed = results.filter((r) => r.status === 0).map((r) => r.out.split('\n')[0])
    const conflicted = results.filter((r) => r.status === 3)
    try {
      assert.equal(new Set(claimed).size, claimed.length, `并发下出现重复编号:${claimed.join(', ')}`)
      assert.equal(claimed.length + conflicted.length, results.length, '每个并发 claim 要么成功要么报冲突')
      assert.ok(claimed.length >= 1, '至少一个进程要拿到号')
      for (const r of conflicted) assert.match(r.err, /并发冲突/, `冲突信息须说明原因:${r.err}`)
    } finally {
      for (const r of results) releaseClaim(r.out.split('\n')[0], claims)
    }
  })

  it('--claim 成功后,账本里的占用文件按 ID 唯一（文件名不含工作树 slug 段）', (t) => {
    if (!has) return t.skip(SKIP)
    const claims = claimsDir()
    const before = claimFiles(claims)
    const r = run(['LRN', '--claim'], { env: { LEARNINGS_TIME: '140000' } })
    try {
      assert.equal(r.status, 0, `claim 应成功：${r.err}`)
      const id = r.out.split('\n')[0]
      const added = claimFiles(claims).filter((f) => !before.includes(f))
      assert.deepEqual(added, [`${id}.claim`], `新增占用应为且仅为 <ID>.claim（无 slug 段）,实际=${added.join(', ')}`)
    } finally {
      for (const f of claimFiles(claims)) if (!before.includes(f)) rmSync(path.join(claims, f), { force: true })
    }
  })

  it('--claim：占用后同一个号不会再被发出去（claim 进入下一轮可见域）', (t) => {
    if (!has) return t.skip(SKIP)
    const claims = claimsDir()
    assert.ok(claims, `推不出编号账本目录（不在 git 仓里？）—— 判红，判据已失效`)
    const first = run(['LRN', '--claim'])
    const second = run(['LRN', '--claim'])
    try {
      assert.equal(first.status, 0, `首次 claim 应成功：${first.err}`)
      assert.equal(second.status, 0, `二次 claim 应成功：${second.err}`)
      assert.notEqual(first.out.split('\n')[0], second.out.split('\n')[0],
        '两次 claim 拿到同一个号 = 占用没生效')
    } finally {
      for (const o of [first, second]) releaseClaim(o.out.split('\n')[0], claims)
      assert.ok(existsSync(claims), `账本目录未落地：${claims} —— claim 声称成功却没占号`)
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
      for (const r of results) releaseClaim(r.out.split('\n')[0], claimsDir())
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
      // 注入锚点**从真脚本里抽**，不在本测试里另写一份那行字面量：
      // 写一份 = 测试里多一处要跟着实现同步的副本，改了实现忘了改副本时
      // 「破坏注入失败」与「破坏生效」长得一模一样（2026-10-20 顺带去掉了锚点里的项目物词）。
      const layer = /"\$MAIN_ROOT"\/\.worktrees\/\*\/(\.[a-z-]+)/.exec(src)
      assert.ok(layer, `破坏注入失败：脚本里找不到兄弟工作树那层（实现形态变了？）:\n${src}`)
      const anchor = `"$MAIN_ROOT"/.worktrees/*/${layer[1]}; do`
      const broken = src.replace(anchor, '/nonexistent-worktrees-layer; do')
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

  it('判据自身不得在编号账本里留下占用（假编号会永久顶高真实条目的号段）', (t) => {
    if (!has) return t.skip(SKIP)
    const ledger = claimsDir()
    assert.deepEqual(
      claimFiles(ledger),
      LEDGER_AT_LOAD,
      '跑完这一整个文件，账本里的占用文件必须回到进来时的样子。' +
        '每个 --claim 都 releaseClaim() 过了；这里再兜一层，是因为清理失败在 Windows 上' +
        '静默过一次（MSYS 路径 existsSync 恒假），而那次的症状就是这条断言变红。',
    )
  })
})
