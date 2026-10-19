/**
 * capture.test.mjs —— 错误事件捕获自包含测试（node:test，零框架依赖；`node <本文件>` 直跑）
 *
 * 口径（票 08 AC 全部 fixture 化）：事件落盘内容 + 双形态 fingerprint + 归并 + 近邻不合并
 * + 白名单 + 触发式检索 + kill-switch off；每条都有红向（破坏测试：注入错误必须变红）。
 * fixture = tests/fixtures/capture/（每用例整体拷到临时目录）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unwrapHookEnvelope, extractProvenance } from '../scripts/capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.resolve(HERE, '..')
const CLI = path.join(SKILL_ROOT, 'scripts', 'capture.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'capture')

function freshTmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'capture-test-'))
  cpSync(FIXTURE_DIR, dir, { recursive: true })
  return dir
}

/** 跑捕获 CLI（cwd=fixture 根；SELF_IMPROVING_CONFIG 指向 fixture 配置）。 */
function runCapture(args, dir, { config = 'config-on.yaml', input = null } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--config', path.join(dir, config)], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    input: input ?? undefined,
    env: { ...process.env, SELF_IMPROVING_CONFIG: '' },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const shardOf = (dir) => {
  const ev = path.join(dir, 'events')
  const files = existsSync(ev) ? readdirSync(ev).filter((f) => /^events-\d{8}\.jsonl$/.test(f)) : []
  return files.length ? path.join(ev, files[0]) : null
}
const readShard = (dir) => {
  const p = shardOf(dir)
  if (!p) return []
  return readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}
const readAudit = (dir) => {
  const p = path.join(dir, 'audit', 'audit.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

describe('事件落盘（§2 Event 契约）', () => {
  it('正向：事件行含契约全键、按日分片、可被工具原样消费', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'ENOENT: cannot open config/database.json', '--json'], tmp)
      assert.equal(r.status, 0, r.all)
      const rec = JSON.parse(r.stdout.trim())
      for (const k of ['id', 'ts', 'source', 'kind', 'severity', 'payload', 'fingerprint', 'entry_id']) {
        assert.ok(k in rec, `事件缺契约键 ${k}: ${JSON.stringify(rec)}`)
      }
      assert.match(rec.id, /^evt-\d{8}-\d{3}$/)
      assert.equal(rec.source, 'tool')
      assert.equal(rec.kind, 'tool_error')
      assert.match(rec.ts, /T\d{2}:\d{2}:\d{2}/)
      const rows = readShard(tmp)
      assert.equal(rows.length, 1, '分片内应只有一行')
      assert.equal(rows[0].fingerprint, rec.fingerprint)
      assert.match(shardOf(tmp), /events-\d{8}\.jsonl$/)
      assert.ok(readAudit(tmp).some((x) => x.action === 'event-captured'), '捕获动作未落审计')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('门禁拦截输出走 stdin 降级路径（--text -）：管道喂原始 FAIL 输出即可捕获', () => {
    const tmp = freshTmp()
    try {
      const gateOut = readFileSync(path.join(tmp, 'gate-fail-output.txt'), 'utf8')
      const r = runCapture(['--source', 'gate', '--kind', 'gate_block', '--text', '-', '--json'], tmp, { input: gateOut })
      assert.equal(r.status, 0, r.all)
      const rec = JSON.parse(r.stdout.trim())
      assert.equal(rec.source, 'gate')
      assert.match(rec.payload.message, /entry-guard-binding blocked commit/)
      assert.ok(rec.fingerprint.startsWith('fp-'), '门禁输出必须算出 fingerprint')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('人工输入降级路径（--source manual）：同一段文本归并为一条事件', () => {
    const tmp = freshTmp()
    try {
      runCapture(['--source', 'manual', '--kind', 'manual', '--text', '手工记录：docker 构建 ENOENT 缓存卷缺失', '--json'], tmp)
      runCapture(['--source', 'manual', '--kind', 'manual', '--text', '手工记录：docker 构建 ENOENT 缓存卷缺失', '--json'], tmp)
      const rows = readShard(tmp)
      assert.equal(rows.length, 1, '同一错误重复出现只留一行（归并）')
      assert.equal(rows[0].count, 2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('双形态路径归一化（宿主 / devbox）', () => {
  it('同一错误的宿主形态与 devbox 形态 → 同一 fingerprint（同一行归并）', () => {
    const tmp = freshTmp()
    try {
      const host = readFileSync(path.join(tmp, 'host-form.txt'), 'utf8').trim()
      const box = readFileSync(path.join(tmp, 'devbox-form.txt'), 'utf8').trim()
      const a = JSON.parse(runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', host, '--json'], tmp).stdout.trim())
      const b = JSON.parse(runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', box, '--json'], tmp).stdout.trim())
      assert.equal(a.fingerprint, b.fingerprint, `双形态应同 fingerprint:\n${a.fingerprint}\n${b.fingerprint}`)
      assert.equal(a.id, b.id, '归并到同一事件行（id 不变）')
      const rows = readShard(tmp)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].count, 2)
      // 落盘后仍保留原始细节（宿主形态不污染：payload 保留最后一次原文）
      assert.ok(rows[0].payload.message.length > 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('破坏测试：错误码不同 → 必须分属两条事件（不得被骨架相似度吞成一条）', () => {
    const tmp = freshTmp()
    try {
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'ENOENT: build context not found at /workspace/app/x/D13.mjs:42', '--json'], tmp)
      const other = readFileSync(path.join(tmp, 'devbox-form-other.txt'), 'utf8').trim()
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', other, '--json'], tmp)
      const rows = readShard(tmp)
      assert.equal(rows.length, 2, `不同错误码必须分开: ${JSON.stringify(rows.map((r) => r.fingerprint))}`)
      assert.notEqual(rows[0].fingerprint, rows[1].fingerprint)
      assert.deepEqual(rows.map((r) => r.codes[0]).sort(), ['EACCES', 'ENOENT'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('显式 --path-prefix 剥根：同目录下不同文件仍可区分（提高归并精度）', () => {
    const tmp = freshTmp()
    try {
      const a = runCapture(['--source', 'tool', '--kind', 'tool_error', '--path-prefix', '/workspace/app', '--text', 'ENOENT missing /workspace/app/scripts/a.mjs', '--json'], tmp)
      const b = runCapture(['--source', 'tool', '--kind', 'tool_error', '--path-prefix', '/workspace/app', '--text', 'ENOENT missing /workspace/app/scripts/b.mjs', '--json'], tmp)
      const ja = JSON.parse(a.stdout.trim())
      const jb = JSON.parse(b.stdout.trim())
      assert.notEqual(ja.fingerprint, jb.fingerprint, '声明前缀后 a.mjs 与 b.mjs 必须可区分')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('归并与近邻（首要键而非唯一真理）', () => {
  it('同一错误二次捕获：count 累加、行数不变、审计记 event-merged', () => {
    const tmp = freshTmp()
    try {
      const text = 'EACCES permission denied opening /workspace/app/data/config.json token 1a2b3c'
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', text, '--json'], tmp)
      const second = JSON.parse(runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', text, '--json'], tmp).stdout.trim())
      assert.equal(second.count, 2)
      assert.ok(readAudit(tmp).some((x) => x.action === 'event-merged'), '归并未落审计')
      assert.equal(readShard(tmp).length, 1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('近邻：相似但不同的事件 → 只写待人工合并清单，绝不自动合并（两行仍在）', () => {
    const tmp = freshTmp()
    try {
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'EACCES permission denied opening /workspace/app/data/config.json token 1a2b', '--json'], tmp)
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'EACCES permission denied opening /workspace/app/data/secrets.json token 1a2b', '--json'], tmp)
      const rows = readShard(tmp)
      assert.equal(rows.length, 2, '近邻不得自动合并')
      const flagged = rows.filter((r) => (r.near_neighbors || []).length > 0)
      assert.ok(flagged.length >= 1, '近邻未登记到 near_neighbors')
      const pendDir = path.join(tmp, 'events', 'pending-merge')
      assert.ok(existsSync(pendDir), '未写待人工合并清单')
      const pend = readdirSync(pendDir)
      assert.ok(pend.length >= 1)
      const item = JSON.parse(readFileSync(path.join(pendDir, pend[0]), 'utf8').trim().split('\n').pop())
      assert.equal(item.status, 'pending-human-review')
      assert.notEqual(item.a, item.b)
      assert.ok(item.similarity >= 0.55, `相似度须达阈值: ${JSON.stringify(item)}`)
      assert.ok(readAudit(tmp).some((x) => x.action === 'near-neighbor-flagged'), '近邻未落审计')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('破坏测试：完全无关的错误 → 不得产生近邻候选（阈值不是恒真）', () => {
    const tmp = freshTmp()
    try {
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'EACCES permission denied opening /workspace/app/data/config.json token 1a2b', '--json'], tmp)
      runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'ESOCKETTIMEDOUT connect ETIMEDOUT 203.0.113.9:5432 upstream pool exhausted', '--json'], tmp)
      const rows = readShard(tmp)
      assert.equal(rows.length, 2)
      for (const r of rows) assert.equal((r.near_neighbors || []).length, 0, `无关错误不得被标近邻: ${JSON.stringify(r.near_neighbors)}`)
      assert.ok(!existsSync(path.join(tmp, 'events', 'pending-merge')), '无关错误不得写待合并清单')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('触发式检索（复用注入引擎同一份逻辑）', () => {
  it('capture 时命中相关条目 → stdout 给出注入块（含出处，域取自 hook.default_scopes）', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'docker ENOENT 缓存卷缺失'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.match(r.stdout, /^## 经验注入/, `命中时应输出注入块:\n${r.stdout}`)
      assert.match(r.stdout, /出处: entries\/LRN-20261016-020-docker-cache\.md/)
      assert.match(r.stdout, /命中 [1-9]\d* 次/, '关键词命中数应被计入')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('capture 开但 injection 关 → 事件照落、检索不发生（两个开关各自独立）', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'docker ENOENT 缓存卷缺失'], tmp, { config: 'config-capture-only.yaml' })
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', 'injection 关时不得触发检索')
      assert.equal(readShard(tmp).length, 1, 'capture 开时事件必须照落')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('--no-block：只落事件不检索（供纯记录场景）', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'docker ENOENT 缓存卷缺失', '--no-block'], tmp)
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '')
      assert.equal(readShard(tmp).length, 1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('白名单 / kill-switch / fail-open', () => {
  it('kill-switch capture=off：不写事件、不检索、零副作用', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'docker ENOENT 缓存卷缺失'], tmp, { config: 'config-off.yaml' })
      assert.equal(r.status, 0, r.all)
      assert.equal(r.stdout, '', 'off 态不得触发检索')
      assert.ok(!existsSync(path.join(tmp, 'events')), 'off 态不得写事件目录')
      assert.ok(!existsSync(path.join(tmp, 'audit', 'audit.jsonl')), 'off 态不得写审计（零副作用）')
      assert.match(r.stderr, /kill_switch\.capture=false/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('事件源不在白名单 → 拒收（exit 2），先于 kill-switch 判定', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'gate', '--kind', 'gate_block', '--text', 'FAIL something'], tmp, { config: 'config-narrow-source.yaml' })
      assert.equal(r.status, 2, r.all)
      assert.match(r.stderr, /不在 config\.event_sources 白名单/)
      assert.ok(!existsSync(path.join(tmp, 'events')), '拒收时不得落盘')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('配置损坏 → exit 0、不写事件、fail-open 审计（绝不阻塞调用方）', () => {
    const tmp = freshTmp()
    try {
      const r = runCapture(['--source', 'tool', '--kind', 'tool_error', '--text', 'boom'], tmp, { config: 'config-broken.yaml' })
      assert.equal(r.status, 0, `fail-open 必须 exit 0，实得 ${r.status}\n${r.all}`)
      assert.ok(!existsSync(path.join(tmp, 'events')), 'fail-open 不得落事件')
      assert.match(r.stderr, /fail-open/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('用法错误：缺 --source / 缺 --kind / 非法 kind / 非法 JSON payload → exit 2', () => {
    const tmp = freshTmp()
    try {
      const cases = [
        [['--kind', 'tool_error', '--text', 'x'], /--source 必填/],
        [['--source', 'tool', '--text', 'x'], /--kind 必填/],
        [['--source', 'tool', '--kind', 'weird', '--text', 'x'], /--kind 取值非法/],
        [['--source', 'tool', '--kind', 'tool_error', '--payload', '{oops'], /不是合法 JSON/],
        [['--source', 'tool', '--kind', 'tool_error', '--nope'], /未知参数/],
      ]
      for (const [args, re] of cases) {
        const r = runCapture(args, tmp)
        assert.equal(r.status, 2, `期望 exit 2: ${args.join(' ')}\n${r.all}`)
        assert.match(r.stderr, re)
      }
      assert.ok(!existsSync(path.join(tmp, 'events')), '用法错误不得落盘')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

/**
 * 宿主 hook 信封剥离（2026-10-17 主仓接线实证修复）。
 *
 * 缺陷本体：接线后 PostToolUseFailure 送的是**整包 JSON 信封**，capture 直接当消息文本处理 →
 * buildSkeleton 把带引号的值全抹成 `"…"`、数字全抹成 `#` → tokens 几乎为空（实测 tokens=[]），
 * 而 fingerprint 仍唯一 —— 于是「归并照常工作、语义全丢」：蒸馏无抓手、近邻聚类恒不相似、
 * scope 投票失效。**静默**是它最坏的性质：所有计数都在涨，看不出任何异常。
 */
describe('unwrapHookEnvelope · 宿主 hook JSON 信封剥离', () => {
  it('真实 PostToolUseFailure 信封 → 剥出 error 消息本体', () => {
    const env = JSON.stringify({
      cwd: 'D:/workspace/x',
      error: 'File content (40.5MB) exceeds maximum allowed size (256KB). Use offset and limit parameters.',
      hookEventName: 'PostToolUseFailure',
      sessionId: 'sess_A',
      toolName: 'Read',
      toolInput: { file_path: 'C:/Users/x/log.txt' },
    })
    assert.equal(
      unwrapHookEnvelope(env),
      'File content (40.5MB) exceeds maximum allowed size (256KB). Use offset and limit parameters.',
    )
  })

  it('双写 error_details.message 变体 → 剥出内层消息', () => {
    const env = JSON.stringify({
      tool_name: 'Bash',
      error_details: { message: 'ERR_MODULE_NOT_FOUND: Cannot find package js-yaml imported from a.mjs', type: 'tool_execution_failed' },
    })
    assert.match(unwrapHookEnvelope(env), /^ERR_MODULE_NOT_FOUND/)
  })

  it('破坏测试：剥壳后 tokens 必须非空（缺陷本体的直接判据 —— 改回不剥壳这里立刻变红）', () => {
    const env = JSON.stringify({ error: 'Cannot find module js-yaml imported from validate.mjs', sessionId: 'sess_B' })
    const msg = unwrapHookEnvelope(env)
    const tokens = msg.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
    assert.ok(tokens.length >= 3, `剥壳后须有可聚类抓手（实际: ${JSON.stringify(tokens)}）`)
  })

  it('同错误换 sessionId / toolCallId → 剥壳后同一指纹（信封易变字段不得进指纹）', () => {
    const a = JSON.stringify({ error: 'hook exited with status 3', sessionId: 'sess_A', toolCallId: 'call_1' })
    const b = JSON.stringify({ error: 'hook exited with status 3', sessionId: 'sess_B', toolCallId: 'call_2' })
    assert.equal(unwrapHookEnvelope(a), unwrapHookEnvelope(b), '信封易变字段必须被剥掉')
  })

  it('数组信封（批次形态）→ 剥出首个可读消息', () => {
    assert.equal(
      unwrapHookEnvelope(JSON.stringify([{ error: 'command timed out after 30 seconds' }])),
      'command timed out after 30 seconds',
    )
  })

  it('绿侧：纯文本门禁输出 / 像 JSON 但不是 / 剥不出内容的全 ID 信封 → 一律原样保留（永不弄坏数据）', () => {
    const gateOut = 'FAIL [gate-d6-learnings-naming]: ERR-20261017-001 命名违规'
    assert.equal(unwrapHookEnvelope(gateOut), gateOut, '门禁纯文本不受影响')
    assert.equal(unwrapHookEnvelope('{ this is not json }'), '{ this is not json }', '长得像 JSON 但不是 → 不猜')
    const idsOnly = JSON.stringify({ sessionId: 'sess_0123456789abcdef', traceId: '7f634712-b015' })
    assert.equal(unwrapHookEnvelope(idsOnly), idsOnly, '剥不出消息 → 原样')
    assert.equal(unwrapHookEnvelope(''), '', '空输入不炸')
  })
})

describe('extractProvenance · 事件出处抽取（判据：从哪来 / 靠什么学来）', () => {
  it('红向：宿主信封 → 采到 hook 事件名 / 工具 / 会话 / 轮次，缺项显式 null（不猜）', () => {
    const env = JSON.stringify({
      cwd: 'D:/x',
      error: 'EADDRINUSE: address already in use :::3000',
      hookEventName: 'PostToolUseFailure',
      toolName: 'Bash',
      sessionId: 'sess_probe',
      turnId: 'turn_9',
      error_details: { message: 'EADDRINUSE: address already in use :::3000' },
    })
    const p = extractProvenance(env, 'text')
    assert.equal(p.collected_by, 'hook:PostToolUseFailure')
    assert.equal(p.transport, 'text')
    assert.equal(p.tool, 'Bash')
    assert.equal(p.session_id, 'sess_probe')
    assert.equal(p.turn_id, 'turn_9')
    assert.equal(p.trace_id, null, '信封没有的字段必须显式 null，不得省略（省略 = 读的人分不清是没采到还是没记）')
  })

  it('红向：snake_case 双写形态（宿主另一版本）同样采得到 —— 键名变体不得导致出处丢失', () => {
    const env = JSON.stringify({
      error: 'command timed out after 30 seconds',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      session_id: 'sess_snake',
    })
    const p = extractProvenance(env, 'text')
    assert.equal(p.collected_by, 'hook:PostToolUseFailure')
    assert.equal(p.tool, 'Bash')
    assert.equal(p.session_id, 'sess_snake')
  })

  it('绿侧：纯文本 / 非 JSON / 无任何元数据的对象 → 一律 null，绝不臆造出处', () => {
    assert.equal(extractProvenance('FAIL [gate-d6]: 命名违规', 'text'), null, '门禁纯文本不产出处')
    assert.equal(extractProvenance('{ not json }', 'text'), null, '长得像 JSON 但不是 → 不猜')
    assert.equal(extractProvenance(JSON.stringify({ error: 'boom happened' }), 'text'), null, '只有消息没有元数据 → null')
    assert.equal(extractProvenance('', 'text'), null, '空输入不炸')
  })

  it('破坏测试：把 collected_by 写死成 cli（丢掉 hook 前缀）→ 上面三条断言必须变红', () => {
    // 判据：出处字段若退化成常量，"知识从哪个 hook 采来的"就永远答不出来 —— 故钉死前缀。
    const env = JSON.stringify({ error: 'boom happened here', hookEventName: 'PostToolUseFailure' })
    assert.notEqual(extractProvenance(env, 'text').collected_by, 'cli', 'collected_by 不得丢 hook 事件名')
  })
})

// ===== 诊断探针 `--diag`（2026-10-18 新增）=====
// 背景：本仓 PostToolUseFailure 钩子「配好了、loadHooks OK、事件在触发、脚本手工跑也正常」，
// 但事件库零新增。三种解释（宿主没调起 / 没喂 stdin / 喂了但没落库）修法完全相反，
// 而三者表现为同一个现象。探针把判据写进文件，让「是哪一环」从猜变成看。
describe('capture --diag 诊断探针', () => {
  const runDiag = (args, input) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'si-diag-'))
    const probe = path.join(dir, 'probe.log')
    const r = spawnSync(process.execPath, [CLI, ...args, '--diag', probe], {
      input: input ?? '', encoding: 'utf8',
    })
    const lines = existsSync(probe)
      ? readFileSync(probe, 'utf8').split('\n').filter(Boolean)
      : []
    return { status: r.status, lines, dir, probe }
  }

  it('正常路径：三段留痕齐全（invoked → stdin → exit）', () => {
    const { status, lines, dir } = runDiag(
      ['--source', 'manual', '--kind', 'manual', '--text', '-', '--no-block', '--config', path.join(FIXTURE_DIR, 'config.yaml')],
      'PROBE-FIXTURE-TEXT',
    )
    try {
      assert.equal(status, 0, '退出码应为 0：' + status)
      assert.ok(lines.some((l) => /invoked argv=/.test(l)), '应有 invoked 行：' + lines.join(' | '))
      assert.ok(lines.some((l) => /stdin bytes=/.test(l)), '应有 stdin 行：' + lines.join(' | '))
      assert.ok(lines.some((l) => /exit code=0/.test(l)), '应有 exit 行：' + lines.join(' | '))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('用法错误也留痕（invoked + exit 2），这是定位「脚本侧问题」的关键判据', () => {
    const { status, lines, dir } = runDiag(['--source', 'manual', '--kind', 'manual', '--bogus', 'x'])
    try {
      assert.equal(status, 2)
      assert.ok(lines.some((l) => /invoked argv=/.test(l)), '参数写错也要留 invoked（探针先于参数解析）')
      assert.ok(lines.some((l) => /exit code=2/.test(l)), '应留 exit code=2')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('不传 --diag → 零副作用（不产生探针文件）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'si-diag-'))
    const probe = path.join(dir, 'probe.log')
    try {
      const r = spawnSync(process.execPath, [CLI, '--source', 'manual', '--kind', 'manual',
        '--text', '-', '--no-block', '--config', path.join(FIXTURE_DIR, 'config.yaml')],
        { input: 'x', encoding: 'utf8' })
      assert.equal(r.status, 0)
      assert.equal(existsSync(probe), false, '未开探针时不得写任何文件')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('破坏测试：把三段留痕砍成只留 exit → 上面「三段齐全」断言必须变红', () => {
    // 判据：只留 exit 无法区分「宿主没调起」与「调起了但没落库」——而这正是本探针存在的理由。
    const { lines, dir } = runDiag(
      ['--source', 'manual', '--kind', 'manual', '--text', '-', '--no-block', '--config', path.join(FIXTURE_DIR, 'config.yaml')],
      'X',
    )
    try {
      const withoutEarly = lines.filter((l) => !/invoked|stdin/.test(l))
      assert.equal(withoutEarly.length, lines.length - 2,
        '砍掉 invoked/stdin 后行数应变少 2 —— 否则说明探针没在真正留痕')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
