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

**直接装**：

```bash
git clone https://github.com/monsterbude123/self-improving-like-systems.git \
  ~/.agents/skills/self-improving-like-systems
```

装到 `~/.agents/skills/` 下，宿主会自动发现；目录名与 skill 名一致，无需重命名或映射。

> 不要用宿主的 skill 安装器分发本仓：它的降级路径只复制 `SKILL.md`，
> 会丢掉 19 个脚本 —— skill 加载得起来，而每处 `node xxx.mjs` 都是死路径。

### 分发来源只有一条

本仓的读者是别人，因此**任何一份文档里的安装来源都指向 GitHub**，
不得出现指向某台机器的磁盘路径 —— 那种路径在接盘者自己的机器上必然失败，
而排查成本全落在他们身上。

`tests/no-local-path.test.mjs` 盯着这条：往 `README.md` / `SKILL.md` / `references/**` /
`scripts/**` 里写进「盘符 + 工作区目录」或「盘符 + 真实用户名」的绝对路径会被当场拦下
（判据形态写在守卫的注释里，这里不复述 —— 复述会把守卫自己要拦的字面量写进扫描面）。
`tests/` 下的合成夹具按设计不在扫描面内 —— 它们长得像真路径正是其作用。

### 为什么不开 npm 包

本仓是零第三方依赖的纯 `.mjs` + markdown：没有 `node_modules`、没有 `package.json`、
自检零依赖跑全。发 npm 包解决不了任何实际问题，引入的却是一条要长期维护的分发通道
（版本策略 / 弃用流程 / 发布权限），收益与成本不成比例。

更要紧的是它与「单一来源」直接冲突：一旦有了 npm，`git clone` 与 `npm i` 两条路
就会各自漂移，而本仓的协议判据要求全网只有一份。

**判断留档于 `tests/no-local-path.test.mjs` 的注释**，避免日后有人「顺手补一个 npm」。

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

```bash
node <协议层>/scripts/init.mjs --project-dir <项目目录>          # 先看它打算落什么，零写盘
node <协议层>/scripts/init.mjs --project-dir <项目目录> --apply   # 确认后再落
```

它落两份文件（仓根 `.self-improving.yaml` + `.self-improving/registry.yaml`），
已存在的文件一律不动，所以可以放心重复跑。落完还剩三件要人做：

1. 把 `.self-improving-work/` 加进 `.gitignore` 或 `.git/info/exclude`
   —— 运行时数据都在这里，漏了的话每次跑完 `git status` 就不干净
2. 填 `scope.values`（文件里有 TODO 标记；不填也能跑，fail-safe 桶永不自动注入）
3. 接线体检：`node <协议层>/scripts/hook-install.mjs --doctor --project-dir <项目目录>`

最后逐条打开 `kill_switch` —— **开关必须先于它防的风险存在**。

## 目录

| 路径 | 角色 |
|---|---|
| `SKILL.md` | 触发条件、禁令、目录索引（宿主读的就是它） |
| `references/schema.md` | 四实体契约全文 |
| `references/stoploss.md` | 止损冻结 / 恢复程序 |
| `references/hook-wiring*.json` | 接线片段的权威形态（`<SKILL_DIR>` 占位符） |
| `scripts/validate.mjs` | 校验器 CLI（条目 / 配置 / 注册表 / 绑定） |
| `scripts/init.mjs` | 接入脚手架：派生实例配置 + 落实目录分层 |
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
