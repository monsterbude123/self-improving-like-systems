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
| 正常（injection 开 + 有命中） | 注入块 + 近期触发事件小节 | 0 |
| 无命中 / `hook.default_scopes` 为空 | 空（零噪音） | 0 |
| `kill_switch.injection=false` | 空（零副作用） | 0 |
| 超字符预算（`budget_chars`） | 标题行列表（inject.mjs 的既有降级） | 0 |
| 超时间预算（`budget_ms`） | 仅标题行 + 审计 `time-degraded` | 0 |
| 配置损坏 / 条目不可读 | 空 + 审计 `fail-open`（**绝不阻塞会话**） | 0 |
| 参数用法错误 | 空 | 2 |

`timeoutMs`（钩子外层）必须 ≥ `config.injection.timeout_ms` 且 ≫ `budget_ms`：注入计算本身
在 `budget_ms` 内出结果或降级，外层留足 node 启动余量。量级断言在 `tests/hook.test.mjs`。

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
