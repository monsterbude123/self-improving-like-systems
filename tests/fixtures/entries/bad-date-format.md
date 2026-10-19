---
type: LRN
status: active
scope: testing
claim: "date 键是 YYYY-MM-DD 形态的日期，写成 2026 年 13 月 45 日不是合法日期"
guard_ref: null
recurrence: 0
last_verified_at: null
date: "2026-13-45"
---

# 违规 fixture：可选键 date 格式错

期望：`validate.mjs` exit 1，打印本文件名 + `date 非法: "2026-13-45"（须为 YYYY-MM-DD…）`。
