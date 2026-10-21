/**
 * approve.test.mjs —— 批准落盘 + 守卫注册 + shadow 拦截权自检（node:test，零框架依赖）
 *
 * 口径（票 10 AC 全部 fixture 化）：
 *   - 批准：草案 → 正式条目（过 validateEntry）+ registry 登记（注释保全）+ 守卫骨架生成
 *   - 拒绝：正式区与 registry **零字节变更**（目录内容指纹比对，不靠行为描述）
 *   - 拦截权：新守卫前 N 次 warn-only（违规输入也不阻断）→ 攒满绿运行 → 第 N+1 次起 blocking
 *   - fail-open：守卫自身异常（exit 1 / 起不来）→ 放行 + 审计留痕
 *   - 记账：blocking 期命中 → 条目 recurrence +1 且 last_verified_at 刷新（改完仍过 validateEntry）
 *   - 六拍端到端重放：错误 → capture → distill → approve → guard → 拦截 → recurrence+1，逐拍 exit code 可判
 *   - Tier 0 增量：守卫执行耗时 − 本机 fork 基线 ≤ 500ms（本机 fork 成本是宿主常数，见下方注释）
 *   - 破坏：非法草案 / 双决策 / 缺 ID / 不存在的 key 一律红，且**零变更**
 *
 * fixture = tests/fixtures/approve/（整目录拷到临时目录；实例配置的 kill-switch 默认值永不动）。
 * 双后端：YAML 读取经 scripts/lib/yaml-lite.mjs（宿主无 js-yaml → 降级后端；容器有 js-yaml → js-yaml）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib/strip-comments.mjs'
import { PROJECT_NOUNS, FIXTURE_FORBIDDEN_NOUNS, couplingHits, hitsInFile, repoNounFiles, fixtureNounFiles } from './lib/coupling-scan.mjs'
import { addEntryToCoverage } from '../scripts/approve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')

/**
 * 本文件**不得自己持有被禁形态**（它也在扫描面里）。需要样本词时一律从共享词表取，
 * 而不是就地写一个 —— 就地写等于在扫描面里埋一份副本，改词表时它不会跟着变，
 * 于是「词表已收紧、这份副本还在」变成静默通过。probe 取词表首条（learning-dir）。
 */
const probe = PROJECT_NOUNS[0]

/**
 * 豁免台账判定：把「各文件的命中」折成「应当判红的理由列表」，空数组 = 通过。
 * 三种越界各自判红：① 命中但未登记；② 登记了却实际没命中（豁免已失效，登记变成永久免检）；
 * ③ 登记的词条集合与实际不符（词表改过，豁免没跟上）。
 *
 * 单独抽成纯函数是为了能对它做破坏测试：台账逻辑写在 `it()` 里就只能在真实扫描面上生效，
 * 而真实扫描面是干净的 —— 于是「台账判据恒绿」与「扫描面确实干净」无法区分。
 */
function ledgerViolations(entries, allowlist) {
  const allow = new Map(allowlist.map((a) => [a.file, a]))
  const violations = []
  for (const e of entries) {
    if (e.hits.length === 0) continue
    const a = allow.get(e.file)
    if (!a) {
      violations.push(`${e.file} 命中项目物 [${e.hits.join(', ')}] 且不在豁免台账内`)
      continue
    }
    const declared = [...a.expect].sort().join(',')
    const actual = [...new Set(e.hits)].sort().join(',')
    if (declared !== actual) violations.push(`${e.file} 豁免台账声明 [${declared}] 与实际命中 [${actual}] 不符`)
  }
  return violations
}
const APPROVE = path.join(SKILL_ROOT, 'scripts', 'approve.mjs')
const RUNNER = path.join(SKILL_ROOT, 'scripts', 'run-guard.mjs')
const CAPTURE = path.join(SKILL_ROOT, 'scripts', 'capture.mjs')
const DISTILL = path.join(SKILL_ROOT, 'scripts', 'distill.mjs')
const VALIDATE = path.join(SKILL_ROOT, 'scripts', 'validate.mjs')
const VERIFY = path.join(SKILL_ROOT, 'scripts', 'verify.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'approve')
const PROPOSAL = 'PROP-20261016-a1b2c3d4e5f60718-vitest-worker-timeout.md'
const GUARD_KEY = 'guard-tool-error-vitest-worker-timeout'
const ENTRY_ID = 'ERR-20261016-003'
const ENTRY_NAME = `${ENTRY_ID}-vitest-worker-timeout.md`
const VIOLATION = 'vitest worker pool exhausted: Test timed out in 10000ms'
const CLEAN = 'chore: bump a dependency, nothing relevant here'

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'approve-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

function runCli(cli, args, dir, { config = 'config-on.yaml' } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args, '--config', path.join(dir, config)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const approveArgs = (dir, extra = []) => [
  '--proposal', path.join(dir, 'seed-proposal', PROPOSAL),
  '--guard-script', 'guards/vitest-worker-timeout.mjs',
  ...extra,
]

/** 批准草案（默认 ID + 守卫脚本路径），返回 CLI 结果。 */
function doApprove(dir, extra = []) {
  return runCli(APPROVE, approveArgs(dir, ['--approve', '--id', ENTRY_ID, ...extra]), dir)
}

/** 派发一次守卫（可喂文本）。 */
function dispatch(dir, { key = GUARD_KEY, text = CLEAN, config = 'config-on.yaml' } = {}) {
  return runCli(RUNNER, ['--key', key, '--text', text], dir, { config })
}

/** 目录内容指纹（递归、含内容哈希）—— 「零变更」用它证明。
 *  audit/ 与 guard-state.json 是**旁路账本**（本地 gitignored 的运行时留痕），落它们是设计内行为，
 *  「零变更」断言只看仓内事实：条目区 / 提案区 / registry / 守卫脚本。 */
function treeDigest(dir) {
  if (!existsSync(dir)) return '<absent>'
  const skip = new Set(['audit', 'guard-state.json'])
  const walk = (d, prefix = '') =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        if (prefix === '' && skip.has(name)) return []
        const p = path.join(d, name)
        const rel = prefix ? `${prefix}/${name}` : name
        if (statSync(p).isDirectory()) return walk(p, rel)
        return [`${rel}:${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)}`]
      })
  return walk(dir).join('\n')
}

/** 校验条目区（走技能校验器 CLI 的目录扫描形态）。 */
function validateEntries(dir) {
  return runCli(VALIDATE, ['--all', path.join(dir, 'entries')], dir)
}

const readState = (dir) => JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8')).guards
const readEntryLedger = (dir) => JSON.parse(readFileSync(path.join(dir, 'guard-state.json'), 'utf8')).entries ?? {}
const sweep = (dir) => runCli(VERIFY, ['--sweep'], dir)
const entryText = (dir, name = ENTRY_NAME) => readFileSync(path.join(dir, 'entries', name), 'utf8')
const frontValue = (text, key) => {
  const m = new RegExp(`^${key}: (.*)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}

/** 把 shadow 计数清零（切到"新守卫"起点），用来看"第 N+1 次起 blocking"。 */
function resetShadow(dir) {
  rmSync(path.join(dir, 'guard-state.json'), { force: true })
}

describe('批准落盘（条目 + 守卫登记 + 守卫骨架）', () => {
  it('正向：条目落正式区并过校验、registry 追加三键 + 实体字段、既有注释原样留存', () => {
    const dir = freshTmp()
    try {
      const before = readFileSync(path.join(dir, 'registry.yaml'), 'utf8')
      const r = doApprove(dir)
      assert.equal(r.status, 0, r.all)

      const text = entryText(dir)
      assert.match(text, /^---\n/, 'frontmatter 必须存在')
      assert.equal(frontValue(text, 'status'), 'resolved', '批准即 resolved（否则 D13 绑定门禁无从判定）')
      assert.equal(frontValue(text, 'guard_ref'), GUARD_KEY)
      // 拍1 接线：草案里记的来源事件必须搬进条目前置元数据，否则「这条经验由哪些事实学来」
      // 在批准那一刻就永久丢失（历史包袱：条目与事件之间曾不存在任何一条链，拍1 恒红）。
      assert.equal(frontValue(text, 'event_ids'), '["evt-20261016-007","evt-20261016-008"]')
      assert.ok(!text.includes('这是提案，不是条目'), '草案定性抬头必须被批准抬头取代')
      assert.match(text, /批准记录/, '必须留批准记录（谁批的、批了什么）')
      assert.match(text, /vitest worker pool exhausted/, '草案正文（触发样本）必须原样留存')

      // 判据单一归宿：落盘后的条目必须过技能校验器
      const v = validateEntries(dir)
      assert.equal(v.status, 0, `落盘条目未过 validate.mjs:\n${v.all}`)

      const after = readFileSync(path.join(dir, 'registry.yaml'), 'utf8')
      assert.ok(after.startsWith(before.trimEnd().slice(0, 40)), 'registry 头部注释必须原样留存（文本追加，不是整体重序列化）')
      assert.match(after, /# registry fixture/, '既有注释不得丢失')
      assert.match(after, new RegExp(`- key: "?${GUARD_KEY}"?`), 'registry 必须登记该守卫')
      // 2026-10-16（F5）：when 是声明性注解且派发器不求值，默认值**不得**写死宿主 plan 字段名
      // （通用技能拿不到各仓自有的 classifyStaged 字段，见 schema.md §3 理由②）。
      // 断言容忍 YAML 可选引号：approve 的 scalar() 只给「标识符形态」免引号，
      // 含连字符的中性占位值会被双引号包裹（两者都是合法 YAML 同一字符串）。
      assert.match(after, /when:\s*"?host-hook-route-field"?/, 'dispatch 三键齐全（when 为中性占位注解，接线时由项目替换成本宿主字段）')
      assert.match(after, /kind: gate/, 'Guard 实体字段登记')
      assert.match(after, /covered_entries: \["ERR-20261016-003"\]/, '绑定条目 ID')
      assert.match(after, /mode: shadow/, '登记即 shadow —— 拦截权要挣，不是注册即得')

      const guard = path.join(dir, 'guards', 'vitest-worker-timeout.mjs')
      assert.ok(existsSync(guard), '守卫骨架应生成')
      const gsrc = readFileSync(guard, 'utf8')
      assert.match(gsrc, /process\.exit\(2\)/, '守卫契约：命中判据 exit 2')
      assert.match(gsrc, /--input-stdin/, '守卫须支持派发层喂 stdin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('守卫骨架判据可执行：破坏测试 —— 违规样本变红、正常样本保持绿', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      const guard = path.join(dir, 'guards', 'vitest-worker-timeout.mjs')
      const bad = spawnSync('node', [guard, '--input-stdin'], { input: VIOLATION, encoding: 'utf8' })
      const good = spawnSync('node', [guard, '--input-stdin'], { input: 'refactor: rename a local variable', encoding: 'utf8' })
      assert.equal(bad.status, 2, `违规样本必须命中判据:\n${bad.stdout}${bad.stderr}`)
      assert.equal(good.status, 0, `正常样本必须放行:\n${good.stdout}${good.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('node 骨架的判据语义 = POSIX ERE（不是 JS RegExp）：字符类认、反斜杠类不认', () => {
    // 「什么算命中」是**人的决定**，不是骨架生成器可以偷换的实现细节。
    // 换方言会静默改变判据，两条判据各自证明方言没被换：
    //   ① [[:digit:]] 是 **ERE 独有**的字符类（JS RegExp 没有，会当成字面字符集）→ ERE 必须命中；
    //   ② \d 在 **JS RegExp 里是数字类**、在 POSIX ERE 里只是字面 'd' → ERE 必须不命中。
    // 任一条结果相反 = 判据方言被偷换 = 命中面悄悄变了。
    const dirA = freshTmp()
    try {
      const r = doApprove(dirA, ['--pattern', 'a[[:digit:]]+b'])
      assert.equal(r.status, 0, r.all)
      const guard = path.join(dirA, 'guards', 'vitest-worker-timeout.mjs')
      const hit = spawnSync('node', [guard, '--input-stdin'], { input: 'xx a123b yy', encoding: 'utf8' })
      assert.equal(hit.status, 2, `ERE 字符类 [[:digit:]] 必须命中（JS RegExp 下它不命中）:\n${hit.stdout}${hit.stderr}`)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
    }
    const dirB = freshTmp()
    try {
      const r = doApprove(dirB, ['--pattern', 'a\\db'])
      assert.equal(r.status, 0, r.all)
      const guard = path.join(dirB, 'guards', 'vitest-worker-timeout.mjs')
      const hit = spawnSync('node', [guard, '--input-stdin'], { input: 'xx a1b yy', encoding: 'utf8' })
      assert.equal(hit.status, 0, `ERE 下 \\d 不是数字类（只有 JS RegExp 才是）—— 命中即说明方言被偷换:\n${hit.stdout}${hit.stderr}`)
    } finally {
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('dry-run 零写盘：只报告将要落什么', () => {
    const dir = freshTmp()
    try {
      const before = treeDigest(dir)
      const r = doApprove(dir, ['--dry-run'])
      assert.equal(r.status, 0, r.all)
      assert.equal(treeDigest(dir), before, 'dry-run 不得有任何写盘')
      assert.equal(readdirSync(path.join(dir, 'entries')).filter((f) => f.endsWith('.md')).length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('幂等：同 key 重复批准不产生第二条 registry 登记；条目已存在则 exit 1 且零变更', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      const afterFirst = treeDigest(dir)
      const second = doApprove(dir)
      assert.equal(second.status, 1, '目标条目已存在必须硬失败，不许静默覆盖')
      assert.equal(treeDigest(dir), afterFirst, '重复批准零变更')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * 共享守卫的第二个条目（2026-10-17 修的真缺陷）。
 *
 * 缺陷形态：同 key 已存在时 approve 原先整段跳过 registry 写入，于是第二个条目
 * 绑到共享守卫上时永远进不了该守卫的 covered_entries；而 trace 拍3 正是按
 * covered_entries 判 —— 结果六拍对「同守卫的第二个条目」结构性不可完成。
 */
describe('共享守卫的第二个条目（covered_entries 并入）', () => {
  const SECOND_ID = 'ERR-20261016-004'

  it('正向：第二个条目并入既有守卫的 covered_entries，且不新增第二条 key 登记', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      const first = doApprove(dir, ['--id', SECOND_ID, '--guard-key', GUARD_KEY])
      assert.equal(first.status, 0, `第二个条目批准必须成功：${first.all}`)

      const registry = readFileSync(path.join(dir, 'registry.yaml'), 'utf8')
      assert.equal(
        registry.split(`- key: "${GUARD_KEY}"`).length - 1,
        1,
        '同 key 不得登记第二条',
      )
      assert.match(registry, new RegExp(`covered_entries: \\[[^\\]]*${ENTRY_ID}`), `首个条目必须在册：\n${registry}`)
      assert.match(registry, new RegExp(`covered_entries: \\[[^\\]]*${SECOND_ID}`), `第二个条目必须在册：\n${registry}`)

      const cov = /covered_entries: \[([^\]]*)\]/.exec(registry.slice(registry.indexOf(`- key: "${GUARD_KEY}"`)))[1]
      assert.ok(cov.includes(ENTRY_ID) && cov.includes(SECOND_ID), '两个条目必须在同一守卫的 covered_entries 里')

      assert.match(first.all, /并入 covered_entries/, '日志须明说这次是「并入覆盖」而不是「跳过」')
      assert.ok(existsSync(path.join(dir, 'entries', `${SECOND_ID}-vitest-worker-timeout.md`)), '第二个条目须落正式区')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('幂等：第二个条目重复并入不产生重复 ID、不改动 registry', () => {
    const dir = freshTmp()
    try {
      doApprove(dir)
      doApprove(dir, ['--id', SECOND_ID, '--guard-key', GUARD_KEY])
      const registryPath = path.join(dir, 'registry.yaml')
      const after = readFileSync(registryPath, 'utf8')
      // 再跑一次**仅覆盖并入**这一步（条目已存在会硬失败，所以直接调导出函数）
      const twice = addEntryToCoverage(after, GUARD_KEY, SECOND_ID)
      assert.equal(twice, after, '已并入的 ID 不得重复追加（回归会导致 covered_entries 无限膨胀）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('块边界：本守卫缺 covered_entries 时不得吞掉下一个守卫的那一行', () => {
    const raw = [
      'guards:',
      '  - key: no-coverage',
      "    args: ['a.sh']",
      '    when: always',
      '  - key: has-coverage',
      "    args: ['b.sh']",
      "    covered_entries: ['ERR-20261016-009']",
      '',
    ].join('\n')
    const out = addEntryToCoverage(raw, 'no-coverage', 'ERR-20261016-003')
    assert.equal(out, raw, '不得跨块把条目并进别的守卫（静默错账比不写更糟）')
    const ok = addEntryToCoverage(raw, 'has-coverage', 'ERR-20261016-003')
    assert.match(ok, /- key: has-coverage[\s\S]*covered_entries: \[[^\]]*ERR-20261016-009[^\]]*ERR-20261016-003[\"']?\]/)
  })

  it('找不到目标 key 时原样返回（不凭空造条目）', () => {
    const raw = "guards:\n  - key: other\n    covered_entries: ['ERR-1']\n"
    assert.equal(addEntryToCoverage(raw, 'missing-key', 'ERR-2'), raw)
  })
})

describe('拒绝路径（零变更）', () => {
  it('--reject：正式区与 registry 一个字节都不动', () => {
    const dir = freshTmp()
    try {
      const before = treeDigest(dir)
      const r = runCli(APPROVE, ['--proposal', path.join(dir, 'seed-proposal', PROPOSAL), '--reject', '--reason', '根因证据不足'], dir)
      assert.equal(r.status, 0, r.all)
      assert.equal(treeDigest(dir), before, '拒绝路径必须零变更（git 级证明的等价断言）')
      assert.match(r.all, /rejected/, '拒绝须有可观测留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拒绝不接受任何落盘参数（防止"顺手批准了一半"）', () => {
    const dir = freshTmp()
    try {
      const r = runCli(APPROVE, ['--proposal', path.join(dir, 'seed-proposal', PROPOSAL), '--reject', '--id', ENTRY_ID], dir)
      assert.equal(r.status, 2, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('拦截权要挣（shadow → blocking）', () => {
  it('前 3 次运行即喂违规样本：只 warn-only，全部 exit 0（不阻断 commit）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      for (let i = 1; i <= 3; i++) {
        const r = dispatch(dir, { text: VIOLATION })
        assert.equal(r.status, 0, `第 ${i} 次必须 warn-only 放行:\n${r.all}`)
        assert.match(r.all, /shadow-warn|命中判据但尚在 shadow/, `第 ${i} 次必须打印 shadow 警告:\n${r.all}`)
      }
      const st = readState(dir)[GUARD_KEY]
      assert.equal(st.mode, 'shadow', '违规过 3 次仍不许升 blocking（判据抓不准的守卫就该永远只是警告）')
      assert.equal(st.shadow_runs, 3)
      assert.equal(st.shadow_green, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('3 次全绿后升 blocking，第 4 次命中判据 exit 2 阻断', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      for (let i = 1; i <= 3; i++) {
        const r = dispatch(dir, { text: CLEAN })
        assert.equal(r.status, 0, `第 ${i} 次绿运行必须放行:\n${r.all}`)
      }
      assert.equal(readState(dir)[GUARD_KEY].mode, 'blocking', '3 次全绿必须自动升 blocking')
      const blocked = dispatch(dir, { text: VIOLATION })
      assert.equal(blocked.status, 2, `第 4 次命中必须阻断（exit 2）:\n${blocked.all}`)
      assert.match(blocked.all, /命中判据 → 阻断/, blocked.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--all 派发：blocking 守卫命中 → 整体 exit 2；debt-stub 桩跳过不派发', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      for (let i = 0; i < 3; i++) dispatch(dir)
      const r = runCli(RUNNER, ['--all', '--text', VIOLATION], dir)
      assert.equal(r.status, 2, r.all)
      assert.match(r.all, /legacy-unbound skipped/, '债务桩必须被跳过（它指向绑定门禁自身，不是条目判据）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('记账与异常（fail-open）', () => {
  it('blocking 命中 → 只记运行时账（仓内零改动），sweep 后 recurrence +1、last_verified_at 刷新且仍过 validateEntry', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      const before = Number(frontValue(entryText(dir), 'recurrence'))
      assert.equal(frontValue(entryText(dir), 'last_verified_at'), 'null')
      for (let i = 0; i < 3; i++) dispatch(dir)
      const entriesBefore = entryText(dir)
      assert.equal(dispatch(dir, { text: VIOLATION }).status, 2)
      // 票 11 分层：命中是高频事件，只落运行时状态文件 —— 仓内条目此刻必须**一字未动**。
      assert.equal(entryText(dir), entriesBefore, '高频命中不得改写仓内条目（脏工作区 = 无意义 churn）')
      const ledger = readEntryLedger(dir)[ENTRY_ID]
      assert.equal(ledger.pending_hits, 1, '命中须记进运行时账的待回写明细')
      assert.equal(ledger.hits, undefined, '旧 hits 字段已退役（两型分账：wild_hits / probe_hits）')
      assert.equal(ledger.wild_hits, 1, '真实路由上的捕获记 wild 账')
      assert.equal(ledger.probe_hits, 0, 'wild 命中不得落进 probe 账')
      assert.ok(Array.isArray(ledger.pending_records) && ledger.pending_records.length === 1, '待回写明细须带守卫与日期')

      const sw = sweep(dir)
      assert.equal(sw.status, 0, sw.all)
      const after = entryText(dir)
      assert.equal(Number(frontValue(after, 'recurrence')), before + 1, 'sweep 后 recurrence 必须 +1（六拍命中记账）')
      assert.match(frontValue(after, 'last_verified_at'), /^"\d{4}-\d{2}-\d{2}"$/, '日期必须带引号（裸日期两条 YAML 后端都判红）')
      assert.equal(readEntryLedger(dir)[ENTRY_ID].pending_hits, 0, '回写后账须清零（否则下拍双记）')
      const v = validateEntries(dir)
      assert.equal(v.status, 0, `记账改写后条目仍须过校验:\n${v.all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('守卫自身异常（exit 1）→ fail-open：放行 exit 0 + last_result=error + 审计留痕', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      // 把真守卫换成一个"自己坏了"的守卫：内部抛错路径以 exit 1 返回（非约定码 = 异常）
      writeFileSync(
        path.join(dir, 'guards', 'vitest-worker-timeout.mjs'),
        '#!/usr/bin/env node\nconsole.error("boom: 守卫内部抛异常")\nprocess.exit(1)\n',
        'utf8',
      )
      const r = dispatch(dir, { text: VIOLATION })
      assert.equal(r.status, 0, `守卫自己坏了不许阻塞提交:\n${r.all}`)
      assert.match(r.all, /fail-open/, r.all)
      const st = readState(dir)[GUARD_KEY]
      assert.equal(st.last_result, 'error', '异常须留痕（last_result=error）')
      const audit = readFileSync(path.join(dir, 'audit', 'audit.jsonl'), 'utf8')
      assert.match(audit, /"action":"guard-error"/, '审计必须留痕')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('守卫起不来（command 指向不存在的文件）→ 同样 fail-open', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      rmSync(path.join(dir, 'guards', 'vitest-worker-timeout.mjs'))
      const r = dispatch(dir, { text: VIOLATION })
      assert.equal(r.status, 0, `守卫缺失不得阻塞提交:\n${r.all}`)
      assert.equal(readState(dir)[GUARD_KEY].last_result, 'error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 票 H2 · 架构审计 F9：守卫 error 按设计 fail-open，但「连续 error」必须**看得见**（纪律不变、只加可见性）。 */
describe('守卫静默失效可见性（error_streak + --dry-run 视图）', () => {
  const dryRun = (dir, extra = []) =>
    runCli(RUNNER, ['--dry-run', '--all', ...extra], dir)

  it('连续 3 次 error → error_streak=3 且 --dry-run 单列告警（但放行纪律不变，仍 exit 0）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      writeFileSync(
        path.join(dir, 'guards', 'vitest-worker-timeout.mjs'),
        '#!/usr/bin/env node\nconsole.error("boom: 守卫内部抛异常")\nprocess.exit(1)\n',
        'utf8',
      )
      for (let i = 0; i < 3; i++) {
        const r = dispatch(dir, { text: VIOLATION })
        assert.equal(r.status, 0, 'fail-open 纪律：守卫自己坏了照样放行')
      }
      const st = readState(dir)[GUARD_KEY]
      assert.equal(st.error_streak, 3, '连续 3 次 error 必须记成 3（累计口径分不出连挂，故单独记）')
      assert.equal(st.error_runs, 3, '累计 error 也要记（与 streak 分开，两者口径不同）')
      const r = dryRun(dir)
      assert.equal(r.status, 0, '报表恒 0（只读视图，不改变放行行为）')
      assert.match(r.all, /连续 error 守卫 1 条/, `连续 error 必须被点名:\n${r.all}`)
      assert.match(r.all, new RegExp(`${GUARD_KEY} · 连续 error 3 次`), r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('error 之后一次成功 → error_streak 清零（连挂与间断必须可分，这正是单列该字段的理由）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      writeFileSync(path.join(dir, 'guards', 'vitest-worker-timeout.mjs'), '#!/usr/bin/env node\nprocess.exit(1)\n', 'utf8')
      for (let i = 0; i < 2; i++) assert.equal(dispatch(dir, { text: VIOLATION }).status, 0)
      assert.equal(readState(dir)[GUARD_KEY].error_streak, 2)
      writeFileSync(path.join(dir, 'guards', 'vitest-worker-timeout.mjs'), '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8')
      assert.equal(dispatch(dir, { text: CLEAN }).status, 0)
      const st = readState(dir)[GUARD_KEY]
      assert.equal(st.error_streak, 0, '成功一次即清零（累计 error_runs 仍是 2 —— 两者口径不同）')
      assert.equal(st.error_runs, 2, '历史累计不被清零（两者分开的意义就在这）')
      assert.doesNotMatch(dryRun(dir).all, /连续 error 守卫 \d+ 条/, 'streak 清零后不该再进静默失效清单')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('单次 error 不告警（阈值 3：单次多为环境抖动，报了就是噪音）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      writeFileSync(path.join(dir, 'guards', 'vitest-worker-timeout.mjs'), '#!/usr/bin/env node\nprocess.exit(1)\n', 'utf8')
      assert.equal(dispatch(dir, { text: VIOLATION }).status, 0)
      assert.equal(readState(dir)[GUARD_KEY].error_streak, 1)
      assert.match(dryRun(dir).all, /无连续 error ≥ 3 次的守卫/, `单次 error 不该进清单:\n${dryRun(dir).all}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 票 H2 · 架构审计 F4/F8：`when` 从不执行 —— 契约口径必须与实现一致，不留「假装已接线」的注解。 */
describe('registry.when 的运行时口径（声明性注解，派发器不求值）', () => {
  it('--all 无条件派发：when 非 always 的条目照样被派发并记账', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      // 把 when 改成一个「若被求值就会跳过本守卫」的值：仍必须被派发
      const regPath = path.join(dir, 'registry.yaml')
      writeFileSync(regPath, readFileSync(regPath, 'utf8').replace(/^\s*when:.*$/m, '    when: neverTruePredicate'), 'utf8')
      const r = runCli(RUNNER, ['--all', '--text', CLEAN], dir)
      assert.equal(r.status, 0, r.all)
      const st = readState(dir)[GUARD_KEY]
      assert.equal(st.shadow_runs, 1, 'when 绝不参与过滤：跳过派发会掐断 shadow 计数（拦截权永远挣不到）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--dry-run 原样列出 when 并标注未求值（注解不许冒充已接线的假象）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      const r = runCli(RUNNER, ['--dry-run', '--all', '--json'], dir)
      assert.equal(r.status, 0, r.all)
      // registry 里有多条守卫（债务桩 + 本守卫），必须定位到**本守卫那一块**再取 when
      // （approve 落盘时 key 带引号，故匹配要允许可选引号）
      const block = readFileSync(path.join(dir, 'registry.yaml'), 'utf8')
        .split(/\n(?=\s*-\s*key:)/)
        .find((b) => new RegExp(`key:\\s*"?${GUARD_KEY}"?`).test(b))
      assert.ok(block, `registry 须含 ${GUARD_KEY} 条目`)
      const declared = /^\s*when:\s*(.+)$/m.exec(block)
      assert.ok(declared, 'registry 须声明 when')
      // ⚠ 必须剥掉 YAML 标量引号再比（2026-10-16 修）：断言的语义是「run-guard 原样带出
      // registry 里声明的值、不改写不求值」，而 declared 取的是**文本行**，row.when 取的是
      // **解析后的值**。两者在带引号时天然不同（`"host-hook-route-field"` vs `host-hook-route-field`）——
      // 原断言只在「值恰好像标识符、approve 未加引号」时才偶然通过，属恒绿断言。
      const declaredValue = declared[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      const row = JSON.parse(r.stdout).guards.find((g) => g.key === GUARD_KEY)
      assert.equal(row.when, declaredValue, 'when 原样带出（不改写、不求值）')
      assert.equal(row.when_evaluated, false, '必须显式标注派发器不求值')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Tier 0 增量预算', () => {
  it('守卫派发成本 ≤ 10×本机 fork 常数（负载无关口径 · 2026-10-17 改判据）', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      // **判据为什么从「时长」改成「fork 当量倍数」**（2026-10-17 实测三次才定位到）：
      // 这条断言的真实意图是守住 O(1) spawn 纪律 —— 防「按文件起子进程」那个 98s 前科
      // （48 条目 × 每文件一次 spawn）。那是**计数**约束，被写成时长约束就必然随机器负载抖动：
      //   实测同一份代码、同一台机器，fork 基线 182→381ms（负载翻倍），守卫直调 880→2469ms，
      //   原公式「500ms + 2×fork」在 idle 时刚好够、在繁忙时必红 —— 同一提交时绿时红。
      // 而 fork 当量倍数是**无量纲**的：正常路径 = bash + cat + grep 共 3 次 fork ≈ 3-4 当量；
      // 按文件 spawn 的回归 = 48+ 当量（98s 那次是它的 1/20 量级都不到）。
      // 12 当量的上限留足 3 倍余量仍能把 98s 级回归挡在外面（那会是数百当量）。
      //
      // 同时保留一个**绝对天花板**：比例判据对「fork 极慢但次数对」免疫，但不该放过真正挂死的守卫。
      const probe = path.join(dir, 'baseline.sh')
      writeFileSync(probe, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
      const time = (fn) => {
        const t0 = process.hrtime.bigint()
        fn()
        return Number(process.hrtime.bigint() - t0) / 1e6
      }
      time(() => spawnSync('bash', [probe], { encoding: 'utf8' })) // 预热，避免首次 fork 冷启动计入基线
      // 基线取**中位数**、采样 5 次：中位数抗单次抖动（min() 是乐观统计量，用它当分母方向就是错的）。
      const samples = []
      for (let i = 0; i < 5; i++) samples.push(time(() => spawnSync('bash', [probe], { encoding: 'utf8' })))
      samples.sort((a, b) => a - b)
      const baseline = samples[Math.floor(samples.length / 2)]
      const FORK_EQUIVALENT_BUDGET = 12
      const HANG_CEILING_MS = 15_000 // 与比例无关的兜底：挂死的守卫必须在 15s 内被看见
      const run = runCli(RUNNER, ['--key', GUARD_KEY, '--text', CLEAN, '--json'], dir) // 完整派发：读 registry + 直调守卫 + 写状态 + 审计
      assert.equal(run.status, 0, run.all)
      const elapsed = Number(JSON.parse(run.stdout).elapsed_ms)
      const equivalents = elapsed / baseline
      console.error(
        `[tier0] fork 基线中位 ${baseline.toFixed(0)}ms（采样 ${samples.map((s) => s.toFixed(0)).join('/')}）· ` +
          `守卫直调 ${elapsed.toFixed(0)}ms = ${equivalents.toFixed(1)} fork 当量 · 预算 ${FORK_EQUIVALENT_BUDGET} 当量 + ${HANG_CEILING_MS}ms 兜底`,
      )
      assert.ok(
        equivalents <= FORK_EQUIVALENT_BUDGET,
        `守卫超出 O(1) spawn 预算：实测 ${equivalents.toFixed(1)} fork 当量 > ${FORK_EQUIVALENT_BUDGET}` +
          `（${elapsed.toFixed(0)}ms / 基线 ${baseline.toFixed(0)}ms）。按文件起子进程的前科是 98s（数百当量）。`,
      )
      assert.ok(elapsed <= HANG_CEILING_MS, `守卫疑似挂死：${elapsed.toFixed(0)}ms > ${HANG_CEILING_MS}ms`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('六拍端到端重放（错误 → 事件 → 条目 → 守卫 → 拦截 → recurrence+1）', () => {
  it('全链走通，逐拍 exit code 可判', () => {
    const dir = freshTmp()
    try {
      const beats = []
      // 拍 1：错误（人为构造一次真实工具失效的原文）
      const errorText = 'Test timed out in 10000ms. vitest worker pool exhausted (ETIMEDOUT)'
      beats.push(['1-错误', 0, '错误原文已构造'])

      // 拍 2：事件（capture 写事件库）
      const cap = runCli(CAPTURE, ['--source', 'tool', '--kind', 'tool_error', '--severity', 'error', '--text', errorText], dir)
      beats.push(['2-事件 capture', cap.status, cap.all.trim().split('\n').slice(-1)[0]])
      assert.equal(cap.status, 0, cap.all)
      const shards = readdirSync(path.join(dir, 'events')).filter((f) => f.endsWith('.jsonl'))
      assert.equal(shards.length, 1, `事件库应有当日分片，实际 ${JSON.stringify(shards)}`)

      // 拍 3：草案（distill 聚簇出 Entry 草案；只提案不落盘）
      const dis = runCli(DISTILL, [], dir)
      assert.equal(dis.status, 0, dis.all)
      const proposals = readdirSync(path.join(dir, 'proposals')).filter((f) => f.endsWith('.md'))
      assert.equal(proposals.length, 1, `应出一份草案，实际 ${JSON.stringify(proposals)}`)
      assert.equal(readdirSync(path.join(dir, 'entries')).filter((f) => f.endsWith('.md')).length, 0, 'distill 阶段正式区仍须零写入')
      beats.push(['3-草案 distill', dis.status, `proposals=${proposals.length} 份 · 正式区零写入`])

      // 拍 4：条目 + 守卫登记（approve 落盘）
      const app = runCli(APPROVE, [
        '--proposal', path.join(dir, 'proposals', proposals[0]),
        '--approve', '--id', ENTRY_ID, '--guard-script', 'guards/replay.sh',
      ], dir)
      assert.equal(app.status, 0, app.all)
      beats.push(['4-条目+守卫 approve', app.status, `entries=${readdirSync(path.join(dir, 'entries')).join(',')}`])

      // 拍 5：守卫跑起来（3 次绿 → 挣到 blocking）
      const guardKey = /- key: (\S+)/.exec(app.all)?.[1] ?? /守卫 (\S+) 登记/.exec(app.all)?.[1]
      assert.ok(guardKey, `须从 approve 输出取到守卫 key:\n${app.all}`)
      for (let i = 0; i < 3; i++) {
        const g = runCli(RUNNER, ['--key', guardKey, '--text', CLEAN], dir)
        assert.equal(g.status, 0, g.all)
      }
      beats.push(['5-守卫 shadow→blocking', 0, `mode=${readState(dir)[guardKey].mode}`])
      assert.equal(readState(dir)[guardKey].mode, 'blocking')

      // 拍 6：拦截（记运行时账）+ 证伪拍 sweep（回写 recurrence +1 与末尾对质段）
      const entryFile = readdirSync(path.join(dir, 'entries')).find((f) => f.startsWith(`${ENTRY_ID}-`))
      const before = Number(frontValue(readFileSync(path.join(dir, 'entries', entryFile), 'utf8'), 'recurrence'))
      const blocked = runCli(RUNNER, ['--key', guardKey, '--text', errorText], dir)
      assert.equal(blocked.status, 2, `命中判据必须阻断:\n${blocked.all}`)
      assert.equal(readEntryLedger(dir)[ENTRY_ID].pending_hits, 1, '命中须记入运行时账待 sweep')
      const sw = sweep(dir)
      assert.equal(sw.status, 0, sw.all)
      const afterText = readFileSync(path.join(dir, 'entries', entryFile), 'utf8')
      const after = Number(frontValue(afterText, 'recurrence'))
      beats.push(['6-拦截 exit 2', blocked.status, `拦截后 sweep 回写 recurrence ${before} → ${after}（+末尾对质段）`])
      assert.equal(after, before + 1, '命中必须 recurrence +1 可观测（经 sweep 回写）')
      assert.match(afterText, new RegExp(`^### 复发 ${after} · \\d{4}-\\d{2}-\\d{2}$`, 'm'), '条目末尾须追加对质段（编号接在既有 recurrence 之后）')

      for (const [name, code, note] of beats) console.error(`[六拍] ${name} → exit ${code} · ${note}`)
      // 全链可判：每拍退出码都在 beats 里，任何一拍非预期都会在上面的断言处炸
      assert.deepEqual(
        beats.map((b) => b[1]),
        [0, 0, 0, 0, 0, 2],
        '六拍退出码序列必须是 0,0,0,0,0,2',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('破坏测试（红向）', () => {
  it('非法草案（scope 不在枚举）→ exit 1 且零变更', () => {
    const dir = freshTmp()
    try {
      const p = path.join(dir, 'seed-proposal', PROPOSAL)
      writeFileSync(p, readFileSync(p, 'utf8').replace('scope: testing', 'scope: not-a-domain'), 'utf8')
      const before = treeDigest(dir)
      const r = doApprove(dir)
      assert.equal(r.status, 1, r.all)
      assert.match(r.all, /scope 非法/, r.all)
      assert.equal(treeDigest(dir), before, '非法草案必须零变更')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用法错误：双决策 / 缺 ID / 缺守卫脚本 → exit 2 且零变更', () => {
    const dir = freshTmp()
    try {
      const before = treeDigest(dir)
      const pp = path.join(dir, 'seed-proposal', PROPOSAL)
      const both = runCli(APPROVE, ['--proposal', pp, '--approve', '--reject', '--id', ENTRY_ID], dir)
      assert.equal(both.status, 2, both.all)
      const noId = runCli(APPROVE, ['--proposal', pp, '--approve', '--guard-script', 'g.sh'], dir)
      assert.equal(noId.status, 2, noId.all)
      const noGuard = runCli(APPROVE, ['--proposal', pp, '--approve', '--id', ENTRY_ID], dir)
      assert.equal(noGuard.status, 2, noGuard.all)
      assert.match(noGuard.all, /无守卫 = 无判据的条目 = 愿望不是教训/, noGuard.all)
      assert.equal(treeDigest(dir), before, '用法错误必须零变更')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在的守卫 key → exit 2（派发器自身用法错误，不 fail-open 吞掉）', () => {
    const dir = freshTmp()
    try {
      const r = dispatch(dir, { key: 'no-such-guard' })
      assert.equal(r.status, 2, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registry 结构非法 → 派发 fail-open（放行 + 审计），不静默假绿', () => {
    const dir = freshTmp()
    try {
      assert.equal(doApprove(dir).status, 0)
      writeFileSync(path.join(dir, 'registry.yaml'), 'guards: not-a-list\n', 'utf8')
      const r = dispatch(dir)
      assert.equal(r.status, 0, r.all)
      assert.match(r.all, /fail-open/, r.all)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('宿主接线片段（只出片段，不改 .zcode/config.json）', () => {
  const fragments = [
    { file: 'hook-wiring-capture.json', event: 'PostToolUseFailure', cli: CAPTURE },
    { file: 'hook-wiring-distill.json', event: 'Stop', cli: DISTILL },
  ]
  for (const f of fragments) {
    it(`${f.file}：事件挂在 ${f.event}，argv 片段可直接执行且真的干了活（exit 0 + 落产物）`, () => {
      const dir = freshTmp()
      try {
        const raw = readFileSync(path.join(SKILL_ROOT, 'references', f.file), 'utf8')
        const spec = JSON.parse(raw)
        const hooks = spec.events?.[f.event]?.[0]?.hooks?.[0]
        assert.ok(hooks, `片段必须含 events.${f.event} 接线`)
        assert.equal(hooks.command, 'node', '直调 node，不经包管理器 run 层')
        assert.ok(hooks.timeoutMs >= 1000, '须给外层超时上限')
        // <repo> / <SKILL_DIR> 占位符换成实际路径。片段本身只出片段，落地由接入方写入自己的宿主配置。
        // 两个占位符**都**替换成 SKILL_ROOT：协议层不假设自己位于「某业务仓的 .agents/skills/<name>/、
        // 上溯四级」这种固定深度，也不假设接入方把协议层 vendored 在仓内某个具体子路径 ——
        // 原写法 `slice(0, -4)` 把那个假设写死成一行算术，协议层独立成仓后它指向一个不存在的目录。
        // 可移植性判据见 tests/portability.test.mjs。
        const argv = hooks.args.map((a) => a.replace('<repo>/', `${SKILL_ROOT}/`).replace('<SKILL_DIR>/', `${SKILL_ROOT}/`))
        assert.ok(!argv.some((a) => a.includes('<')), `占位符未替换干净: ${JSON.stringify(argv)}`)
        const real = argv.map((a) => (/[\\/]scripts[\\/]/.test(a) ? path.join(SKILL_ROOT, 'scripts', path.basename(a)) : a))
        const r = spawnSync(process.execPath, [...real, '--config', path.join(dir, 'config-on.yaml')], {
          cwd: dir,
          encoding: 'utf8',
          input: '',
          timeout: 60_000,
          env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
        })
        // 断言收紧（票 H2 · 审计 P1-B）：原断言是 `notEqual(status, 2)`，但 CLI **内部崩了也是 exit 1**、
        // 配置链失败还会 fail-open 成 exit 0 —— 三种「没干活」都能混过它，等于没测。
        // 现改为：① 精确 exit 0；② 断言片段**真的干了它该干的事**（capture 落事件行 / distill 落草案）。
        assert.equal(r.status, 0, `片段 argv 必须 exit 0（精确值，不是「≠2」）:\n${r.stdout}${r.stderr}`)
        assert.doesNotMatch(r.stderr, /fail-open/, `片段不得走 fail-open 兜底（那说明 argv/配置链根本没通）:\n${r.stderr}`)
        if (f.cli === CAPTURE) {
          const shard = readdirSync(path.join(dir, 'events')).find((x) => /^events-\d{8}\.jsonl$/.test(x))
          assert.ok(shard, `capture 片段必须真的落一条事件（事件库是蒸馏与对账的输入）:\n${r.stderr}`)
          const rec = JSON.parse(readFileSync(path.join(dir, 'events', shard), 'utf8').split(/\r?\n/).filter(Boolean)[0])
          assert.equal(rec.kind, 'tool_error')
          assert.equal(rec.source, 'tool')
          assert.equal(rec.count, 1)
        } else {
          // 空事件库时 distill 的正确结局是「如实报 0 个草案」而不是崩在半路 —— 只有后者能区分
          // 「跑通了」与「静默死掉」。有草案时顺带校验命名。
          const drafts = existsSync(path.join(dir, 'proposals')) ? readdirSync(path.join(dir, 'proposals')) : []
          if (drafts.length > 0) assert.match(drafts[0], /^PROP-/)
          else assert.match(r.stderr, /0 个草案/, `distill 必须跑到终点并如实报告:\n${r.stderr}`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('通用性（零项目耦合）', () => {
  it('技能目录不含本仓项目物（路径 / 域名 / 门禁名硬编码）', () => {
    // 2026-10-16（F5 补漏）：名单此前是**逐个点名** ['approve.mjs','run-guard.mjs']，
    // 于是 hook-session-start.mjs / distill.mjs / index-gen.mjs 等从未进过扫描面 ——
    // 「不在名单里」等于「漏网」，而 hook-session-start.mjs 的降级提示里确实写死了
    // 本仓条目目录（用户可见字符串，第二个项目会指向不存在的目录）。
    // 改为**枚举整个 scripts/ 目录**（含 lib/）：新增脚本默认进扫描面，漏网形态被消除。
    // 词表不自持：2026-10-20 起判据唯一归宿 = tests/lib/coupling-scan.mjs（此前此处与
    // lifecycle.test.mjs 各存一份且不一致，两份判据里「看哪份」本身就是漏网自由度）。
    const dir = path.join(SKILL_ROOT, 'scripts')
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, f)),
      ...readdirSync(path.join(dir, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(dir, 'lib', f)),
      // 2026-10-21：bin/ 是 npm 通道的分发器，随包分发，同样不许夹带本仓项目物。
      // 「不在名单里」= 漏网 —— 那正是 F5 补漏时的结论，一并沿用到新目录。
      ...readdirSync(path.join(SKILL_ROOT, 'bin')).filter((f) => f.endsWith('.mjs')).map((f) => path.join(SKILL_ROOT, 'bin', f)),
    ]
    assert.ok(files.length >= 12, `扫描面异常：只枚举到 ${files.length} 个脚本（应覆盖全部 scripts/*.mjs + scripts/lib/*.mjs + bin/*.mjs）`)
    assert.ok(files.some((f) => f.endsWith('hook-session-start.mjs')), '扫描面必须含 hook-session-start.mjs（本次 F5 的漏网文件）')
    assert.ok(files.some((f) => f.endsWith('self-improving.mjs')), '扫描面必须含 bin/self-improving.mjs（npm 通道的分发器）')
    for (const f of files) {
      for (const name of couplingHits(readFileSync(f, 'utf8'))) {
        assert.fail(`${path.basename(f)} 命中项目物 ${name}（注释已剥离 ⇒ 这是可执行/用户可见字符串）`)
      }
    }
  })

  it('测试源码自身不含本仓项目物（对外分发时测试夹带的黑话同样是广播）', () => {
    // 2026-10-20 扩面。此前扫描面只有 scripts/：判据管住了产品代码，却没管住**判据自己**——
    // 于是 tests/ 里逐渐攒下了原仓的仓名、门禁脚本名、容器形态专名，而这些文件是要随包分发的。
    // 扩面后必须配一份**显式豁免台账**：豁免写明「凭什么这个文件合法地持有被禁形态」，
    // 并声明它命中的是**哪几条**（不是「几次」——按次数声明的话，改词表会静默放宽）。
    const ALLOWLIST = [
      {
        file: 'coupling-scan.mjs',
        // 它就是判据本身：全部被禁形态以正则字面量 + 字面量形态持有，删不掉也不该删。
        why: '词表正本（以正则/字面量形态持有全部被禁形态）',
        expect: PROJECT_NOUNS.map((n) => n.name),
      },
    ]
    const files = repoNounFiles()
    assert.ok(files.length >= 20, `扫描面异常：只枚举到 ${files.length} 个文件（应覆盖全部 tests/*.test.mjs + tests/lib/*.mjs）`)
    const violations = ledgerViolations(files.map((f) => ({ file: path.basename(f), hits: hitsInFile(f) })), ALLOWLIST)
    assert.deepEqual(violations, [], `测试源码里混进了项目物:\n${violations.join('\n')}`)
  })

  it('fixtures 不含组织专有名词（只挡 org 层：布局类词条在 fixture 里合法）', () => {
    // 为什么 fixture 要单独判、且只判 org 层：fixture 的职责是「长得像真的报错」，
    // 所以 `.learnings/foo` 这种**通用目录约定**在它里面合法存在（它要的就是真路径形态）。
    // 但组织专有名词（仓名 / 产品代号 / 内部门禁编号 / 内部脚本名）在 fixture 里毫无正当理由 ——
    // 换成中性写法完全不削弱测试，却能避免随包分发时广播出去。
    // 不剥注释：fixture 不是代码，没有注释语法；且样本行就是要给人看的，剥了等于放过文档里的泄漏。
    const files = fixtureNounFiles()
    assert.ok(files.length >= 10, `fixture 扫描面异常：只枚举到 ${files.length} 个文件（应覆盖 tests/fixtures 下的全部文本样本）`)
    for (const f of files) {
      const hits = hitsInFile(f, FIXTURE_FORBIDDEN_NOUNS)
      assert.deepEqual(hits, [], `fixture ${path.relative(SKILL_ROOT, f)} 含组织专有名词 ${hits.join('、')} —— 换成中性写法不削弱测试`)
    }
  })

  it('破坏测试：fixtures 扫描判据不得恒绿（往 fixture 注入 org 词必须变红；layout 词不该误伤）', () => {
    // 样本从词表派生而**不写死字面量**：写死就等于本文件自己持有项目物，
    // 会被上一条「测试源码自身不含本仓项目物」判红 —— 那是对的，写死才是错的。
    const org = FIXTURE_FORBIDDEN_NOUNS
    const byName = (n) => org.find((x) => x.name === n)
    const layout = PROJECT_NOUNS.filter((n) => n.tier === 'layout')
    const dir = mkdtempSync(path.join(tmpdir(), 'si-fixture-break-'))
    try {
      mkdirSync(path.join(dir, 'fixtures', 'nested'), { recursive: true })
      const bad = path.join(dir, 'fixtures', 'nested', 'sample.txt')
      writeFileSync(bad, `error at D:\\ws\\${byName('repo-name').literal}\\x.mjs:${byName('gate-file').literal}\n`, 'utf8')
      const got = hitsInFile(bad, FIXTURE_FORBIDDEN_NOUNS)
      assert.ok(got.includes('repo-name') && got.includes('gate-file'), `org 层两条都该命中，实际 ${JSON.stringify(got)}`)
      // 反向：layout 层词条**不该**被 org 层判据抓到（抓到就说明两层判据没分开，
      // 将来必然有人为了放过合法 fixture 路径而放宽 org 层）
      const layoutOnly = path.join(dir, 'fixtures', 'nested', 'layout.txt')
      writeFileSync(layoutOnly, `entries live in ${layout[0].literal}/ and ${layout[1].literal} triggers it\n`, 'utf8')
      assert.deepEqual(hitsInFile(layoutOnly, FIXTURE_FORBIDDEN_NOUNS), [], 'layout 层词条不该被 fixture 判据命中')
      assert.ok(hitsInFile(layoutOnly, PROJECT_NOUNS).length > 0, '同一段文本在完整词表下必须命中（证明分层不是把判据削弱成空）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('破坏测试：豁免台账判据不得恒绿（注入即红，且每条词都必须真能命中）', () => {
    // 前半：词表里任何一条 regex 写坏（转义错、锚点错）都会让它**永不命中**，
    // 而永不命中看起来和「本来就干净」完全一样 —— 那就是一条形同虚设的守卫。逐条打靶。
    for (const n of PROJECT_NOUNS) {
      assert.ok(couplingHits(`const s = '指向 ${n.literal} 的路径'`).includes(n.name), `词条 ${n.name} 对自己的样本都不命中（regex 写坏了？）`)
      assert.ok(!couplingHits(`// 注释里的 ${n.literal} 不算\nconst a = 1\n`).includes(n.name), `词条 ${n.name} 命中了注释（判注释逻辑坏了？）`)
    }
    // 后半：台账逻辑本身。构造三种越界 —— 未登记的命中、台账里写了但实际没命中、登记词条对不上。
    const injected = { file: 'injected.test.mjs', hits: [PROJECT_NOUNS[0].name] }
    const ok = { file: 'coupling-scan.mjs', hits: PROJECT_NOUNS.map((n) => n.name) }
    const drift = { file: 'coupling-scan.mjs', hits: PROJECT_NOUNS.slice(1).map((n) => n.name) }
    const allow = [{ file: 'coupling-scan.mjs', why: 'x', expect: PROJECT_NOUNS.map((n) => n.name) }]
    assert.equal(ledgerViolations([injected], allow).length, 1, '未登记的文件持有项目物 → 必须判红')
    assert.equal(ledgerViolations([drift], allow).length, 1, '台账声明的命中与实际不符 → 必须判红')
    assert.deepEqual(ledgerViolations([ok], allow), [], '如实登记的豁免必须放行（否则豁免台账无法使用）')
  })

  it('剥离注释的辅助函数本身有效（守卫判据不得恒真/恒红）', () => {
    // 防「守卫写法坏了 ⇒ 什么都不匹配 ⇒ 恒绿」。样本词从共享词表取（probe），
    // 本文件不留副本 —— 副本会让「词表已收紧」在这里失去意义。
    assert.ok(!probe.re.test(stripComments(`// 此前硬编码 ${probe.literal}/ 目录\nconst a = 1\n`)))
    // 反向：字符串里的项目物必须**保留**（否则守卫形同虚设）。
    assert.ok(probe.re.test(stripComments(`const s = '条目见 ${probe.literal}/ 或重试'\n`)))
    // 块注释同理。
    assert.ok(!probe.re.test(stripComments(`/* 历史：${probe.literal} 路径归一 */\nconst b = 2\n`)))
    // 正则字面量守卫（2026-10-16 实测的反向恒红）：正则里同时含 ' 与 " 时，
    // 不识别正则会让词法状态错位，其后的**真注释**被当代码 ⇒ 假红。
    const regexThenComment = `const RE = /[A-Za-z]:[\\\\/][^\\s'"()]+/g\n// ${probe.literal} 双形态归一\nconst c = 3\n`
    assert.ok(!probe.re.test(stripComments(regexThenComment)), '正则字面量后紧跟的行注释必须仍被剥掉（词法状态不得错位）')
    // 且除号不能被误当正则起点（否则后半段代码会被整段吞掉）。
    const division = `const q = total / count\n// ${probe.literal} x\nconst d = 1\n`
    assert.ok(!probe.re.test(stripComments(division)), '除号后的注释仍须被剥掉')
    assert.ok(/const q = total \/ count/.test(stripComments(division)), '除号表达式本身不得被当作正则吞掉')
  })

  it('approve.mjs 对 proposals_dir 无写路径（草案不可自我批准）', () => {
    const src = readFileSync(APPROVE, 'utf8')
    // 扫描面覆盖三种写原语（票 H2 起 approve 改用 atomicWrite；漏一个等于把守卫改成摆设）
    const writes = [...src.matchAll(/(?:writeFileSync|atomicWrite|appendFileSync)\(([^)]*)\)/g)].map((m) => m[1])
    assert.ok(writes.length > 0)
    for (const w of writes) assert.ok(!w.includes('proposals'), `存在指向 proposals_dir 的写路径: ${w}`)
  })
})
