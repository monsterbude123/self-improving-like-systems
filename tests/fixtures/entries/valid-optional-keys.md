---
type: LRN
status: resolved
scope: testing
claim: "把带真实检索价值的旧 frontmatter 键（tags/date/category）按删数据处理，会让主题检索永久失联"
guard_ref: null
recurrence: 0
last_verified_at: "2026-10-16"
tags: [契约, 检索元数据, "13500", 门禁]
date: "2026-10-16"
category: 经验教训
resolved_date: "2026-10-16"
resolved_by: "174f4032d（修复） / Wave 6 票 G4c（结案复核）"
event_ids: ["evt-20261016-001", "evt-20261017-002"]
skill_ref: example-skill#测试范围由影响面决定
---

# 合规 fixture：全部 7 个可选键齐备（示例数据，非真实教训）

正例：`validate.mjs` exit 0。tags 里刻意混入需引号保形的 `"13500"`（不加引号会被 YAML 解成数字 → 红）。
日期类键**必须**带引号写成字符串 —— 不加引号会按 YAML 时间戳解成 Date（两条 YAML 后端对非法值的
判定还不一致），契约只认字符串形态。
`skill_ref` 是规程出处（§1.4），与 `guard_ref` 互斥 —— 本 fixture 的 `guard_ref: null`
正是规程型条目的形态，两者不可同时非 null。

本文件只用于技能测试的正向断言，住在技能 `tests/fixtures/` 而非实例条目库，不受项目命名门禁管辖。
