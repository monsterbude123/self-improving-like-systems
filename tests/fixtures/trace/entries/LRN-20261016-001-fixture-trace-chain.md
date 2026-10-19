---
type: LRN
status: resolved
scope: infra
claim: "在 build context 缺失前先探测构建目录存在性，可避免同一形态失效反复进入执行路径。"
guard_ref: guard-fixture-trace-chain
recurrence: 2
last_verified_at: "2026-10-16"
tags: ["build", "fixture"]
category: "对账夹具"
---

# 夹具条目（trace 用 · 非真实语料）

> 这条条目存在的唯一目的：让 `trace.mjs` 有一条「六拍全绿」的样本可判。
> 它落在 `tests/fixtures/` 下，由测试整目录拷进临时目录运行，**从不进入本仓语料区**。

正文（append-only 的历史段落，sweep 只在末尾追加对质段）。

### 复发 1 · 2026-10-15

- 证据：守卫 `guard-fixture-trace-chain` 于 2026-10-15 命中判据被拦截（blocking · exit 2）。
- 回写：本次 sweep 记 `recurrence` 0 → 1、`last_verified_at` "2026-10-15"（verify.mjs --sweep）。

### 复发 2 · 2026-10-16

- 证据：守卫 `guard-fixture-trace-chain` 于 2026-10-16 命中判据被拦截（blocking · exit 2）。
- 回写：本次 sweep 记 `recurrence` 1 → 2、`last_verified_at` "2026-10-16"（verify.mjs --sweep）。

> 历史段落零改动：以上各段按命中顺序追加在正文末尾，既有内容按字节原样保留。
