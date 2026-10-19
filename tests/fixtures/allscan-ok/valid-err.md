---
type: ERR
status: investigating
scope: git
claim: "新 worktree 必须补齐被 ignore 的本地配置文件，否则鉴权失败是自造缺陷不是项目缺陷"
guard_ref: null
recurrence: 0
last_verified_at: null
---

# --all 扫描正向 fixture B（ERR）

同目录还放了一个**没有 frontmatter 的 README.md** —— 它必须被 `--all` 豁免，
否则本目录扫描必红（这条豁免断言的破坏方向由测试覆盖）。
