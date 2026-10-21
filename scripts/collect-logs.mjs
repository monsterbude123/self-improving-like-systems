#!/usr/bin/env node
/**
 * collect-logs.mjs —— 把项目运行期日志**采到用户目录**，供协议层的维护 agent 分析与升级
 *
 * ## 为什么需要这条通道（2026-10-21）
 *
 * 协议层要能自我进化，就得看见**真实项目里发生了什么**：哪些失效形态反复出现、
 * 哪些守卫一直在报错、哪些入口根本没人用。这些信号只存在于各项目的运行期目录里
 * （事件 JSONL / 审计日志 / 守卫态），项目自己不会、也不该替协议层汇总。
 *
 * 于是定一条规矩：**项目侧只管产生信号，协议层的维护 agent 负责消费信号**。
 * 本命令就是那条通道的写入端 —— 把项目运行期数据复制到
 * `~/.agents/self-improving-like-systems/collect/<项目>/`，维护 agent 在那里读。
 *
 * ## 为什么是「复制」而不是「项目直接写用户目录」
 *
 *   · 项目侧**只读协议层**（协议正文与实现都在仓外，项目不得改）；
 *     让项目往用户目录写协议层内部结构，等于让接入方知道协议层的内部布局 —— 一改就分叉。
 *   · 复制是**单向、可审计**的：用户目录里留下的是快照，不是活管道；
 *     删掉项目不影响已采集的数据，协议层也不会在某次项目运行时被写坏。
 *
 * ## 隐私与边界
 *
 *   · 只采**本项目**的运行期数据，不采条目正文（条目是项目的知识，不外传）。
 *   · 采到的是**用户自己机器上的用户目录**，不离开本机。
 *   · `--no-content` 只采计数与元数据（不采事件正文）—— 给「想要统计但不想留原文」的场景。
 *
 * 退出码：0=成功 / 1=前置事实不满足 / 2=用法错误
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseYamlLite } from './lib/yaml-lite.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL_ROOT = path.resolve(HERE, '..')

/** 采集根目录（用户目录）。 */
export function collectRoot(opts = {}) {
  const home = opts.home ?? os.homedir()
  return path.join(home, '.agents', 'self-improving-like-systems', 'collect')
}

/**
 * 项目标识：仓名 + 路径哈希（同名仓在不同路径下不会互相覆盖）。
 * 路径哈希只取仓根的绝对路径，不含任何可读内容 —— 目录名不泄露项目名以外的信息。
 */
export function projectSlug(projectDir) {
  const abs = path.resolve(projectDir)
  const name = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, '-') || 'project'
  let h = 0
  const s = abs.toLowerCase()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `${name}-${h.toString(16).padStart(8, '0')}`
}

/**
 * 读项目的实例配置，取出运行期目录。读不到就用协议层的默认约定。
 * @returns {{events:string[], audit:string, guardState:string}}
 */
export function readRuntimePaths(projectDir) {
  const cfgPath = path.join(projectDir, '.self-improving.yaml')
  let storage = {}
  if (existsSync(cfgPath)) {
    try {
      const doc = parseYamlLite(readFileSync(cfgPath, 'utf8'))
      storage = doc?.storage ?? {}
    } catch {
      storage = {} // 配置坏了不该让采集命令炸掉 —— 采集是尽力而为的旁路
    }
  }
  const eventsDir = storage.events_dir ?? '.self-improving-work/events/'
  const workDir = path.dirname(path.join(projectDir, eventsDir))
  return {
    events: [path.join(projectDir, eventsDir)],
    audit: path.join(projectDir, storage.audit_log ?? path.join(path.basename(workDir), 'audit.jsonl')),
    guardState: path.join(projectDir, storage.guard_state ?? path.join(path.basename(workDir), 'guard-state.json')),
  }
}

/**
 * 采集一份快照（纯计算 + 写盘分开，便于测）。
 * @param {string} projectDir 项目根
 * @param {{content?:boolean}} opts content=false 时只采元数据
 */
export function collect(projectDir, opts = {}) {
  const withContent = opts.content !== false
  const abs = path.resolve(projectDir)
  const slug = projectSlug(abs)
  const dest = path.join(collectRoot(opts), slug)
  const paths = readRuntimePaths(abs)
  const result = { slug, dest, files: [], copied: [], events: 0, skipped: [] }

  // 事件 JSONL：逐个文件复制（追加式快照，带行号去重由消费端负责）
  for (const evDir of paths.events) {
    if (!existsSync(evDir)) { result.skipped.push(`事件目录不存在：${evDir}`); continue }
    let names = []
    try {
      names = readdirSync(evDir).filter((f) => f.endsWith('.jsonl')).sort()
    } catch {
      result.skipped.push(`事件目录读不动：${evDir}`)
      continue
    }
    for (const n of names) {
      const src = path.join(evDir, n)
      try {
        const text = readFileSync(src, 'utf8')
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
        result.events += lines.length
        result.files.push({ name: n, lines: lines.length })
        if (withContent) result.copied.push({ src, name: n, content: text })
      } catch {
        result.skipped.push(`读不动：${src}`)
      }
    }
  }

  for (const [key, p] of [['audit.jsonl', paths.audit], ['guard-state.json', paths.guardState]]) {
    if (!existsSync(p)) { result.skipped.push(`不存在：${p}`); continue }
    try {
      const text = readFileSync(p, 'utf8')
      result.files.push({ name: key, bytes: text.length })
      if (withContent) result.copied.push({ src: p, name: key, content: text })
    } catch {
      result.skipped.push(`读不动：${p}`)
    }
  }

  result.manifest = {
    project: path.basename(abs),
    slug,
    collected_at: new Date().toISOString(),
    content_included: withContent,
    layer_version: readLayerVersion(),
    files: result.files,
    event_count: result.events,
    note: '本目录由协议层的 collect-logs 命令写入，供维护 agent 分析；只含运行期信号，不含条目正文。',
  }
  result.dest = dest
  return result
}

/** 协议层版本（发版断言保证 tag == version，这里读 package.json）。 */
function readLayerVersion() {
  try {
    const p = path.join(PROTOCOL_ROOT, 'package.json')
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch {
    // 读不到就留空 —— 版本不是采集的必需字段
  }
  return null
}

/** 把采集结果写到用户目录。 */
export function writeCollection(result, opts = {}) {
  mkdirSync(result.dest, { recursive: true })
  for (const c of result.copied) {
    appendFileSync(path.join(result.dest, c.name), c.content, 'utf8')
  }
  writeFileSync(path.join(result.dest, 'manifest.json'), `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8')
  return result.dest
}

export function main(argv) {
  let projectDir = null
  let apply = false
  let content = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project-dir') {
      const next = argv[++i]
      if (next === undefined || next.startsWith('--')) return usage('--project-dir 后须跟目录')
      projectDir = path.resolve(next)
      continue
    }
    if (a === '--apply') { apply = true; continue }
    if (a === '--no-content') { content = false; continue }
    if (a === '--help' || a === '-h') return usage('')
    return usage(`未知参数 ${a}`)
  }
  if (!projectDir) projectDir = path.resolve(process.cwd())
  if (!existsSync(projectDir)) return fail(`项目目录不存在：${projectDir}`)

  const r = collect(projectDir, { content })
  if (!apply) {
    console.log(`[collect-logs] 演练模式（零写盘）。项目 = ${r.manifest.project}（${r.slug}）`)
    console.log(`[collect-logs] 将采 ${r.files.length} 个文件、${r.events} 条事件 → ${r.dest}`)
    console.log(`[collect-logs] 正文：${content ? '含' : '不含（--no-content）'}`)
    for (const s of r.skipped) console.log(`[collect-logs]   跳过：${s}`)
    console.log('\n确认无误后加 --apply 落盘。')
    return 0
  }
  const dest = writeCollection(r)
  console.log(`[collect-logs] 已采集 ${r.files.length} 个文件、${r.events} 条事件 → ${dest}`)
  for (const s of r.skipped) console.log(`[collect-logs]   跳过：${s}`)
  console.log('[collect-logs] 维护 agent 在该目录读信号；项目侧到此为止（协议层对项目只读）。')
  return 0
}

function fail(msg) {
  console.error(`[collect-logs] 前置事实不满足：${msg}`)
  return 1
}

function usage(msg) {
  if (msg) console.error(`用法错误：${msg}`)
  console.error(`用法：node collect-logs.mjs --project-dir <项目目录> [--apply] [--no-content]
  不带 --apply = 演练，零写盘
  --apply       = 采到用户目录 ${collectRoot()}/<项目>/
  --no-content  = 只采计数与元数据，不采事件正文
  退出码：0=成功 / 1=前置事实不满足 / 2=用法错误`)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
