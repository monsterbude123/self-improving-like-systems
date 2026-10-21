/**
 * collect-logs.test.mjs —— 「项目运行期信号 → 用户目录 → 维护 agent」这条通道的判据测试
 *
 * 存在理由（2026-10-21）：协议层要能自我进化，就得看见真实项目里发生了什么。
 * 那些信号只存在于各项目的运行期目录里，项目自己不会替协议层汇总 ——
 * 于是定一条规矩：**项目侧只管产生信号，协议层的维护 agent 负责消费信号**。
 * 本文件钉住这条通道的三个要点：
 *   ① 只采**运行期**数据（事件/审计/守卫态），**不采条目正文**（条目是项目的知识，不外传）；
 *   ② 采到的是**用户目录**（本机、不外传），且目录按项目隔离（同名仓不互相覆盖）；
 *   ③ 缺目录 / 读不动时**跳过并说明**，绝不崩 —— 采集是旁路，不能反过来拖垮项目。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collect, collectRoot, projectSlug, writeCollection } from '../scripts/collect-logs.mjs'

/** 造一个带运行期数据的临时项目。 */
function tmpProject(withEvents = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'si-collect-'))
  mkdirSync(path.join(dir, '.self-improving-work', 'events'), { recursive: true })
  if (withEvents) {
    writeFileSync(
      path.join(dir, '.self-improving-work', 'events', 'events-20261021.jsonl'),
      '{"id":"evt-1","kind":"tool_error"}\n{"id":"evt-2","kind":"user_correction"}\n',
      'utf8',
    )
  }
  writeFileSync(path.join(dir, '.self-improving-work', 'audit.jsonl'), '{"op":"approve","id":"X"}\n', 'utf8')
  writeFileSync(path.join(dir, '.self-improving-work', 'guard-state.json'), '{"k":{"mode":"shadow"}}', 'utf8')
  return dir
}

test('采集：读得到事件、审计与守卫态，并数清条数', () => {
  const dir = tmpProject()
  const home = mkdtempSync(path.join(os.tmpdir(), 'si-home-'))
  try {
    const r = collect(dir, { home })
    assert.equal(r.events, 2, '应数到 2 条事件')
    assert.ok(r.files.some((f) => f.name === 'audit.jsonl'), '应采到审计日志')
    assert.ok(r.files.some((f) => f.name === 'guard-state.json'), '应采到守卫态')
    assert.ok(r.manifest.content_included, '默认含正文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('采集：只采运行期数据，**不采条目正文**', () => {
  const dir = tmpProject()
  const home = mkdtempSync(path.join(os.tmpdir(), 'si-home-'))
  try {
    // 条目区放一份「不该被外传」的知识
    mkdirSync(path.join(dir, '.self-improving', 'entries'), { recursive: true })
    writeFileSync(path.join(dir, '.self-improving', 'entries', 'LRN-1.md'), '项目私有的经验正文\n', 'utf8')
    const r = collect(dir, { home })
    const blob = JSON.stringify(r.manifest) + r.copied.map((c) => c.content).join('')
    assert.ok(!blob.includes('项目私有的经验正文'), '条目正文不得被采集（它是项目的知识，不外传）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('采集落到用户目录，且按项目隔离（同名仓不互相覆盖）', () => {
  const dir = tmpProject()
  const home = mkdtempSync(path.join(os.tmpdir(), 'si-home-'))
  try {
    const r = collect(dir, { home })
    const dest = writeCollection(r, { home })
    assert.ok(dest.startsWith(collectRoot({ home })), '必须落在用户目录：' + dest)
    assert.ok(existsSync(path.join(dest, 'manifest.json')), '要有清单')
    assert.ok(existsSync(path.join(dest, 'events-20261021.jsonl')), '要有事件副本')
    const manifest = JSON.parse(readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
    assert.equal(manifest.event_count, 2, '清单要记下条数（维护 agent 靠它看规模）')
    assert.ok(manifest.collected_at, '清单要记采集时刻')
    // 同名不同路径 → 不同 slug → 不互相覆盖
    const other = mkdtempSync(path.join(os.tmpdir(), 'si-collect-'))
    const r2 = collect(other, { home })
    assert.notEqual(r2.slug, r.slug, '同名不同路径的项目必须落在不同目录')
    rmSync(other, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-content：只采计数与元数据，不带正文', () => {
  const dir = tmpProject()
  const home = mkdtempSync(path.join(os.tmpdir(), 'si-home-'))
  try {
    const r = collect(dir, { home, content: false })
    assert.equal(r.copied.length, 0, '不带正文就不该有副本')
    assert.equal(r.events, 2, '但计数仍在')
    assert.equal(r.manifest.content_included, false, '清单要如实写明没带正文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('破坏测试：运行期目录不存在 → 跳过并说明，**不得崩**', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'si-collect-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'si-home-'))
  try {
    const r = collect(dir, { home })
    assert.equal(r.events, 0)
    assert.ok(r.skipped.length > 0, '要说明跳过了什么')
    assert.ok(r.skipped.some((s) => s.includes('不存在')), '跳过原因要说清：' + r.skipped.join(' | '))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('slug 只含仓名与路径哈希（不泄露项目里其他信息）', () => {
  const slug = projectSlug(path.join(os.tmpdir(), 'my-project'))
  assert.match(slug, /^my-project-[0-9a-f]{8}$/, 'slug 形态应稳定可读：' + slug)
})
