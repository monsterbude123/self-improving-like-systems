# self-improving-like-systems

通用**经验 / 自进化系统**协议层：让编码助手把自己的踩坑、纠正、失效模式沉淀成可检索、可退役、
可被门禁强制执行的知识，并按项目隔离。

**协议通用，绑定在各仓。** 本仓只有协议与判据，不含任何项目路径、项目数据或某个业务仓的词。

---

## 边界：协议层 vs 接入项目

这是本仓最核心的一条设计，也是它能被多个项目共用而不互相渗透的原因。

| | 属于本仓（协议） | 属于接入项目（绑定） |
|---|---|---|
| 内容 | 四实体契约、校验器、注入/捕获/蒸馏/退役生命周期、接线脚手架 | 条目正文、事件库、守卫注册表、实例参数 |
| 谁维护 | 协议改动走本仓 review，一处生效 | 各项目自管，**不随协议改动而变** |
| 零副作用 | 默认全关：`kill_switch` 三开关默认 `false`、`default_scopes` 为空数组 | —— |

四实体：

- **Entry** —— 一条经验，带可证伪 claim、scope、守卫绑定、状态与复发计数
- **Event** —— 一次失效观测（门禁拦截 / 工具失败 / 手动捕获），按指纹聚合
- **Guard** —— 可执行判据，由条目绑定；前几次 shadow 只告警，全绿才升为阻断
- **Promotion** —— 蒸馏与批准落盘的通道（草案只落暂存区，正式区零写入）

## 安装

**在本项目里**（推荐 —— 接入方已配好安装器）：

```bash
npm run si:install
```

它负责 clone / 更新协议层并跑一次自检。协议层目录不存在时会明确报错，不会静默跳过。

**直接装**（宿主技能发现走这条）：

```bash
git clone https://github.com/monsterbude123/self-improving-like-systems.git \
  ~/.agents/skills/self-improving-like-systems
```

装到 `~/.agents/skills/` 下，宿主会自动发现；目录名与 skill 名一致，无需重命名或映射。

**免安装试用**（npm 通道，见下文「两条通道，一份内容」）：

```bash
npx self-improving-like-systems init --project-dir . --apply
npx self-improving-like-systems self-test
```

> 不要用宿主的 skill 安装器分发本仓：它的降级路径只复制 `SKILL.md`，
> 会丢掉 19 个脚本 —— skill 加载得起来，而每处 `node xxx.mjs` 都是死路径。

### 分发来源不写本地路径

本仓的读者是别人，因此**任何一份文档里的安装来源都指向 GitHub 或 npm**，
不得出现指向某台机器的磁盘路径 —— 那种路径在接盘者自己的机器上必然失败，
而排查成本全落在他们身上。

`tests/no-local-path.test.mjs` 盯着这条：往 `README.md` / `SKILL.md` / `AGENTS.md` /
`references/**` / `scripts/**` 里写进「盘符 + 工作区目录」或「盘符 + 真实用户名」的
绝对路径会被当场拦下（判据形态写在守卫的注释里，这里不复述 —— 复述会把守卫自己要拦的
字面量写进扫描面）。`tests/` 下的合成夹具按设计不在扫描面内 —— 它们长得像真路径正是其作用。

### 两条通道，一份内容

本仓有**两条**分发通道。它们发的是**同一份内容** —— 同一 tag 发布，不是两条各自漂移的线。

| 通道 | 装到哪 | 适合谁 | 怎么更新 |
|---|---|---|---|
| **GitHub clone** | `~/.agents/skills/self-improving-like-systems` | 宿主技能发现（宿主按 `~/.agents/skills/<name>/` 找技能） | `git pull` |
| **npm / npx** | npm 全局目录 / 临时目录 | 免安装试用、按项目调用 | `npm i -g`（**无 git 历史**） |

**GitHub clone**（宿主技能发现走这条）：

```bash
git clone https://github.com/monsterbude123/self-improving-like-systems.git \
  ~/.agents/skills/self-improving-like-systems
```

**npm / npx**（免安装试用走这条）：

```bash
npx self-improving-like-systems init --project-dir . --apply   # 在项目里铺一份最小可用实例
npx self-improving-like-systems self-test                       # 跑全套判据
npm i -g self-improving-like-systems                            # 装到全局（当命令用）
```

npm 包是**纯分发器**：`bin/self-improving.mjs` 只把子命令转发到既有 `scripts/*.mjs`，
零业务逻辑（第二份逻辑 = 第二个事实源）。npm 包**不设 `postinstall`** ——
装到 `~/.agents/skills/` 这类改家目录的动作必须显式调用，不该在别人机器上静默发生。

#### 两条通道不共存

同一台机器上，`~/.agents/skills/self-improving-like-systems` **只能是其中一种**。
两处都装会出现「宿主加载的是 clone 副本、命令行跑的是 npm 副本」——
两者内容可能已分叉，而**没有任何东西会报错**。

npm 副本**没有 git 历史**，**不要 `git pull`**（那不是仓库）。更新走 `npm i -g`；
clone 副本才走 `git pull`。

#### 「同一份内容」怎么保证

npm 包**从 git tag 发布**。发布前断言 `git describe --tags` 与 `package.json` 的
`version` **必须相等**，由 `prepublishOnly` 自动触发（`scripts/check-release.mjs`）——
不一致就**发布失败**，而不是发布出两个各说各话的版本。

npm 的首个版本一旦发布即**不可改**（同版本号不可重发），所以发布前必须跑完全量判据。

#### 为什么现在有 npm 了（2026-10-21 修订）

此前本节写的是「为什么不开 npm 包」，理由是「两条路会各自漂移」。
那条理由**成立**，但解法不是「不开」，而是**让两条路无法漂移**：
同 tag 发布 + 发布前硬断言 + 文档写清「哪条装在哪、怎么更新、不能共存」。
一个不给别人试用入口的协议层，接入成本全落在接盘者身上 —— 那是比漂移更贵的代价。

`tests/no-local-path.test.mjs` 盯的始终是**本地路径**（与 npm 无关），
「不泄露某台机器的盘符」这条没变。

## 自检

```bash
node ~/.agents/skills/self-improving-like-systems/scripts/run-tests.mjs
```

在哪个目录跑都一样 —— 它按自身位置找 `tests/`，不按 cwd。
判据条数以这条命令的输出为准（本文档**不**复述一个会过期的数字：手写的计数本身就是判据的第二份，
每次增删用例都会悄悄过期，而过期的绿灯比没有数字更糟）。零外部依赖（无 `node_modules`，无包管理器）。

> 自己接了协议层的项目，`package.json` 里指向这个脚本而不是指向协议层里的某个路径：
> npm 脚本失败常被 CI 当成「不稳定」跳过，于是**静默失去全部回归保护**。

## 接一个项目

**一条命令**（2026-10-21 起；此前要手工 7 步，装得上 ≠ 接得上）：

```bash
npx self-improving-like-systems install --project-dir .          # 先看它打算落什么，零写盘
npx self-improving-like-systems install --project-dir . --apply  # 确认后再落
```

它一次做完：

| 落什么 | 去哪 | 为什么 |
|---|---|---|
| 实例配置 + 注册表 | `.self-improving.yaml`、`.self-improving/registry.yaml` | 协议形状的单一权威 |
| **项目侧薄壳** | `scripts/self-improving.mjs` | 宿主钩子的入口 + 项目侧「层可用性感知」的载体 |
| **指针** | `.agents/skills/self-improving/SKILL.md` | 别的 agent 检索「经验系统」时**唯一会读到**的地方 |
| **宿主钩子接线** | `.zcode/config.json` | 5 个事件（SessionStart / PostToolUse / PostToolUseFailure / UserPromptSubmit / Stop） |
| 运行期目录 | `.gitignore` | 漏了的话每次跑完 `git status` 就不干净 |
| npm 脚本 | `package.json` | `si:doctor` / `si:install` / `si:gate` / `si:self-test` |

已存在的文件**一律不动**（人改过的 scope、路径、清单脚本原样保留），所以可以放心重复跑。
清单文件只在「JSON 往返不变形」时才改 —— 重排格式会制造整份清单的噪音，那种 diff 会让人开始绕开这个工具。

落完还剩两件要人做：

1. 填 `scope.values`（文件里有 TODO 标记；不填也能跑，fail-safe 桶永不自动注入）
2. 逐条打开 `kill_switch` —— **开关必须先于它防的风险存在**

### 接入后项目侧怎么用

```bash
npm run si:doctor      # 层装没装好？层没装时它给**可操作的安装提示**，不让人猜
npm run si:self-test   # 跑协议层全套判据
npm run si:gate        # 门禁（可挂 pre-commit）
```

钩子接线写的是 `node "${ZCODE_PROJECT_DIR}/scripts/self-improving.mjs" <子命令>` ——
配置里**只有项目相对路径**（可移植、不含任何机器盘符），运行期由薄壳去层里找真脚本
（正确：层装在 clone 通道还是 npm 通道、挪了位置，都照样跑）。

### 分层：项目只读协议层

- **协议层对项目是只读的**：层目录不被项目写任何东西（实测：跑完 init / 接线 / 捕获，已装层仍是 clean）。
- **项目侧只留薄壳**：`scripts/self-improving.mjs` 是入口，协议正文与判据都在仓外的层里 ——
  仓内留副本等于两份事实源（改了一份忘了另一份，门禁判的和提交里跑的就悄悄分叉）。
- **项目侧只管产生信号，协议层的维护 agent 负责消费信号**：
  `npx self-improving-like-systems collect-logs --project-dir . --apply`
  把运行期事件 / 审计 / 守卫态采到 `~/.agents/self-improving-like-systems/collect/<项目>/`，
  维护 agent 在那里读，用于协议层自己的规则与技能升级。只采运行期数据，**不采条目正文**。

## 目录

| 路径 | 角色 |
|---|---|
| `SKILL.md` | 触发条件、禁令、目录索引（宿主读的就是它） |
| `references/schema.md` | 四实体契约全文 |
| `references/stoploss.md` | 止损冻结 / 恢复程序 |
| `references/hook-wiring*.json` | 接线片段的权威形态（`<SKILL_DIR>` 占位符） |
| `scripts/validate.mjs` | 校验器 CLI（条目 / 配置 / 注册表 / 绑定） |
| `scripts/init.mjs` | 接入脚手架：派生实例配置 + 落实目录分层 + 落项目侧薄壳 |
| `scripts/install-project.mjs` | **一条命令接入一个项目**（配置 + 薄壳 + 指针 + 钩子 + gitignore + 清单） |
| `scripts/lib/layer-resolve.mjs` / `layer-gate.mjs` | 层在哪 / 层装没装好 / 指针写没写全两条通道 —— 单一权威 |
| `scripts/project-side/self-improving.mjs` | 项目侧薄壳模板（复制进项目：doctor / install / self-test / gate / collect-logs） |
| `scripts/collect-logs.mjs` | 把项目运行期信号采到用户目录，供协议层维护 agent 分析 |
| `scripts/run-tests.mjs` | 全套判据的唯一入口（cwd 无关；找不到 `tests/` 即 exit 2） |
| `scripts/*.mjs` | 注入、捕获、蒸馏、批准、守卫派发、生命周期收口、运维对账、接线体检 |
| `tests/` | `node:test` 套件，含破坏测试与可移植性守卫 |

## 几条硬纪律

- **判据只此一份**：任何新增校验必须 import `scripts/validate.mjs` 的导出，不许另写同义判据。
- **可复现性靠破坏测试**：只测合规样本的测试在判据退化时同样会通过。破坏测试不会失败的，直接删。
- **fail-closed 优于静默兼容**：配置版本对不上即硬失败，不按新协议解释旧配置。
- **位置无关**：协议层放在哪都能跑全量测试。`tests/portability.test.mjs` 盯着这条，
  任何「上溯若干级即仓库根」式的假设写进 `tests/` 都会当场变红。
- **不静默丢覆盖**：找不到被测对象时判红，不判跳过 ——「跳过，不计为通过」是绿灯下的空洞。

## 许可

随项目约定。
