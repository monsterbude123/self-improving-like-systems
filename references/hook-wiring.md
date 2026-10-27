# 生命周期接线 · SessionStart 预加载（票 07）

> 片段权威 = `hook-wiring.json`（测试直接执行它，形态与文案不在两处漂移）；
> 引擎 = `../scripts/hook-session-start.mjs`（宿主可跑、零外部依赖、YAML 双后端）。
>
> **接线状态以各仓 `.zcode/config.json` 实况为准**（该文件机器本地、被 exclude、不入库，故不入文档）。
> 本仓工作树现状（票 H2 核实）：**SessionStart → `hook-session-start.mjs` 已接线**（`enabled: true`，
> 指向 worktree 绝对路径）；`hook-wiring-capture.json`（PostToolUseFailure）与
> `hook-wiring-distill.json`（Stop）两个片段**仍未接线**。
> ⚠️ worktree 绝对路径随检出位置变化，合入主仓时须改回仓内路径，否则换机器即断。

## 接什么

在**项目根 `.zcode/config.json`** 的 `hooks.events` 下**追加** `hook-wiring.json` 里的
`SessionStart` 段（`<SKILL_DIR>` 换成本技能目录绝对路径）。同层已有条目（宿主会话规则管道等）
**一律不动** —— 只增不改，`tests/hook.test.mjs` 以「片段只含 SessionStart、不含其他事件键」
的断言守这条。

```jsonc
{
  "hooks": {
    "enabled": true,
    "events": {
      "UserPromptSubmit": [ /* 原有条目：原样保留 */ ],
      "SessionStart": [ /* 追加本片段 */ ]
    }
  }
}
```

## 域（scope）从哪来

SessionStart 时还没有用户 prompt，域无从推断。取值优先级：`--scopes` 参数 >
`config.hook.default_scopes` > 空（零注入）。**取舍：宁可漏注入也不噪音** —— 漏掉的域还有
prompt 侧的注入点兜底，而噪音是不可逆的上下文预算损耗。模板默认 `[]`（不注入），
项目按自己的语料主题分组填（本仓实例填 `infra,testing`）。

## 行为与降级

| 情形 | stdout | 退出码 |
|---|---|---|
| 正常（injection 开 + 有命中） | 注入块 + 近期触发事件小节 + 守卫健康度小节（有守卫债才有） | 0 |
| 无命中 / `hook.default_scopes` 为空 | 空（零噪音）—— **有守卫债时例外**：仍给「守卫健康度」小节（它与域无关） | 0 |
| `kill_switch.injection=false` | 空（零副作用） | 0 |
| 超字符预算（`budget_chars`） | 标题行列表（inject.mjs 的既有降级） | 0 |
| 超时间预算（`budget_ms`） | 仅标题行 + 审计 `time-degraded` | 0 |
| 配置损坏 / 条目不可读 | 注入块为空 + 审计 `fail-open`（**绝不阻塞会话**）；守卫债小节若有仍给 | 0 |
| 参数用法错误 | 空 | 2 |

`timeoutMs`（钩子外层）必须 ≥ `config.injection.timeout_ms` 且 ≫ `budget_ms`：注入计算本身
在 `budget_ms` 内出结果或降级，外层留足 node 启动余量。量级断言在 `tests/hook.test.mjs`。

## 守卫健康度小节（守卫债的可见性出口）

守卫自己报错时按设计 **fail-open**（放行、不阻塞提交）—— 这条纪律不动。
但缺了观测它就退化成「静默失效」：接入项目的 pre-commit 把层的输出收进每守卫日志文件、
成功时不回显，于是「判据根本没在跑」可以累计几十次而全程零报错。

故 SessionStart 追加一节 `## 守卫健康度`：

- **当前报错**（末次 `last_result === 'error'`）排最前，连挂 ≥ 3 次的标「连续 error N 次」，
  并附最近一次的错误详情；
- **已恢复**（末次不是 error 但历史上报过错）随后，按累计次数降序，标「已恢复」；
- 行数与字符都有上限（上下文预算是硬的），超出的只给条数；
- **零债 = 零噪音**：没有守卫债就完全不输出这一节。

### 三条不可省的性质

1. **与注入路径解耦**：它读的是**守卫状态账**，不是条目库 —— 「无可注入域」「条目目录缺失」
   「注入超时降级」都不该把它一起吞掉。模板默认 `hook.default_scopes` 为空，
   若把它挂在注入块后面，接进来的项目默认就看不到它 —— 而「会话开头看得见」正是这个出口的理由。
   （`kill_switch.injection=false` 仍然零输出：那是项目显式关掉「往上下文里注入」的决定。）
2. **读不到账 ≠ 零债**：状态账损坏或读不动时，stderr 必须告警（`守卫状态账读不动`），
   不许静默说「一切正常」—— 静默的「零债」等于把「看不见」换了个说法。
3. **预算**：小节吃注入块之外剩下的 `budget_chars`；连标题都放不下时退成一行紧凑摘要
   （条数还在），而不是硬塞一整节把上下文预算撑爆。

判定与渲染复用 `scripts/run-guard.mjs` 的 `collectDebtGuards` / `readDebtGuards` /
`renderDebtSection`（与 `run-guard` 派发末尾的汇总行同源，判据只有一份）。同一份账的另一个出口是
`run-guard` 派发输出末尾的一行汇总。**两者都只提升可见性，不改变放行行为** ——
汇总自己兜住所有异常，绝不让它把一次真实的阻断裁决（exit 2）降级成放行（exit 0）。
判据与出口的验收在 `tests/guard-debt.test.mjs`。

## 蒸馏触发面（票 09 · 片段权威 = `hook-wiring-distill.json`）

**宿主 ZCode 没有 `SessionEnd` 事件**（支持事件恰好七个：`SessionStart` / `UserPromptSubmit` /
`PreToolUse` / `PermissionRequest` / `PostToolUse` / `PostToolUseFailure` / `Stop`；`Notification` /
`SubagentStop` / `PreCompact` 不支持）。蒸馏是「会话收尾」动作，故降级挂 **`Stop`**（每个助手回合结束），
并且**只出片段、本票不接线** —— 是否把每回合触发的蒸馏接进 `.zcode/config.json` 由人工裁决。

降级代价与兜底：`Stop` 每回合都触发（比会话收尾频繁），代价由两条既有不变量吸收 ——
① 蒸馏**幂等**（文件名含事件集指纹、内容逐字节相同则 `unchanged` 不重写）；
② `kill_switch.distill=false` 时**零写盘零提案**。任一生效，该接线都是零成本。

## 验收

`node tests/hook.test.mjs`（零依赖，宿主直跑）。其中「接线命令级」用例用 `${ZCODE_PROJECT_DIR}`
指向临时项目目录、以 env `SELF_IMPROVING_CONFIG` 指定临时配置（开态），
**不改实例配置的 kill-switch 默认值**。蒸馏片段的同款验收在 `node tests/distill.test.mjs`。

## 2026-10-18 补：接线「看起来全对但事件零落库」的定位手册

**形态**：`.zcode/config.json` 五条钩子齐全、`hooks.loadHooks OK`、脚本手工跑正常、
事件在触发（rollout 里能数到 `PostToolUseFailure` 出现 7799 次）——**但事件库零新增**。
本仓 `PostToolUseFailure` 整整一轮（4 次真实失败：门禁 abort ×3、hook 提交消息被吞）全部没进账。

**为什么必须单列一节**：这是「看起来有防护但从没生效」的加强版 —— 前面那些至少还有
「没接线」这种可查痕迹，这次是**每一项单看都正常，组合起来失效**。
按 ERR-20261018-001 的判据（查不到 ≠ 不存在，反过来同样成立）：
**全部检查项绿灯，不构成「接线有效」的证据。**

### 四个静态坑（`hook-install.mjs --doctor` 全部能查出）

| 坑 | 症状 | 为什么静默 |
|---|---|---|
| `hooks.enabled` 未置 `true` | 所有配置钩子都不跑 | 只在「恰有插件贡献钩子」时自动启用，否则静默跳过 |
| 事件名不在七个之内 | 该钩子永不触发 | 宿主直接忽略，无报错 |
| 字段与 `type` 错配（process 带 `timeout` / command 带 `args`） | 钩子被整个丢弃 | 同上 |
| `command` 的 `timeout` 单位是**秒**、`process` 的 `timeoutMs` 是**毫秒** | 秒当毫秒传 → 秒级超时 | 表现为「跑一半被杀」 |

### 查不出的那个（只能靠探针）

宿主**运行时**不把事件载荷喂给脚本（`--text -` 拿到空 stdin）——这在配置层完全看不出来。
三种解释修法完全相反，所以必须能区分：

| 探针留痕 | 结论 | 修法 |
|---|---|---|
| 连 `invoked` 都没有 | 钩子没被调起 | 查事件名 / matcher / 配置有没有被读到 |
| 有 `invoked`、无 `stdin` | 宿主没投递载荷 | 改钩子类型（`process` 走 argv、`command` 走 shell 管道，投递路径不同） |
| 有 `stdin`、事件库无新增 | 脚本侧问题 | 查参数解析 / kill-switch / 写盘 |

用法（失败事件那条钩子建议**长期挂着**，零副作用）：

```bash
node capture.mjs --source tool --kind tool_error --text - --no-block \
     --diag .learnings-work/hook-probe.log
```

⚠️ **配置改动下个会话才生效**（钩子在会话启动时读一次），本会话验证不了 ——
这是排查时最容易误判成「改了也没用」的一点。

### 一句话纪律

`--doctor` 通过 **≠** 事件已落库。两件事都要做：先 `--doctor` 排静态坑，
再看探针三段留痕确认运行期。只做前者，就会重演本次这轮排查。
