---
type: LRN
status: active
scope: infra
claim: "复发优先：同一根因复发多次的经验排在只出现一次的之前"
guard_ref: null
recurrence: 5
last_verified_at: "2026-10-01"
---

# 复发次数是排序键（recurrence desc）

排序 fixture：`recurrence: 5` 且 status 同为 active —— 与 004 的唯一差别是复发次数，
用于断言 recurrence 在 status 之前生效。
