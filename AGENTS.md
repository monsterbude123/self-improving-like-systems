# AGENTS.md —— 协议层自述（怎么维护这个仓）

> 本文件回答**「这个仓是什么、我该怎么改它、改完怎么验、怎么发版」**。
> 协议正文（四实体契约、生命周期、接线形态）一律**不在这里** —— 那是 `references/schema.md`
> 与 `references/stoploss.md` 的正文，本文件只留指针行。**单一归宿**（一条规则只有一个正文权威位置）
> 是本仓最硬的一条纪律；把它抄第二份，两份必然漂移。

## 0. 一句话

这是**协议层**独立仓：让编码助手把踩坑 / 纠正 / 失效模式沉淀成可检索、可退役、可被门禁强制执行的知识。
它**只含协议与判据**，不含任何接入项目的条目正文、路径或数据。

- 协议正文 → `references/schema.md`（四实体契约）、`references/stoploss.md`（止损程序）
- 宿主读到的技能说明 → `SKILL.md`
- 对外介绍与安装 → `README.md`
- **本文件 = 维护者手册**（怎么改、怎么验、怎么发）

## 1. 判据从哪跑

```bash
node scripts/run-tests.mjs
```

`scripts/run-tests.mjs` 是**全套判据的唯一入口**：
按自身位置（`import.meta.url`）定位 `tests/`，**不按 cwd** —— 在任何目录跑都同结果。
找不到 `tests/` 即 **exit 2**，绝不静默通过（一个永远 exit 0 的自检比没有自检更坏）。

零外部依赖：无 `node_modules`、无包管理器，`node` 直接跑。

## 2. 协议改动的红线

1. **零项目耦合** —— 协议里**不得出现任何项目名词、项目路径、项目数据**。
   `tests/approve.test.mjs` 的全目录扫描盯着这条。协议通用、绑定在各仓。
2. **判据只此一份** —— 新增校验必须 `import scripts/validate.mjs` 的导出，
   **不许另写同义判据**。写第二份 = 造第二个事实源。
3. **可复现性靠破坏测试** —— 只测合规样本的测试在判据退化时同样会通过。
   破坏测试必须**双向验红**：去掉修复要变红，改成别的名字也要变红。
   不会失败的测试直接删。
4. **不静默丢覆盖** —— 找不到被测对象时**判红，不判跳过**。
   「跳过，不计为通过」是绿灯下的空洞。
5. **fail-closed 优于静默兼容** —— 配置版本对不上即硬失败，不按新协议解释旧配置。
6. **位置无关** —— 协议层放在哪都能跑全量测试。`tests/portability.test.mjs` 盯着这条。
7. **改动形态：一次算清再一次写入** —— 算「加哪几条、删哪几条、净增减多少」，
   然后一次写入，最后核一次。**禁止「改一行 → 读 → 改一行 → 读」的散装循环**。
8. **文档不许含机器本地绝对路径** —— 读者是别人，写死某台机器的盘符在他们机器上必然失败。

## 3. 仓库结构（单一归宿）

| 路径 | 角色 | 谁维护 |
|---|---|---|
| `SKILL.md` | 触发条件、禁令、目录索引（宿主读的就是它） | 本仓 |
| `references/schema.md` | 四实体契约全文 | 本仓 |
| `references/stoploss.md` | 止损冻结 / 恢复程序 | 本仓 |
| `references/hook-wiring*.json` | 接线片段的权威形态 | 本仓 |
| `scripts/validate.mjs` | 校验器 CLI（条目 / 配置 / 注册表 / 绑定） | 本仓 |
| `scripts/init.mjs` | 接入脚手架（派生实例配置 + 落实目录分层 + 落项目侧薄壳） | 本仓 |
| `scripts/install-project.mjs` | **一条命令接入一个项目**（配置 + 薄壳 + 指针 + 钩子 + gitignore + 清单） | 本仓 |
| `scripts/lib/layer-resolve.mjs` / `scripts/lib/layer-gate.mjs` | 层在哪 / 层装没装好 / 指针写没写全两条通道 —— 单一权威 | 本仓 |
| `scripts/project-side/self-improving.mjs` | 项目侧薄壳模板（复制进项目：doctor / install / self-test / gate / collect-logs） | 本仓 |
| `scripts/collect-logs.mjs` | 把项目运行期信号采到用户目录，供本仓的维护 agent 分析升级 | 本仓 |
| `scripts/run-tests.mjs` | 全套判据的唯一入口 | 本仓 |
| `scripts/*.mjs` | 注入 / 捕获 / 蒸馏 / 批准 / 守卫派发 / 生命周期收口 / 运维对账 / 接线体检 | 本仓 |
| `tests/` | `node:test` 套件（含破坏测试与可移植性守卫） | 本仓 |

**协议正文只在这里。** 接入项目的文档只允许写**一行指针**（仓地址 + 怎么装），
不复述协议 —— 复述即第二份事实源，日后必然漂移。

**接入一个项目的标准动作 = 一条命令**（2026-10-21 立）：

```bash
npx self-improving-like-systems install --project-dir . --apply
```

它一次做完实例配置、项目侧薄壳、指针、宿主钩子接线、运行期目录进 `.gitignore`、清单里的 npm 脚本。
**装得上 ≠ 接得上，接上 ≠ 接对** —— 所以「接入」必须是**一条命令**，
而不是「人记得住的几步」（实测此前要手工 7 步，且 `init` 会把本机绝对路径写进新项目的清单）。
接入项目侧只留薄壳：`scripts/self-improving.mjs` 是入口与「层可用性感知」的载体，
**协议层对项目只读**，项目侧只管产生信号、由本仓的维护 agent 消费信号
（`collect-logs` 采到 `~/.agents/self-improving-like-systems/collect/<项目>/`）。

## 4. 两条分发通道（同一份内容）

| 通道 | 装到哪 | 用途 | 怎么更新 |
|---|---|---|---|
| **GitHub clone** | `~/.agents/skills/self-improving-like-systems` | 宿主技能发现（宿主按 `~/.agents/skills/<name>/` 发现技能） | `git pull` |
| **npm / npx** | npm 全局目录 / 临时目录 | 免安装试用、按项目调用 | `npm i -g`（**无 git 历史**） |

- GitHub 仓库地址：<https://github.com/monsterbude123/self-improving-like-systems>
- npm 包名：`self-improving-like-systems`
  （`npx self-improving-like-systems init --project-dir .` 即可在项目里铺一份最小可用实例）

**两条通道不共存**：同一台机器上 `~/.agents/skills/self-improving-like-systems`
只能是其中一种。npm 副本**没有 git 历史**，**不要 `git pull`**。

npm 包是**纯分发器**：`bin/self-improving.mjs` 只把子命令转发到既有 `scripts/*.mjs`，
**零业务逻辑**（第二份逻辑 = 第二个事实源）。npm 包**不设 `postinstall`** ——
装到 `~/.agents/skills/` 这类改家目录的动作必须显式调用，不能在别人机器上静默发生。

## 5. 发版流程

npm 包**从 git tag 发布**，GitHub 与 npm **同 tag 发布 ⇒ 同一份内容**。

1. 改完 → `node scripts/run-tests.mjs` 全绿（**发布前必须跑**）
2. `git tag v<version>` + `git push --tags`（`version` = `package.json` 的 `version`）
3. **断言一致**：`git describe --tags` 与 `package.json` 的 `version` 必须相同。
   **不同就停** —— 不得改 version 去迁就 tag，也不得带着不一致发布：
   那会让 npm 上的版本与 git 里的 tag 各说各话，正是「两条通道发的是同一份内容」要防的事。
4. `npm publish`（`publishConfig.access = "public"`，零依赖）
5. 首个版本一旦发布即**不可改**（npm 规则：同版本号不可重发）——
   出错只能 `npm deprecate` 并发补丁版本。所以第 1、3 步的红线是硬的。

## 6. 绝对禁止

- ❌ **禁止把本仓内容反向拷回接入项目仓** —— 那是双向漂移源。
  协议→项目只能是「clone / 引用」这一条单向链路。
- ❌ **禁止在本机绝对路径写进分发面**（文档、脚本、示例）。
  `tests/no-local-path.test.mjs` 盯着这条。
- ❌ **禁止把判据降级成散文** —— 判据必须可执行、可复现、能变红。
  「文档里说了」不等于「机器挡住了」。
- ❌ **禁止在 `bin/` 或新脚本里复制协议逻辑** —— 只能 import 既有实现。
- ❌ **禁止引入第三方依赖** —— 本仓零依赖是硬约束（宿主无 `node_modules` 也要能跑）。

## 7. 自查（改完必做）

```bash
node scripts/run-tests.mjs        # 全量判据，cwd 无关
node --test tests/self-description.test.mjs   # 本文件的关键事实有没有被删掉
```

第二条守的是**本文件自身**：把上面的判据入口命令、GitHub 地址、npm 包名、
零耦合禁令、发版流程任意一条删掉或换个名字，它当场变红 ——
「维护者手册」不会因为一次顺手编辑而悄悄失效。
