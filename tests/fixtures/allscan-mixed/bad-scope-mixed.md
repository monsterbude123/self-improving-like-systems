---
type: LRN
status: active
scope: marketing
claim: "混合扫描必须逐条报出违规文件名，而不是只给一个总失败"
guard_ref: null
recurrence: 0
last_verified_at: null
---

# --all 混合扫描 fixture：违规条（scope 非法）

期望：`validate.mjs --all <本目录>` exit 1，输出含本文件名 + `scope 非法: "marketing"`；
同目录合规的 `valid-feat.md` **不得**出现在 FAIL 列表里。
