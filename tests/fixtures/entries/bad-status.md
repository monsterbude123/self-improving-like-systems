---
type: LRN
status: closed
scope: testing
claim: "status 枚举必须来自三台状态机的并集，closed 不在其中"
guard_ref: null
recurrence: 0
last_verified_at: "2026-10-16"
---

# 违规 fixture：status 枚举非法

期望：`validate.mjs` exit 1，打印本文件名 + `status 非法: "closed"`。
