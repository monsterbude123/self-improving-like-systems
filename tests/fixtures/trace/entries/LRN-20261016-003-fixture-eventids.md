---
type: LRN
status: resolved
scope: infra
claim: "夹具条目：只用条目侧 event_ids 与事件库关联（事件侧 entry_id 恒 null），用于校验拍1 强链接的真正接线。"
guard_ref: null
recurrence: 0
last_verified_at: null
tags: ["fixture", "event-ids"]
event_ids: ["evt-20261016-002"]
---

# 夹具条目（拍1 event_ids 关联用 · 非真实语料）

本条目的关联**只**来自 frontmatter 的 `event_ids`。事件 `evt-20261016-002` 的 `entry_id` 为
`null`，且它不是 `gate_block`，所以时间共现那条弱链接也不该命中 —— 拍1 若为绿，只能是
`event_ids` 这条链真的接上了。

## 复发 0 · 2026-10-16
