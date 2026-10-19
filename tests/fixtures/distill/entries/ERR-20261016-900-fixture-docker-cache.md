---
type: ERR
status: resolved
scope: infra
claim: docker 构建缓存卷缺失会让构建上下文取不到（infra 域语料，供蒸馏 scope 投票用）
guard_ref: null
recurrence: 2
last_verified_at: null
tags: ["docker", "build", "infra"]
category: "经验教训"
---

# fixture 条目 · docker 构建缓存

（这是技能 fixtures，不在项目命名门禁管辖面内。）
docker 构建时缓存卷缺失导致上下文 ENOENT。
