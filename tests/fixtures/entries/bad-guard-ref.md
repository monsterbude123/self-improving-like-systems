---
type: ERR
status: resolved
scope: infra
claim: "guard_ref 指向 registry key，不是脚本路径（存在性归门禁层，形态归校验器）"
guard_ref: guards/foo.mjs
recurrence: 2
last_verified_at: "2026-10-16"
---

# 违规 fixture：guard_ref 形态非法

期望：`validate.mjs` exit 1，打印本文件名 + `guard_ref 形态非法`（路径形态 ≠ 小写连字符 key）。
