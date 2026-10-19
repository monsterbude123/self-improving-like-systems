# 经验/自进化系统 · 四实体 schema 契约

> **角色**：一切后续工具（门禁 / 注入 / 接线 / 事件 / 蒸馏 / 落盘注册 / 退役 / 对账）
> 从本文件读取字段定义。**执行侧判据唯一权威** = `../scripts/validate.mjs`；
> **参数唯一权威** = 项目实例配置 `.self-improving.yaml`（模板见 `../scripts/config.example.yaml`）。
> **变更程序**：契约变更必须同批修改 schema.md + validate.mjs + fixtures + 受影响消费方
> （契约与判据不允许漂移）。

## 0. 总览与职责边界

| 实体 | 载体 | 校验者 | v0 状态 |
|---|---|---|---|
| Entry | `config.storage.entries_dir` 下 `*.md` 的 YAML frontmatter | `validate.mjs`（本契约）+ 条目门禁 | 实装 |
| Event | 本地 gitignored JSONL（`config.storage.events_dir`） | 事件工具 | 契约成文，本契约不产不校 |
| Guard | `config.storage.registry`（注册层）+ Guard 实体（对账层，§3） | 门禁 / 落盘注册 | 契约成文 + 空表骨架 |
| Promotion | 无存储（字段桩） | — | **仅定义字段，v0 不实操** |

**校验器职责边界（单一归宿，不许出现第二份判据）**：`validate.mjs` 只做结构与枚举校验
（必填键 / 枚举 / scope 合法 / guard_ref 形态 / 配置结构与 kill-switch 类型）。以下**不在**校验器内：

- 「resolved 条目必须有 guard_ref 且指向 registry 中存在的守卫」→ **条目-守卫绑定门禁**
  （它还负责存量豁免与 Tier 0 路由）。
- 「事件 fingerprint 归并」「守卫 shadow 升级」→ 事件层 / 落盘注册层。
- 「条目命名与编号唯一性」→ 项目侧命名门禁（本契约不重复实现；本技能 fixtures 不受其管辖）。

## 1. Entry —— 条目 frontmatter

### 1.1 字段表（7 个键**全部必填**；这 7 键之外的键只有 §1.4 可选键合法，其余 = 违规）

| 键 | 类型 | 约束 |
|---|---|---|
| `type` | enum | `LRN` \| `ERR` \| `FEAT`（与条目命名前缀一一对应） |
| `status` | enum | `pending` `active` `resolved` `open` `investigating` `proposed` `approved` `shipped`（并集，见 §1.2） |
| `scope` | string | ∈ 实例配置 `scope.values`（校验器从 config 读，不硬编码第二份） |
| `claim` | string | 非空；**可证伪断言**（蒸馏提案三要素之一） |
| `guard_ref` | string \| null | `null` = 尚未绑定；非 null = **registry key** 形态 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`。**存在性 + 反向覆盖**校验归条目门禁（key 存在**不蕴含**该守卫声明了本条目：trace 拍3 判的是 `covered_entries`，漏登记则六拍不可走完；`mode: debt-stub` 按契约不声明覆盖，显式豁免）。⚠ 这是**机器判据**：下游五处（trace 拍3 找 registry + 判 `covered_entries`、拍4 读状态账、D13 存在性、verify 观测账 `guard_keys`）一律假定它是 registry 成员 —— 规程出处写 `skill_ref`（§1.4），**不得用 `skill#section` 形态塞进本键** |
| `recurrence` | integer | ≥ 0；复发/命中计数（由 `verify.mjs --sweep` 按守卫命中账回写 +1，**不在命中当场改** —— 见 §3.2） |
| `last_verified_at` | string \| null | `null` 或 `YYYY-MM-DD` 字符串；守卫命中被 sweep 回写时刷新（退役判定的输入之一） |

键的**存在性**是强制的（迁移时写 `guard_ref: null` / `last_verified_at: null` 占位即可）——
这保证存量语料迁移是纯机械追加，也保证下游读取方永远不必写 `fm.x ?? default` 兜底。

### 1.2 status 枚举与 type 耦合（v0 不强制耦合）

状态词表 = 三台状态机取并集：
LRN `pending / active → resolved`；ERR `open / investigating → resolved`；FEAT `proposed → approved → shipped`。

v0 校验器**只查并集，不查 type↔status 耦合**。理由：蒸馏提案文件会以
`type: LRN` + `status: proposed` 的组合出现（提案态不是三台状态机的既有词，但落在并集内），
提前强制耦合会把提案器卡死。后续阶段若要收紧，必须在本文件与 validate.mjs **同批**加。

**本节是条目状态机的唯一定义位置。** 三台状态机只以本节词表为准：项目侧 skill、
`loc-dev.md`、全局 catalog 一律不得再写第二套状态机或第二份状态词表 —— 两个词表漂移时，
条目在 A 处判 `active`、在 B 处判 `pending` 是**静默**的，且没有任何门禁会红
（枚举校验只查「在不在某一份并集里」，查不出该用哪一份）。
历史双轨 backlog 机制（条目状态机 + `Priority` / `Area` 键驱动的第二套流转）已废弃：
`Priority` / `Area` 等废弃键的回灌由「契约外键即红」强制（§1.1 / §1.4 + `validate.mjs`），
**不另立判据**。

### 1.3 frontmatter 形态

- 文件必须以 `---` 行起始、下一个 `---` 行闭合；其内必须是 YAML 映射（非空对象）。
- 违规形态（任一即 exit 1）：缺 frontmatter / 未闭合 / YAML 解析失败 / 非映射 / 缺必填键 / 未知键 / 字段值违规。
- 与正文的关系：**校验器不读正文**；存量迁移只追加 frontmatter，保 ID、保文件名、保正文语义。
- 命名（`LRN|ERR|FEAT-YYYYMMDD-NNN[-slug].md`）不在本契约内 —— 归项目命名门禁。

#### 1.3.1 取号必须经分配器（2026-10-18 立 · 编号唯一性）

**NNN 的分配权威 = `scripts/next-id.sh`，不得自行「扫本地目录取 max+1」。**

```bash
# 新建条目前取号（--claim 会原子占用，同号并发时后到者拿 exit 3，重跑即可）
bash .agents/skills/self-improving-like-systems/scripts/next-id.sh <LRN|ERR|FEAT> --claim
# 排查跨工作树撞号
bash .agents/skills/self-improving-like-systems/scripts/next-id.sh --audit [YYYYMMDD]
```

**为什么不能自己取号**：`.learnings/` 是被跟踪目录，**每个 git worktree 各有一份独立检出**。
「扫本地取 max+1」只看得到本工作树，兄弟工作树里**尚未提交**的条目完全不可见 ——
两个 agent 并发取号必然撞号。这不是疏忽，是本地扫描在多工作树下**结构上不可能**看见别人。

分配器把可见域扩到五层：本工作树 / 主检出 / **兄弟工作树** / claim 记录 / `my_dev` 已提交条目；
同秒并发的最后一瞬由 claim 文件的原子创建兜住。

**判据**：文件名里的 NNN 必须是分配器吐出来的。凭印象取号、或扫本地目录取 max+1，
产出的号**可能在别人那里已被占用** —— 而 D6 命名门禁只看当前检出，
并***分支里的撞号在合并前完全不可见**（撞号不是发现得太晚，是根本没机会被发现）。

> 存量豁免见 `scripts/gates/baselines/D6-learnings-duplicate-ids.txt`。
> 清理存量撞号时必须同步改所有引用该 ID 的位置（registry / `covered_entries` / 其它条目正文）。

### 1.3.5 召回排序（加权打分 · 三因子）

召回不是词典序，是**加权打分** —— 业界长期记忆检索（Mem0 / AWS AgentCore Memory / LangGraph）
用的是同一组维度，差别只在权重与衰减常数：

`score = w_relevance·relevance + w_importance·importance + w_recency·recency`，三因子各归一到 [0,1]，
同分一律 **id 升序**收口（同一 scope 每次输出必须确定）。

| 因子 | 取值 | 口径 |
|---|---|---|
| `relevance` | 关键词命中数 / `relevance_saturation` | 封顶不加分。**无查询时（SessionStart 尚无 prompt）恒 0**，让位给另两因子 —— 不得拿 0 与别人的非 0 相比 |
| `importance` | `0.6·recurrence 归一 + 0.4·status 归一` | recurrence 是唯一与内容无关的**硬证据**（被现实攻击过的次数），故压过 status 流程位；recurrence 走对数压缩，否则 0→1 的信息增量与 30→31 相同 |
| `recency` | `0.5 ** (ageDays / recency_half_life_days)` | 指数半衰。日期取 `last_verified_at ?? date`；**皆无时取 0.5 中位** —— 「不知道多老」不等于「最老」，取 0 会让存量条目永远沉底且无回升路径 |

**为什么不能是词典序**：词典序下「命中 1 次」永远压过「命中 0 次但重要得多」，而新近度只能当末位
tiebreak；经验条目不是聊天记录 —— 相关性决定「是不是在说这件事」，重要度决定「值不值得占一屏」，
新近度只做破平（否则系统会朝「最后写的」漂移）。

**权重可调**（`config.injection.ranking`，缺项/非法回落内置默认 relevance .55 / importance .30 /
recency .15，半衰 30 天）。**审计全量落盘**：每条被召回的条目连同 score 与三因子一起写进
`entry-recalled` 审计，故「凭什么是它」永远可回答。
**全部候选同分 → 降级为零注入**（`rank-degenerate`）：排序退化成 ID 字典序时，相关性恒等于 0，
那种「看起来在挑、其实在数 ID」的注入比不注入更糟。
判据实现 = `inject.mjs` 的 `scoreEntry` / `resolveRanking`。

### 1.4 可选键（检索元数据 · 缺失不违规，**类型错即红**）

这 6 个键是**存量条目迁移前 frontmatter 里真实出现过、且有检索价值**的键（前 5 个），
外加 `event_ids` —— 拍1 关联链路的落点（`approve.mjs` 从草案的「来源事件」行搬进来）。
第 7 个 `skill_ref` 是**契约新增**（2026-10-17），例外说明见下方专段。
前 5 个的键集不是设计出来的清单，而是对存量语料的事实统计（新增可选键须先找到实际出现的样本）；
「有检索价值但没进契约」的后果是旧数据在迁移时被剥掉且无处可查 —— 所以走扩契约，不走删数据。

| 键 | 类型 | 约束 | 检索用途 |
|---|---|---|---|
| `tags` | string[] | 元素全须字符串（纯数字/日期类标签加引号保持字符串） | 主题 / 工具 / 模块检索的主入口 |
| `date` | string | **带引号的** `"YYYY-MM-DD"` 字符串 | 条目时间序检索、批次分组 |
| `category` | string | 非空字符串 | 粗分类（存量多为「经验教训」一类的自由词） |
| `resolved_date` | string | 同 `date` | 闭环时间（可选项，仅已闭环条目有） |
| `resolved_by` | string | 非空字符串 | 闭环溯源（commit / 票号 / 复核人自由文本） |
| `event_ids` | string[] | 元素形如 `evt-YYYYMMDD-NNN` | 拍1「这条经验由哪些事实学来」的唯一强链接（trace.mjs 判据） |
| `skill_ref` | string | **非 null 字符串**（缺失就别写该键，写 `null` 与 `date`/`event_ids` 同口径判红）；形态 `<skill-dir>#<章节标题>`：skill-dir 同 `guard_ref` 的小写连字符形态，章节标题为非空自由文本（可含空格，不含 `#`） | **规程出处**：这条经验的真实现位是某个 skill 的一节（人读的规程，**无派发**） |

**`skill_ref` 为什么单开一键而不放宽 `guard_ref`（2026-10-17 裁决）**：
有一类条目的真实内容**不是新规则**，而是「某个 skill 的某一节已经写了」——它没有、也不该有机器判据。
此前唯一的表达方式是把 `guard_ref` 写成 `vvicat-testing#测试范围由影响面决定`，代价是：
下游五处（trace 拍3 找 registry + 判 `covered_entries`、拍4 读状态账、D13 存在性、
verify 观测账 `guard_keys`）全部假定 `guard_ref` 是 registry 成员，塞进 `skill#section`
等于在一条链上同时开六个口子，且**每一个口子都静默**（查不到就当「没登记」，永不报错）。
所以 `guard_ref` **保持严格**，规程出处另起一键，两者语义互斥：

| | `guard_ref` | `skill_ref` |
|---|---|---|
| 语义 | **机器判据** | **规程出处** |
| 消费方 | 门禁 / trace 拍3-6 / verify 观测账 / 退役 | 仅人读（无自动消费方） |
| 形态 | registry key `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` | `<skill-dir>#<章节标题>` |
| 缺失 | 合法（尚未绑定，写 `guard_ref: null` 占位） | 合法（**整个键不写**；写 `skill_ref: null` 是类型错即红，与 `date`/`event_ids` 同口径） |

**两者同时非 null 即判红**（`validate.mjs` 互斥判据）：一条经验要么有机器判据、要么有规程出处，
**不许双挂**。双挂的真实危害是「既挂了个假守卫又在正文里指了个出处」——观测账只认真执行过判据的
派发，规程章节永远派发不出判据，于是这条条目会同时持有「有覆盖者」与「永远攒不到证据」两种身份，
把退役判定的输入污染成自相矛盾的账。

**⚠ 规程型条目（`guard_ref: null` + `skill_ref: <非空>`）不参与六拍达成率统计。**
判红是**正确行为**，不是坏了：拍2 的判据就是「已绑定守卫」，规程型条目永远过不了拍2，
因而拍3-6 必然连带为红。若把它计入达成率，会产生一个明确的反向激励 ——
为了把指标做绿而给规程型条目**伪造一个假守卫**（恒 `exit 0` 的空壳），而那正是
§3.3 退役链明令拒绝的证伪武器化。`trace.mjs` 在拍2 的 evidence 里显式标注该条目形态，
使人读得懂「这条无机器判据，拍3-6 预期为红」。

**`event_ids` 为什么是「条目 → 事件」而不是「事件 → 条目」**：事件是**只增不改的证据账**
（`stoploss.md` §2），一次蒸馏裁决不得回写事件 —— 否则证据会被裁决结果污染，且并发归并时
两侧写同一字段必然漂移。条目是人工裁决后的产物，由它声明来源是它的本职。事件侧的 `entry_id`
字段保留在契约内（事件自身形态，兼容外部写入），但**拍1 判定以条目侧 `event_ids` 为准**。
历史包袱：事件侧 `entry_id` 由 `capture.mjs` 硬写 `null` 且全仓无人回写，此前**条目与事件之间不存在
任何一条链**，导致拍1 对全部存量条目恒 ✗、六拍链永远走不完、trace 永远判冻结。

**日期类键为什么强制带引号的字符串（源码级判定）**：不加引号的日期，两条 YAML 后端的解法
**方向相反** —— `js-yaml`（容器/全量路径）默认 schema 把它留成字符串判绿，`yaml-lite`（宿主钩子
路径）按 YAML 时间戳强制转换；而非法时间戳 `2026-13-45` 在 `js-yaml` 下会被 `Date.UTC` 进位成
合法 Date 判绿、在 `yaml-lite` 下留成字符串判红。于是无论校验「解析后是不是字符串」还是
「日期有效吗」，同一条语料都可能在两处判出不同颜色。唯一后端无关的落点是**源码形态**：
`date` / `resolved_date` 必须写成 `key: "YYYY-MM-DD"`，校验器在源码层比对引号形态
（`checkDateLiteralSource`），解析值判定只作双保险。

**`id` 与 `title` 刻意不在契约内**：ID 取自文件名（`<ID>-<slug>.md`）、标题取自正文 H1 ——
在 frontmatter 里再存一份就等于开了第二份事实源，迟早与文件名/正文漂移。存量 frontmatter 里
曾有的这两个键按此丢弃，不做回填。

**判定实现**：`validate.mjs` 的 `OPTIONAL_ENTRY_KEYS` + `OPTIONAL_ENTRY_KEY_TYPES`（键集与类型表
在同一处，校验器不再写第二份）。**未知键仍然红** —— 扩可选键不等于放松
「契约外不许悄悄溜进 frontmatter」。

## 2. Event —— 事件

| 键 | 类型 | 约束 |
|---|---|---|
| `id` | string | `evt-YYYYMMDD-NNN`（日期+序号；唯一性由事件生成器保证） |
| `ts` | string | ISO 8601 带时区 |
| `source` | string | ∈ 配置 `event_sources` 白名单（gate/hook/tool/manual）；白名单外拒收 |
| `kind` | enum | `tool_error` \| `gate_block` \| `hook_failure` \| `manual` |
| `severity` | enum | `info` \| `warn` \| `error` |
| `payload` | object | 原始细节（供行级引用）；v0 不做结构强校验 |
| `fingerprint` | string | 同一错误的归并键。**首要键而非唯一真理**（近邻候选留人工合并）；宿主/容器双形态路径归一化后计算，算法权威 = 事件层（`../scripts/capture.mjs`：`sha256(kind + 错误码集合 + 消息骨架)`；路径剥已知前缀、否则只留末两段；十六进制/UUID/数字/引号内容一律抹掉 —— 易变部分不抹掉，归并就退化成无限流） |
| `entry_id` | string \| null | 关联条目 ID（`LRN\|ERR\|FEAT-YYYYMMDD-NNN`）或 `null`（未关联） |
| `provenance` | object \| null | **出处**：这条事件从哪来、靠什么采到的（判据表见 §2.1）；`null` = 本次输入不带出处（纯文本 CLI / 门禁文本） |

### 2.1 Event.provenance —— 事件出处（判据）

进化体系要回答「**这条知识从哪来、靠什么学来的**」，出处只记两件事：**采集口**与**身份**。
不记「内容像什么」——那是 `payload` / `tokens` 的职责，两者不得混。

| 键 | 类型 | 约束 |
|---|---|---|
| `collected_by` | string | `hook:<HookEventName>`（宿主钩子采到）/ `cli`（手动或无元数据输入） |
| `transport` | string | 传输入口：`text` / `payload` / `payload-file` |
| `hook_event` | string \| null | 宿主钩子事件名（`PostToolUseFailure` 等）；双写形态 `camelCase` 与 `snake_case` 都认 |
| `tool` | string \| null | 触发失败的工具名（`Read` / `Bash` / `Edit` …） |
| `session_id` / `turn_id` / `trace_id` | string \| null | 会话 / 轮次 / 调用链 ID，用于把一条经验钉回具体那次现场 |

**缺项显式 `null`，不得省略键** —— 省略会让读的人分不清「没采到」与「没记」。**认不出就整条返回 `null`**
（`extractProvenance`，`../scripts/capture.mjs`），绝不臆造出处：错的出处会污染对账，比没有更糟。
**归并时只增不减**：本次没抽到不抹掉首次采到的会话出处（否则一条重复错误会把出处洗成 null）。

**为什么必须有它**：只记 `source: tool` 时，全库所有工具失败长得一样 —— 归并照常工作（fingerprint 只吃消息），
但**归因**（拍2）无从下手：分不清是 Read 超限、Bash 端口占用还是 Edit 冲突，scope 投票与近邻聚类只能靠 tokens 猜。
出处与 `learned_via`（注入/蒸馏审计侧）合起来才构成完整学习路径；只读查询面 = `../scripts/trace.mjs --provenance`。

**存储**：`config.storage.events_dir` 下的 JSONL（文件切分权威 = 事件层）；本地 gitignored，写入后 `git status` 必须干净。
**校验者**：事件层工具。本契约只成文 —— `validate.mjs` 不校事件（事件是运行时账，非受管条目）。

### 2.2 诊断日志（**不是审计**）

事件库与注入审计是六拍的**证据账**：append-only、逐行可对账、**绝不滚动** —— 滚一次就毁掉一批证据。
诊断日志是**另一本**：回答「现在是不是在工作」「刚才那次卡在哪」「哪个模块在报错」，因此才需要
分级、按大小滚动、异常独立成文件。这些特性恰恰是证据账**不能**有的，两者不得混存同文件。

```
<logging.dir>/si.log[.1..N]                  全级别文本；低于 level 的直接丢弃、不构造消息（热路径纪律）
<logging.dir>/si-error.log[.1..N]            仅 error —— 「今天有没有出事」扫一个文件就够
<logging.dir>/si-trace-YYYYMMDD.jsonl[.1..N] 结构化轨迹，log-query 靠它做关联检索
```

**三级标识**（决定「grep 什么能看出一条链」）：

| 标识 | 含义 | 什么时候有 |
|---|---|---|
| `run_id` | 一次进程执行 = **一次调用的完整周期**（含各阶段耗时） | 每次执行必生成 |
| `trace_id` | 调用链标识 | 宿主 hook 信封自带 `traceId` 时取宿主值（capture 独有），否则自生成 |
| 业务键 | `fingerprint` / `entry_id` / `guard_key` / `proposal` | 该次执行涉及哪些条目 / 守卫 / 草案 |

三者缺一不可：只有 run_id 只能看单次执行，只有业务键只能看结果看不到过程。

**心跳行的必要性**：每次派发/捕获/召回都留一条 info。少了它，健康状态下 `si.log` 会一直是空的 ——
而「空日志」无法区分「没跑起来」和「没出事」，`--stats` 就失去了「是不是在工作」的判据能力。

**fail-safe 到极致**：日志写不出来 ≠ 不能干正事。本模块所有 IO 包 try/catch，失败即退化为不写，
调用方零感知（与全系统 fail-open 纪律同源）。配置缺失或损坏时 `log-query` 仍能查（退默认目录 + tmpdir 兜底）。

**默认值必须零项目耦合**：技能内置默认目录是 `.self-improving/logs/`，不得写死任何具体仓的路径
（`approve` 套的「通用性」用例扫的就是这条）；各仓实例配置各自覆盖成自己的 gitignored 路径。

判据实现 = `../scripts/lib/log.mjs`（logger / 分级 / 滚动 / span）与 `../scripts/log-query.mjs`（只读查询面）。

## 3. Guard —— 守卫（双层，两层互指不混）

1. **dispatch 层 = registry 条目**（`config.storage.registry`）：`key / args / when` 三键，
   与宿主 commit 钩子守卫数组同构（说明见 `../scripts/registry.example.yaml` 注释；落盘注册阶段消费）。
   **args 的第一段指向派发器**（`../scripts/run-guard.mjs --key <key>`，直调、不经包管理器 run 层），
   真守卫 argv 放实体字段 `command`：派发器按 `command` 直调后裁决退出码与 shadow —— 拦截权由它挣，不由注册得。
   守卫脚本退出码契约：`0` 放行 / `2` 命中判据（阻断）/ **其他 = 守卫自身异常 → fail-open 只记审计**。

   **`when` 的运行时口径（票 H2 校正 · 此前成文口径与实现不符）**：契约曾写「`when` 由派发器翻译回谓词、
   接进 pre-commit 路由」，但 `run-guard.mjs --all` 是**无条件遍历全表**、从不求值该字段。
   现统一口径为：**`when` 是声明性注解**（记录该守卫在宿主钩子路由里的触发面，供人读），
   **派发器不求值、`--all` 全量派发**；`--dry-run` 把 `when` 原样列出并标注「未求值」，
   免得注解继续冒充「已接线」的假象。
   为什么**不**把它改成派发前的过滤条件（三条各自独立成立，任一条即足以否决）：
   ① **shadow 计数语义**：被过滤掉的派发不记 `shadow_runs`，一条守卫可能永远攒不满绿运行次数 →
      永远停在 warn-only → 拦截权永远挣不到。「过滤」在这里等价于「悄悄杀死守卫」，
      与「拦截权是挣来的、不是注册即得」是同一原则的两面。
   ② **零项目耦合**：`when` 的谓词对象是**宿主** `classifyStaged` 的返回字段（各仓自有的触发面判据），
      通用技能拿不到这些字段，硬编码又会被「技能目录不含项目物」守卫判红；真要求值就得让宿主把 plan
      喂进来 —— 那会把派发器从「通用零耦合 CLI」改造成「依赖宿主上下文的组件」，凭空多一条契约面。
   ③ **失效不可见**：在 fail-open 纪律下，被 `when` 跳过的守卫与「守卫起不来」在报表上同形（都不出现），
      正是运维对账要消灭的那类「静默失效」。真要收窄触发面，应在宿主钩子那一层做（宿主本来就有 plan）。
2. **知识库层 = Guard 实体**（下表）：条目↔守卫绑定的对账事实（门禁 / 落盘注册 / 对账消费）。

| 键 | 类型 | 约束 |
|---|---|---|
| `kind` | enum | `gate`（commit 门禁）\| `hook`（生命周期钩子） |
| `path` | string | 仓内相对路径（守卫脚本位置） |
| `command` | string[] | 直调 argv（与 registry `args` 同源，**不经包管理器 run 层**） |
| `covered_entries` | string[] | 绑定的条目 ID（`LRN\|ERR\|FEAT-YYYYMMDD-NNN` 形态）；门禁校验每条在 `entries_dir` 存在 |
| `last_run` | string \| null | ISO 8601；最近一次运行时间 |
| `last_result` | enum \| null | `pass` \| `fail` \| `skipped` \| `error`（`error` = 守卫自身异常 → fail-open 只记审计不阻塞） |
| `shadow_runs` | integer ≥ 0 | shadow 运行累计次数（新守卫首 3 次 warn-only） |
| `shadow_green` | integer ≥ 0 | shadow 中绿的次数；`shadow_runs ≥ 3 && shadow_green === shadow_runs` → 自动升 blocking |

**运行时字段落位（票 10 落盘注册阶段收口）**：静态注册字段（`key/args/when/kind/path/command/
covered_entries/shadow_required`）随 registry **入仓**；运行时字段（`last_run / last_result /
shadow_runs / shadow_green / error_runs / error_streak / ever_hit / wild_hits / probe_hits` 及派生的 `mode / promoted_at / last_run_ms`）每次 commit 都会变，
写进 registry 只会造成仓内 churn —— 落**本地 gitignored 状态文件**，路径 = `config.storage.guard_state`，
缺省取 `dirname(config.storage.events_dir)/guard-state.json`（与事件/提案同一被排除目录，仓内零 diff）。
计数由派发器裁决：`shadow_runs` 每次派发 +1，`shadow_green` 只在放行时 +1；
`shadow_runs ≥ shadow_required && shadow_green === shadow_runs` → 自动升 blocking，此后命中即阻断。
**判定要绿才升、红就一直只是警告** —— 判据抓不准的守卫停在 warn-only 是正确状态，不是故障。
新增守卫字段须同批改本节 + 派发器 + 测试。

### 3.1 条目观测账（`state.entries` 段 · 票 11 收口）

同一状态文件里另有一段按**条目 ID** 索引的观测账，它同时是命中记账与退役判定的证据源：

| 键 | 类型 | 含义 |
|---|---|---|
| `guard_keys` | string[] | 覆盖过它的守卫 key（来源 = 该守卫的 `covered_entries`；空数组的守卫不产生观测账） |
| `observed_runs` | integer | 被**真执行了判据**的派发次数（pass / block / shadow-warn；红向也是 +1 —— 判据跑了不响正是退役的正证据）。**守卫自身异常（起不来 / 超时 / 非约定退出码）不计** |
| `observed_error_runs` | integer | 判据**没跑起来**的派发次数（**累计**、只增不减；仅供人审，**不参与退役证据** —— 拿它当门会让守卫异常过一次就把它覆盖的条目永久锁死，见 `last_observation`） |
| `last_observation` | enum | **末次**派发的观测健康度：`healthy`（判据真的跑了）/ `error`（守卫异常）/ `unknown`。**这是拍5 probe 分支的证据门**（与 `probe_last_outcome` 同款末次语义）。账上无此字段（旧账）时回退到 `observed_error_runs == 0`，**不追溯洗白** |
| `last_observed` | ISO 8601 | 最近一次**判据真的跑过它**的时间（异常派发不刷新） |
| `last_error_run` | ISO 8601 | 最近一次守卫异常派发时间 |
| `wild_hits` | integer | **野外（wild）**累计命中次数：真实路由上捕获的失效（对账数，永不清零）。退役证据只认这一根 |
| `probe_hits` | integer | **探针（probe）**累计命中次数：`run-guard.mjs --probe` 人造违规被拦下（解冻前的破坏测试，stoploss.md §4）。**自证，不作退役证据、不回写条目正文** |
| `legacy_hits` | integer | 分型**之前**的历史 `hits`（旧字段已退役）：来源不可知（当年野外复发与破坏测试混在同一根柱子上），既不算命中过、也不算没命中过 —— **退役一律拒绝**（见 §3.3） |
| `first_hit` / `last_hit` | ISO date | 首/末次**野外**命中日期（另供拍1 的 date-overlap 弱链接读） |
| `first_wild_hit` / `last_wild_hit` | ISO date | 首/末次**野外**命中日期（拍5 的 wild 判据读 `first_wild_hit`） |
| `probe_last_outcome` / `probe_last_outcome_at` | `proven` \| `missed` / ISO 8601 | 末次探针结论与时刻（**每次** `--probe` 派发都刷新：一次「没拦住」就把探针证据打回红） |
| `pending_hits` / `pending_records[]` | integer / {guard,date,at}[] | **待 sweep 回写（wild 专用）**的命中明细 —— 只有它会抬 `recurrence` 并写正文对质段 |
| `pending_probes` / `pending_probe_records[]` | integer / {guard,date,at}[] | **待 sweep 结账（probe 专用）**：只清账成 `swept_probes`，**一个字都不写条目** |
| `swept_hits` / `last_swept_at` | integer / ISO 8601 | 已回写次数与时间（**只计 wild**） |
| `swept_probes` / `last_probe_swept_at` | integer / ISO 8601 | 已结账的 probe 次数与时间（拍6 的 probe 路径判据读它） |
| `hit_ledger_version` | integer | 命中账分型版本（现为 `2`）。缺此标记 = 分型前存量 → 按 legacy-unknown **保守回填**（不回填 wild、不追溯追认 `ever_hit`） |
| `sweep_inflight` | {prev_recurrence, records[]} | 一次性 sweep 的两阶段记账（见 §3.2），收尾后清除 |
| `archived_at` / `archive_path` / `restored_at` | ISO 8601 / string / ISO 8601 | 退役与恢复留痕 |

#### 3.1.1 命中必须分两型记（wild / probe）—— **为什么这不是洁癖**

破坏测试（解冻前那步，`stoploss.md` §4「先跑破坏测试把拍5 做实」）与真实路由走**同一个 CLI 入口**：
`node run-guard.mjs --key <k> --text <s>`。不拆账时，「我们自己造出来验证守卫能用的违规」与
「野外真发生的违规」在账上**完全不可分** —— 而两者证据强度差一个数量级：

| | wild（野外） | probe（探针） |
|---|---|---|
| 来源 | 真实路由（真实提交 / 真实执行）| `--probe`：人造违规，验证守卫「真能拦」 |
| 能作退役证据 | ✅ `ever_hit` 由它置位 | ❌ **永不置 `ever_hit`** |
| 能回写条目正文 | ✅ 抬 `recurrence` + 写对质段 | ❌ 只结账（`swept_probes`） |
| 能让六拍拍5 绿 | ✅ | ✅（替代路径，带有效期与零异常前提，见 §3.4） |

不分账的代价是可量化的：**一次人造违规 = 换来 90 天后用这份守卫退役真实经验条目的资格**
（退役链读守卫级 `ever_hit`，`cycle_days` 默认 90）。退役是本系统唯一的不可逆动作，所以这条必须由**账**保证，
不能靠「大家记得那是自己造的」。

CLI：`node run-guard.mjs --probe --key <k> --text <s>`。它**照常派发守卫、照常按 exit 2 阻断**，
唯一区别是命中记到 probe 账上（`--probe` 与 `--all` 可同用）。`shadow_warn` 算 **wild** ——
它仍是真实路由上的 warn-only 捕获，只是还没挣到阻断权。

**为什么 `observed_runs` 与 `observed_error_runs` 必须分开**（票 H1 修复）：两者混同在数据上等价于
「守卫自己坏了也算它在看着这个条目」。于是注册一个恒 `exit 0` 或恒报错的空守卫 → 绿灯攒满自动升
blocking → 它覆盖的条目同时满足「观测 > 0」「从未命中」「久未观测」→ 整批被退役。
**证伪机制不能被反向武器化**：一个从没有真正看过内容的守卫，它的沉默不是证据。

守卫级账（`state.guards[key]`）相应新增这些运行时字段：`error_runs`（守卫自身异常累计）、
`error_streak`（**从上次成功起连续 error 几次**：成功清零、异常 +1；票 H2 新增，见下）、`ever_hit`
（该守卫的判据**曾经真的在野外命中过任何东西**，含 shadow 期 shadow-warn；**`--probe` 永不置位**）、
`wild_hits` / `first_wild_hit` / `last_wild_hit`、`probe_hits` / `last_probe_at` /
`probe_last_outcome` / `probe_last_outcome_at`、`legacy_ever_hit`（分型前那条来源不可知的历史命中，
回填时清零并留痕）、`hit_ledger_version`。它们与条目级账共同构成 §3.3 的退役证据链。

**存量回填为什么必须朝保守方向**（分型 v2）：分型前的 `hits` / `ever_hit` 无法区分是野外复发
还是我们自己造的破坏测试（当年两者同账）。回填口径是「历史 `hits` → `legacy_hits`（unknown）、
历史 `ever_hit` → 清零并留 `legacy_ever_hit` 标记」，**不追溯追认**：在没有新事实的前提下改判历史事实的
方向，出错方向是「删掉真知识」，与止损线的方向相反。代价是老守卫要**重新挣**一次 `ever_hit`
（下次真野外出事即置位），换来的是「一次人造违规永远换不到清空真实条目的资格」。回填幂等
（`hit_ledger_version` 标记），重复跑不叠加。

**`error_streak` 为什么必须与 `error_runs` 分开**（票 H2 · 架构审计 F9）：`error_runs` 是历史累计，
「3 次 error 中间断着 2 次成功」与「连挂 3 次」在累计口径上不可分，而后者才是「判据根本没在跑」的信号。
守卫异常按设计 **fail-open**（不阻塞提交、error 不计绿），这条纪律不动；缺的只是**可见性**：
`run-guard.mjs --dry-run` 据 `error_streak ≥ 3`（常量 `ERROR_STREAK_THRESHOLD`，与 `DEFAULT_SHADOW_RUNS` 同数）
单列「连续 error 守卫」清单 —— 阈值取 3 的理由：单次多为环境抖动（不报），5 以上会让「整段 shadow 期都在报错」
这种最该看的场景反而看不见（阈值过大 = 漏报）。**本视图只提升可见性，不改变 fail-open 放行行为。**

### 3.2 命中刷新与证伪（`verify.mjs`，**高频记账与低频回写两层**）

守卫命中是**高频**事件（每次拦截都发生）。票 10 曾让派发器直接改写仓内条目的 `recurrence` /
`last_verified_at`；票 11 起改为分层，理由是每次拦截都弄脏一次仓内文件是纯 churn，
而「被现实攻击过」要留痕的地方是条目正文末尾的对质段：

1. **高频层（本地 gitignored 状态账）**：blocking 命中 → **wild** 记 `wild_hits` +1、
   `pending_records` 追加 `{guard, date, at}`、`pending_hits` +1；**probe** 命中（`--probe`）只记
   `probe_hits` +1 与 `pending_probes` +1（**不进** `pending_hits` —— 那条队列是 wild 专用）。
   两型都**一个字节都不碰仓内条目**。
2. **低频层（仓内条目）**：`verify.mjs --sweep` 是**唯一**回写口，且**按型分账**：
   - **wild**：按账把 `recurrence` 加上 `pending_hits`、`last_verified_at` 刷新为末次命中日期（带引号），
     并在**正文末尾**追加对质段 `### 复发 N · YYYY-MM-DD` + 证据行（守卫 key、拦截形态、回写前后值）。
     **历史段落零改动** —— 判据 = 原文每一行都按原序保留（diff 删除行 = 0），只豁免 `recurrence` /
     `last_verified_at` 两个键。一次 sweep = 一条 commit 粒度的可审计写入。
   - **probe**：只把 `pending_probes` 结账成 `swept_probes`（+ `last_probe_swept_at`），
     **不改 `recurrence`、不改 `last_verified_at`、不写对质段、不碰条目文件**（连条目是否存在都不要求）。
     理由：破坏测试证明的是「守卫抓得住东西」，不是「这条经验在野外复发了」——
     写进正文就是把自证污染成知识库事实。它仍需一次显式 sweep：探针证据必须有落点（拍6 读 `swept_probes`）。
3. **崩溃恢复靠账不靠正文**：sweep 走「先记 `sweep_inflight`（本次起点 + 明细）→ 改条目 → 清账」
   三步。重跑时以**账上记录的起点**重放（不取文件当前值，故不二次累加）；文件已是目标值时只收尾
   并报 `already-applied`。**不按正文判重** —— 同一守卫同一天的两次命中证据行完全相同，靠正文判重会吞新账。

### 3.3 退役与恢复（`verify.mjs --retire / --restore`）

退役区 = `config.storage.archive_dir`，缺省 `<entries_dir>/archive/`（条目区根层扫描不递归子目录，
天然不在 `validate --all` / 命名门禁 / 绑定门禁的管辖面内）。退役 = **整文件移动**：
内容一字不改、不删正文（append-only），账上留 `archived_at`；`--restore <ID>` 原样搬回（字节级可逆）。

退役判定**保守**，六条同时满足才退役，任一不满足即如实跳过并说明理由：

| 条件 | 理由 |
|---|---|
| 观测账有该条目且 `observed_runs > 0` | 从没被**真执行了判据**的派发覆盖过 = **没有证据**，不是「无人命中」 |
| 观测账 `guard_keys` 非空 | 没有覆盖者就没有退役证据（`covered_entries` 为空的守卫不产生观测账） |
| 至少一个覆盖守卫 `mode == blocking` | shadow-only 守卫没挣到拦截权，它的沉默不是证据 |
| 至少一个 blocking 覆盖守卫 `ever_hit == true` | **空守卫的沉默不含信息量**：判据从未在野外命中过任何东西的守卫（恒 `exit 0`、判据为空）不产生退役证据。⚠ `ever_hit` **只由 wild 命中置位**，`--probe` 人造的破坏测试命中永不置位 —— 否则一次人造违规就换到清空真实条目的资格 |
| `last_observed` 距今 > `retire.cycle_days` | 守卫确实长期在跑 |
| `wild_hits === 0` 且 `pending_hits === 0` | 野外出过事的条目不是「长期不响」；有没算清的账就不许动条目（先 sweep） |
| `legacy_hits === 0` | 分型前的历史命中来源不可知：它既不证明「命中过」，也不证明「没命中过」—— 不许拿它当任一侧的证据 |

后四条收紧的理由是一条：**证伪机制不可被反向武器化**（票 H1）。收紧前，一个恒 `exit 0` 的空守卫
三次绿灯即自动升 blocking，它声明 `covered_entries` 覆盖的**真实经验条目**就会在 `cycle_days` 后
被判定「长期不响」整批移出知识库 —— 而没有任何人证明过它看得懂这些条目。
`run-guard.mjs --all --dry-run` 把每条守卫的**证据强度**（`evidence=strong / weak / debt /
no-evidence`，判据与退役共用 `evidenceStrength`）打进报表，供人审时区分「证据充分」与「看着都绿」。

状态文件缺失或损坏 → `--retire` **exit 1 拒绝退役**（此处刻意比 `run-guard` 严格：派发器把坏账当空状态
只是退回 shadow，退役拿空账当证据会把整库误清，属不可逆动作，不许 fail-open）。

#### 3.3.1 跨副本语义：退役区必须**入库**（票 H3 · 架构审计 F7/B4）

**退役区若落在 git 排除路径下（`.gitignore` / `.git/info/exclude` / 任何 exclude 机制），
`--retire` 直接 exit 1 拒绝执行**（`--dry-run` 同样拦），并在报错里给出三条出路。

为什么这条要由**程序**拦而不是写进文档：上面六条判据管的是「该不该删」（证据是否充分），
而本条管的是「删了**别人**还能不能看见」（跨副本是否可共享）。**这是两个正交维度** ——
本仓退役区被 exclude 就是一个已实测的真实形态：此时「移动文件」在**提交层面**根本不是移动，
而是「活动区一条删除」：归档副本不入库 ⇒ 别人拉取后条目从活动区消失、**且没有任何归档副本**
（只剩 git 历史），而发起者的 `--restore` 只恢复他自己本机。把不可逆动作的安全性寄托在
「人记得读这段文档」上，等于没有防护。

三条出路（择一即可解锁）：

| 出路 | 做法 | 跨副本语义 |
|---|---|---|
| ① **退役区入库**（推荐） | 把 `config.storage.archive_dir` 指到受跟踪目录 | 归档是共享知识，人人都能看/能 restore |
| ② 退役改为「只改 status 不移动文件」 | 正文留在活动区、共享可见 | 无归档副本，靠 frontmatter `status` 表达退役态 |
| ③ 显式声明「本机私有归档」 | 接受该语义并写进团队约定 | 跨副本不可见、**restore 不跨机**（等于承认这是本机私有丢弃） |

判据实现 = `verify.mjs` 的 `archiveIsShareable()`：以 `git check-ignore` 探测**退役区内的哨兵文件**
（⚠ 不能探测目录本身 —— 排除项形如 `path/`（尾部斜杠）时 `git check-ignore <目录>` 恒返回
「未被忽略」，探目录会让本守卫**恒绿**）。非 git 目录无从谈跟踪 → 放行（不误伤普通项目用法）。

#### 3.3.2 ID 撞号：ID 已是主键，撞号即拒绝动作（票 H3 · 架构审计 F2/B2）

新架构把条目 **ID 当主键**用，三处都按 ID 定位：`state.entries[id]` 观测账、registry
`covered_entries`、`--restore <ID>`。因此**同一 ID 被多条教训占用时，三条路径一律显式拒绝**，
绝不「静默取第一个匹配」：

| 动作 | 撞号时的行为 | 静默取首个会怎样（2026-10-16 实测） |
|---|---|---|
| `--sweep` | **exit 1 硬失败**，正文零改动 | 把 A 的命中回写进 B 的正文（`recurrence` 污染） |
| `--retire` | 该组**全部跳过**，报表逐条说明 | 拿两条混合的观测证据退役其中任意一条 |
| `--restore` | **exit 1 硬失败**，一条都不搬回 | 搬回**别的**那条条目（张冠李戴） |

定位实现：`findEntryFiles()`（复数，看全集）与 `findEntryFile()`（单数，**≥2 个匹配时返回 `null`**，
即「拿不准就不动」），判据与报错文案共用 `ambiguousIdError()`，三处措辞不漂移。

**新增撞号由门禁拦住**：`D13-entry-guard-binding.mjs` 在全量模式下做「ID → 文件」唯一性断言，
存量撞号走 **D6 的同一份基线** `scripts/gates/baselines/D6-learnings-duplicate-ids.txt` 显式豁免
（唯一归宿，不另立一套）。D6 与 D13 的 PASS 输出都**如实报出豁免组数** —— 票 H3 审计：
D6 此前固定打印「编号唯一性全部合规」，而基线里躺着 7 组真实撞号，属措辞误导，已改为
「命名格式全部合规；编号唯一性: N 组存量豁免」。

## 4. Promotion —— 提升（**字段桩 · v0 仅定义不实操**）

> ⚠️ **v0 明确声明**：本实体只有字段定义 —— 无存储位置、无工具、无校验器覆盖、无消费方。
> 「跨项目通用经验提升到规则文档」的现行人工流程在 v0 不改动；何时实操由后续批次立项。

| 键 | 类型 | 说明（桩） |
|---|---|---|
| `entry_id` | string | 被提升的条目 ID |
| `target_path` | string | 提升目标（项目规则文档 / 项目 skill 文件） |
| `promoted_at` | string | ISO 8601 |
| `approved_by` | string | 批准人（v0 = 用户） |

## 5. 消费方索引（每个阶段读哪份契约）

| 消费阶段 | 读取 |
|---|---|
| 条目门禁 | §1 Entry.guard_ref 形态（存在性自建）+ registry + config；§1.4 `skill_ref` 形态与「双挂互斥」判据（**均只在 `validate.mjs` 内，`scripts/gates/D13-entry-guard-binding.mjs` 不读该键** —— `status !== 'resolved'` 已放行规程型条目） |
| 注入引擎 | `config.injection`（top_k / budget_chars）+ `config.scope` + `kill_switch.injection` |
| 生命周期接线 | `config.injection.budget_ms ≪ timeout_ms` + `config.hook.default_scopes`（SessionStart 无 prompt 时的保守默认域，空数组 = 不注入） + `kill_switch.injection`；接线形态见 `hook-wiring.md` |
| 事件捕获 | §2 Event + `config.event_sources` + `storage.events_dir`（文件切分 = 事件层，实例按日分片 JSONL）+ `kill_switch.capture`（off 时零写盘零检索） |
| 蒸馏提案 | §1（提案文件过校验器）+ `storage.proposals_dir` + `kill_switch.distill` |
| 落盘注册 | §3 Guard + registry 同构条目 |
| 命中刷新 / 证伪 | §3.1 条目观测账（含 §3.1.1 **wild / probe 两型**）+ §3.2 两层回写（`verify.mjs --sweep`，**回写只计 wild**） |
| 退役判定 | §3.3 判据表（`ever_hit` 只认 wild、`legacy_hits` 一律拒绝）+ `config.retire.cycle_days` + `config.storage.archive_dir` |
| 运维对账 | 全链对账（Entry ↔ Event ↔ Guard，数据源 = 审计日志 + registry 实况）；实现在 `../scripts/trace.mjs`（只读五处数据源、六拍判定、行级引用），止损程序见 `stoploss.md`。**规程型条目（§1.4 `skill_ref`）不在六拍达成率口径内** —— 拍2 判据就是「已绑定守卫」，这类条目拍2-6 预期为红 |

**六拍里的两型（拍5 / 拍6，判据出自 `trace.mjs`，与 §3.3 同源纪律）**：

| 拍 | wild 链 | probe-only 链（无任何 wild 命中时） |
|---|---|---|
| 拍5 拦截命中 | `wild_hits ≥ 1` 且 `first_wild_hit` 是字符串 | `probe_hits ≥ 1` 且 `probe_last_outcome == 'proven'` 且探针证据龄 ≤ `retire.cycle_days` 且 **`last_observation == 'healthy'`**（旧账无该字段时回退 `observed_error_runs == 0`） |
| 拍6 回写 | `recurrence ≥ 1` + `last_verified_at` 刷新 + 正文有对质段 + `swept_hits > 0` | probe 账已被 `--sweep` 结清：`swept_probes > 0` 且 `pending_probes == 0`（**不要求**动条目正文 —— probe 就不写正文） |

⚠ **拍6 必须与拍5 同时改**：拍6 依赖 `swept_hits > 0`，而它从 `pending_hits` 派生、`pending_hits` 只在 wild 命中时递增。
只把拍5 放宽到接受 probe 而不改拍6，probe-only 的链会从「拍5 红」变成「拍6 红」，整条链照样红 —— 改动等于完全无效。
探针有效期与退役周期**同源**（`retireCycleDays`，单一出处）：「守卫多久算长期不响」与「探针证据多久算数」是同一把尺子。

---

## 附录 · 绑定示例（示例，随项目替换）

> 以下是**某仓实例**的绑定事实，仅示范「协议通用、绑定在配置」如何落地；
> 换项目时全部按该项目自己的路径/工具替换，不得照抄。

- 实例配置：仓库根 `.self-improving.yaml`；registry 实例：`.self-improving/registry.yaml`。
- 条目语料：`.learnings/`（git-tracked）；事件/提案暂存：`.learnings-work/`（本地 gitignored，
  由 `.git/info/exclude` 排除）。
- scope 枚举与该仓 `.learnings/index.md` 既有主题分组同构（infra/testing/git/data-ui/model/kb/other），
  default=other 永不自动注入。
- 命名门禁实例：`scripts/gates/D6-learnings-naming.sh`（`LRN|ERR|FEAT-YYYYMMDD-NNN` 前缀强制，
  fixtures 目录不在其扫描面内）。
- 条目-守卫绑定门禁实例：条目门禁 G2（resolved 必须有 guard_ref 且存在）。
- 宿主钩子同构对象：`scripts/guards/pre-commit.mjs` 的 GUARDS 数组（key/args/when 三键来源）。
