---
type: ERR
status: proposed
scope: testing
claim: "在 vitest 触发的 tool_error 失效形态「vitest-worker-timeout」上，事件库已累计 3 次（跨度 2026-10-14 ~ 2026-10-16，错误码 ETIMEDOUT）。断言：若在触发该形态之前先跑一遍「guard-tool-error-vitest-worker-timeout」的前置判据（命中即阻断），则此后同一失效不再进入执行路径；证伪方式：判据登记后该 fingerprint 的 recurrence 不再增长 —— 只要还在增长，本断言即被推翻，须重写判据或撤回本条。"
guard_ref: null
recurrence: 3
last_verified_at: null
date: "2026-10-16"
tags: ["tool_error", "tool", "ETIMEDOUT", "vitest", "worker", "timeout"]
category: "失效模式蒸馏草案"
---

# 草案 · vitest-worker-timeout（tool_error · 累计 3 次）

> **这是提案，不是条目。** 本文件落在 `storage.proposals_dir`（本地 gitignored 暂存区），
> 提案器全程不写正式区（`config.storage.entries_dir`）；是否晋升为正式条目、晋升为哪个 ID，由人工逐条批准。

## 三要素

1. **claim（可证伪断言）**：见 frontmatter
2. **scope**：`testing` —— 归域依据：条目语料 IDF 加权投票
3. **守卫绑定建议**：见下节

## 守卫绑定建议

- 候选 `guard_ref`：**`guard-tool-error-vitest-worker-timeout`**（registry key 形态；**未登记** —— 登记前 `guard_ref: null`，草案不代签）
- 触发时机（when 草案）：变更相关工具调用前 + commit 前置守卫链
- 判据动作（args 草案）：直调 `node <守卫脚本> --text -`，读取 stdin 的失败输出；命中判据 → `exit 2` 阻断，未命中 → `exit 0` 放行
- 命中判据的抓手（可执行化）：本簇 salient token = vitest / worker / timeout；判据须能在这组 token 上做**确定性匹配**
- 破坏测试自检（登记前必做）：① 把下方「触发样本」原样喂给守卫 → **必须变红**；② 喂一条不含该 token 的正常输出 → **必须保持绿**
- 登记形态：registry `guards[]` 的 `key` / `args` / `when` 三键；新守卫前 3 次 shadow warn-only

## 触发事实（事件聚类）

- 簇成员 fingerprint：`fp-1a2b3c4d5e6f7081`
- kind / source：`tool_error` / `tool`
- recurrence（该 fingerprint 累计次数）：**3**
- 错误码集合：`ETIMEDOUT`
- 来源事件：`evt-20261016-007`、`evt-20261016-008`

### 触发样本（供人工判读与守卫破坏测试直接复用）

1. `fp-1a2b3c4d5e6f7081` · 3 次
   > Test timed out in 10000ms. vitest worker pool exhausted

## 人工评审清单（逐条勾选后才有资格晋升）

- [ ] claim 里的根因与前置动作属实
- [ ] scope 归域正确
- [ ] 守卫判据可执行，且破坏测试「注入违规样本必须变红」已实测
- [ ] 已在 registry 登记守卫 key
- [ ] 决定晋升为正式条目（并分配 `LRN|ERR-FEAT-YYYYMMDD-NNN` ID）或丢弃
