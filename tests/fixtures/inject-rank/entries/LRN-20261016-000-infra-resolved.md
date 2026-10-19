---
type: LRN
status: resolved
scope: infra
claim: "regression-drift 已闭环：分层清空的旧经验保留可查但不优先注入"
guard_ref: null
recurrence: 0
last_verified_at: null
---

# regression-drift：已闭环的分层清空经验

这一条的存在只为证明排序键非全平：它的 **ID 字典序最靠前**（000）、
`status: resolved`（已闭环，权重最低）、`recurrence: 0`。

- 若排序退化成 ID 字典序，它会排第一；
- 正确排序下它必须**沉到最后**（status 加权把已闭环的判为低相关）。
