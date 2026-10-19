---
type: ERR
status: open
scope: build
claim: "scope 枚举来自实例配置 scope.values，build 不在其中"
guard_ref: null
recurrence: 1
last_verified_at: null
---

# 违规 fixture：scope 非法

期望：`validate.mjs` exit 1，打印本文件名 + `scope 非法: "build"`（合法值取自 config scope.values）。
