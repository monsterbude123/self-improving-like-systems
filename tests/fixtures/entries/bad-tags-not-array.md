---
type: LRN
status: active
scope: testing
claim: "tags 是字符串数组契约，映射形态会让主题检索退化为不可用"
guard_ref: null
recurrence: 0
last_verified_at: null
tags: 契约错位
---

# 违规 fixture：可选键 tags 类型错（非数组）

期望：`validate.mjs` exit 1，打印本文件名 + `tags 非法: "契约错位"（须为字符串数组）`。
