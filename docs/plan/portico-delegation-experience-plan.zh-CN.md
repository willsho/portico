# Portico 委派体验改进计划（向内置 subagent 看齐）

来源：一次「Portico 委派 vs 调用内置 subagent」的对比复盘。结论是——内置 subagent **暖**在
「在我自己的上下文里写 prompt、结果内联返回、失败便宜、活动部件少」；Portico **冷**在「结果要去读盘
且不能信 agent 自述、运维面大、冷启动 task 贵、失败贵」。但这些「差」大多是**编排不成熟的附带成本**，
不是「委派一个外部异构 agent」的本质成本。

**目标**：把附带成本逐条磨平，让 Portico 的默认体验接近「spawn 一个 subagent」，
**同时不放弃它的本质价值**——隔离的、可审查、带测试门禁的 patch；异构模型；持久可审计产物。

> 关联：[[portico-delegation-pain-points-plan.zh-CN]]（判读/正确性）、
> [[portico-partial-run-landing-plan.zh-CN]]（截断与 policy-failed 落地）。本计划是二者之上的
> **体验/人机工学**层，部分项承接或归并它们。内部 plan 文档，沿用 zh-CN-only 惯例。

## 一句话判断

体验的差，可拆成 5 笔**附带税**：① 结果不回上下文、要读盘且得防 agent 自述；② 运维面大
（daemon/端口/超时/worktree/policy/门禁）；③ 失败贵且不能中途纠偏；④ 冷启动 task 写起来贵；
⑤ CLI 表面不一致的 papercut。下面逐笔降到接近零。

## 差距 1（判读）：结果不回到上下文——每次都要「读盘」且不能信 agent 自述

### 现象

- 拿到 `run_done` 后，我**每次**都得去 `report.md` + `result.json` + `git -C worktree diff` 才真正知道结果。
- 流式/agent 日志不可信（mojibake、内部子代理闲聊、超时噪声），skill 自己要求看 `## Portico Observations`。
  「去外部读取并交叉验证」这层动作，内置 subagent（结果作为 tool result 内联返回）完全没有。

### 根因

- 没有「一次返回、机器可读、可信」的判读出口。`run_done` 只给 report 路径；可信结论散在 report 的
  `## Portico Observations` / `## Review`，机器要拿得分别 `status --json` / `review --json` / `--review-summary`。

### 计划

- **P0**✅：让 `run_done` 事件与 `status --json` **内嵌完整可信判读块**——changedFiles、diff stat、tests/verify tally、
  pathPolicy、sandboxEscaped、`reviewDecision`、`readiness`、top risks——**一次读取即可**，不必再开三个文件。
  本质是把现有 `--review-summary` 结构化，并默认随终态返回。已落地：`packages/orchestrator/src/verdict.ts`
  的 `buildRunVerdict()` 产出 `RunVerdict`（含 `readiness: ready|needs_attention|not_ready` 与 `topRisks`），
  挂在单 run 的 `run_done`/`run_error` 事件（`run_error` 同时补上了 `status`/`reportPath`/`resultPath`，此前几乎
  是空的）以及 `portico status --json`（默认与 `--summary`/`--fields` 两种形态）上；`--review-summary` 改为复用
  同一函数，不再重复计算。范围说明：group 级 `run_done`（fan-out 父 run）未挂 `verdict`——其形状与单 run 不同
  （无单一 pathPolicy/tests），仍用 `portico review <group_id>` 看聚合；daemon 原始 `GET /runs/:id` 也未挂
  `verdict`（那是 CLI 侧基于同一 `RunResult` 派生的呈现层），按 `docs/daemon-api.md` 的说明执行。
- **P1**✅：流式过程在终态前发一个结构化 `verdict` 事件（Portico 的结论，而非 agent narration）；follow/CLI 默认
  把 agent 日志折叠为「非权威」。让「跟一条 run」看到的是可信信号。已落地：单 run（非 group/child）在
  `diff_ready` 之后、测试开始之前，多发一个 `verdict_update` 事件（`packages/orchestrator/src/orchestrator.ts`），
  复用既有 `buildRunResult`/`attachReviewArtifacts`/`buildRunVerdict`，`readiness` 此时必为 `not_ready`（诚实的
  中途快照，不预测终态）；CLI 默认渲染（`delegate.ts` 的 `printEvent`，`logs`/`--follow` 复用同一函数）把
  `verdict_update` 渲染成明确的 Portico 行，并在每个 run 的首条 `agent_event` 内容前加一次性「agent narration
  (unverified, not Portico's verdict)」横幅，与结构化事件区分。范围说明：group/child run 不发 `verdict_update`，
  与 P0 的 group `run_done` 不挂 `verdict` 是同一个边界。
- **P1**✅：规范一个 `portico result <run_id> --json` 作为「这就是结果」的**唯一**机器入口（聚合 observations + readiness + 风险）。
  已落地：`packages/cli/src/commands/result.ts`，比 `status` 更窄——只输出 `{ id, status, role, verdict, next }`，
  不带 `status` 的 progress/raw artifacts 调试信息；复用从 `printReviewSummary` 抽出的 `getNextActionHint()`，
  group run 额外提示去 `portico review`。

## 差距 2（正确性 + 人机工学）：运维面太大——daemon/端口/超时不该进我的脑子

### 现象

- 默认端口 8787 没 daemon、实际在 8791 要手动 `--url`；120s 默认超时把真活砍在半路。**我成了流水线运维**。

### 根因

- `delegate` 默认**不**自动起 daemon（`--auto-start` 是 opt-in）。[#17] 已补 pidfile 发现 + agent/test 超时拆分 + idle watchdog，
  但默认行为仍要求我先 `portico start` 且常需显式 `--timeout`。

### 计划

- **P0**✅：**`delegate` 默认零配置**——无可达 daemon 时先 pidfile 发现（[#17]），否则自动起 loopback 并重试一次；
  即把 `--auto-start` 设为默认（loopback-only，LAN 仍须显式）。目标：一条 `delegate` 自洽，不需要我管 start/port。
  已落地：`delegate`/`delegate --resume` 的 auto-start 默认开启；新增 `--no-auto-start` 显式关闭（CI 等期望
  daemon 已存在的场景），`--auto-start` 保留为显式 no-op。loopback-only 的安全护栏（`isLoopbackHost` 拒绝
  LAN/远程 URL）未变。已做端到端烟雾验证：默认场景成功自动起 daemon 完成一次 delegate（用后即 `stop`/`discard`
  清理），`--no-auto-start` 在 ~0.2s 内快速失败、不产生 pidfile。
- **P0**✅：**默认超时即合理**（[#17] 已拆分 agent 900s / test 120s / idle 120s）——验证它就是开箱体验，我永不再写 `--timeout 1800000`。
  复核确认：`packages/daemon/src/routes.ts` 的 `handleDelegate` 已对 `timeoutMs`/`testTimeoutMs`/`idleTimeoutMs`
  做 `??=` 兜底，端到端生效；本轮未改动。
- **P1**✅：**<1s 预检健康门**——`delegate` 冷启动前对解析到的 daemon 做 health-check + 目标 agent 可用性检查，
  端口错 / agent 缺在烧掉冷启动前就拦下（复用 `portico doctor`）。已落地：`delegateCommand`
  在创建任何 worktree 之前，调用 `discoverAgents({ skipVersion: true })`（跳过慢的 `--version` 探测）
  本地检查 `--to`/`--compare-to`/每个 child 的 `to` 是否都可用，缺一个就直接失败、不起 worktree，
  不再等到 orchestrator 内部抛 `agent_unavailable` 才发现。范围说明：daemon 自身的可达性已由既有
  auto-start 重试覆盖，本项聚焦此前完全没有保护的「agent 缺失」一环。

## 差距 3（正确性）：失败贵、不能中途纠偏、部分产物难续

### 现象

- 一次 fanout 白跑 = N 个外部 agent 的时间；中途发现跑偏只能整组弃；被截断/越界的好产物难落地、难续。

### 根因

- 见 [[portico-partial-run-landing-plan.zh-CN]]：截断的部分运行被误读为 `ready`；policy-failed 的好 diff 无一等落地出口。
- 另：主动 `cancel` 是否保留半成品 diff 未保证——[#17] 的 salvage 覆盖 error/timeout/stall，`cancel` 路径需确认。

### 计划

- **P0**✅：**`cancel` 也 salvage**——主动叫停时同样抓 worktree diff，中途纠偏不等于全损。已落地：
  `orchestrator.ts` 新增 `cancelAndSalvage()`，替换原先「abort 后直接写一个不含 diff 的 result.json，
  靠和后台 catch 路径赛跑」的写法——改为 cancel 调用本身同步抓 diff、写出完整 `result.json`/`report.md`
  （复用既有 `buildRunResult`/`attachReviewArtifacts`），不再依赖与生成器 catch 块的时序竞争；单 run 与
  group 级联中的每个 child 走同一函数。`buildRunResult` 的 gate-warning 文案也按 `run.status` 区分
  「was cancelled」与「errored/timed out」。已加单测：mid-flight cancel 一个真实写文件后挂起的 agent，
  断言 `changedFiles`/`diffSummary`/`diff.patch`/`report.md` 均落地。
- **P0**：承接 [#18]——`apply --allow`（policy-failed 的好 diff 经确认落地，✅已完成）、`delegate --continue`
  （在部分产物上续跑，未开始），让「叫停 → 看半成品 → 接着做」成为**便宜回路**。已落地部分：
  `portico apply <run_id|group_id --child <id>> --allow <path>…`——见
  `packages/orchestrator/src/orchestrator.ts` 的 `resolvePathPolicyOverride()`：只在路径越界
  （`pathPolicy.status === "failed"` 且无 `forbidden` 命中）且 `--allow` 覆盖全部 `notAllowed`
  路径时放行，落地后在 `result.json` 写 `pathPolicyOverride` 留痕；`forbidden` 命中仍硬失败、不可
  override。详见 [[portico-partial-run-landing-plan.zh-CN]]。
- **P1**✅：**iterate 模板**——把「引用上一次 `report.md` / `test.log` 的失败要点、细化任务再委派」做成一条命令（预填失败摘要），
  逼近内置 subagent 的「便宜重试」。已落地：`delegate --iterate-from <run_id>`（`packages/cli/src/commands/delegate.ts`）
  确定性地把上一个 run 的 `topRisks`、每个失败 test/verify 的尾部输出、`changedFiles` 拼进新 task 的
  `## Context` 段（与 `--context`/`--context-diff` 共存、合并），然后照常起一个全新的 run。设计上明确
  **不是**续跑机制——不复用 worktree / session，与下面「未决问题」里 `--resume`/`--continue` 的归一问题
  正交：本项只解决「填充失败上下文」，不碰「继续同一个 worktree」。

## 差距 4（人机工学）：冷启动税——写自包含 task 太贵

### 现象

- 自包含 task 要手写 100+ 行 + 一堆 file:line 锚点；delegate 全冷，上下文全靠我手抄。

### 根因

- 冷启动是外部异构 agent 的**本质成本**，但目前**没有任何降税工具**——所以本质成本被附带的手工劳动放大了。

### 计划

- **P1**✅：**显式上下文打包**——`--context <glob>` / `--context-diff <ref>`：把指定文件 / diff **确定性**地拼进 task，
  省去手抄锚点。确定性、可预期，**不做检索 / RAG**。已落地：`packages/cli/src/commands/context-pack.ts` 的
  `buildContextSections()`——glob 用 `fs.promises.glob`（按字典序，确定性），`--context-diff` 走
  `git diff <ref>`；合计 40,000 字符硬上限，超出截断并打标记；零匹配 / 读取失败 / diff 失败只警告不致命。
- **P1**✅：**task 自检**——`delegate --dry-run`：对 task 做自包含性 lint（有没有点名文件、验收标准、测试命令），
  把 skill 里「弱 task」的告诫变成 launch 前的可执行反馈。已落地：`--dry-run` 对打包后的最终 task 文本
  跑三条启发式检查（具体文件路径 / 验收标准关键词 / `--test` 或测试命令关键词），全过返回 0、否则 1，
  零网络调用、零 worktree——可直接当 CI 门禁用。

## 差距 5（人机工学）：CLI 表面不一致的 papercut

### 现象

- `portico agents` 之前不收 `--url`（[#17] 已补）；命令间 flag 不齐、错误→重试提示风格不一，是持续的小磨损。

### 计划

- **P1**✅：**flag 一致性审计**——所有联网命令统一支持 `--url` / `--token` / `--repo` / `--json`；错误信息统一带「可复制重试」。
  低成本、显著降磨损。审计结果：`--url`/`--token`/`--repo`/`--json` 在所有联网命令（`agents`/`runs`/`watch`/
  `status`/`apply`/`cancel`/`discard`/`review`/`patch-stack`/`delegate`/`logs`）上已经一致——[#17] 的补齐
  已覆盖到位，本轮没有发现遗漏。修了一处小 papercut：`printDaemonError` 的 daemon-down 提示之前统一写
  「pass `--auto-start`」，但该 flag 只在 `delegate` 上存在（且 P0 后已默认开启），对其他命令是误导性建议——
  改成不提具体 flag，只说 `portico start` / `PORTICO_URL`。

## 分期

| 阶段 | 重点 | 目标 |
| --- | --- | --- |
| P0 | 终态内联可信判读（差距1，✅已完成）+ 零配置 daemon/默认超时（差距2，✅已完成）+ cancel salvage（差距3，✅已完成）/ `apply --allow` 落地 policy-failed 好 diff（差距3，承接 [#18]，✅已完成）/ `delegate --continue`（差距3，承接 [#18]，未开始） | 删掉「读盘 + 运维 + 全损」三大附带税 |
| P1 | `verdict` 事件 / `result --json`、预检健康门、iterate 模板、context 打包、`--dry-run` task 自检、CLI 一致性（均 ✅已完成） | 把冷启动税与 papercut 也压低 |
| P2 | （探索）更紧的续跑 / 跨 run 组合编排 | 大任务多趟协作接近无缝 |

## 非目标

- **不为了「更暖」放弃隔离 / apply 门禁 / path policy**——那正是 Portico 区别于内置 subagent 的本质价值。
- 不把 agent 自述提为权威以省一次读取（可信判读必须来自 Portico 观测）。
- 不为降仪式感而绕过用户确认自动 apply。
- 不试图把冷的外部 agent 变「有状态 / 暖」——冷是设计；只降它的**附带**税。
- 不做隐式上下文检索 / RAG；打包是**显式确定性**的，枚举仍在委派方。

## 验收标准

- ✅ 单次 `delegate`（不带 `--url` / `--timeout` / `--auto-start`）在 daemon 未起或在非默认端口时仍自洽跑通。
- ✅ 拿到终态后，**一次结构化读取**即可知道：改了什么、tests/verify、`reviewDecision`、`readiness`、风险——
  无需打开 `report.md` / `result.json` / 手跑 `git diff`。（单 run / child 终态；group 父 run 仍用 `review` 聚合。）
- 部分达成：被主动 `cancel` 的 run 能在**不重跑 agent、不离开 Portico** 的前提下叫停 → 保留半成品（已落地）；
  policy-failed 的好 diff 一等落地（`apply --allow`，✅已完成）。`delegate --continue` 续跑仍未做（承接 [#18]）。
- ✅ `delegate --dry-run` 能对一个弱 task 指出缺了文件 / 验收标准 / 测试命令。

## 未决问题

- ~~「终态内联可信判读块」主入口放 `run_done` 事件还是单独 `result` 命令？要不要都给（事件给流式、命令给随取）？~~
  已决策并落地：两者都做。`run_done`/`run_error` 事件 + `status --json` 给流式/随取的完整判读（P0）；
  `portico result <run_id> --json` 另开一个更窄的入口（P1），只回 `{ id, status, role, verdict, next }`，
  不带 `status` 的 progress/raw artifacts——给只想要「这就是结果」一句话的调用方。
- ~~`--auto-start` 设为默认有无安全顾虑（沙箱 / 多 repo 下意外起 daemon）？默认 loopback-only 够不够？~~
  已决策并落地：默认开启，loopback-only 护栏不变，新增 `--no-auto-start` 兜底；本机端到端验证过默认开启
  自动起 daemon、跑完后清理，以及 `--no-auto-start` 快速失败两条路径。
- ~~context 打包的边界在哪——打多少算「确定性帮忙」、多少算「替 orchestrator 做了它该做的判断」？~~
  已决策并落地：只做显式枚举（`--context <path-or-glob>` / `--context-diff <ref>`），零检索/排序/摘要——
  匹配即原文拼入，按 flag 顺序、合计 40,000 字符硬截断；orchestrator 该做的判断（测什么、允许改哪些路径）
  完全不受影响，打包只触达 task 文本本身。
- ~~iterate 模板、现有 `--resume`（child-only、需 session）、[#18] 的 `--continue` 如何归一，避免三套语义？~~
  已决策并落地：**不归一，保持三套正交语义**——`--iterate-from` 只读取上一个 run 的失败摘要拼进新 task、
  起一个全新 run（零续跑）；`--resume` 在已有 worktree/session 里续跑同一个 child（需要 adapter 支持
  session resume）；`--continue`（[#18]，仍未做）将是「在已有 worktree 上不依赖 session 续跑」。三者解决
  的是不同问题（填上下文 vs 续 session vs 续 worktree），强行合并只会让单个命令的语义变模糊。
- 有没有一个**可量化的体验指标**来判断「是否已接近 spawn subagent」？候选：从 `delegate` launch 到拿到可信结论所需的**人工步数 / 读取次数**——目标把它降到 1。
  P1 落地后估算：单 run 的「launch → 可信结论」现在是 1 步（`status --json` 或 `result --json` 任选其一，
  二者都内嵌完整 `verdict`）；尚未验证的是多 agent fan-out / group 场景下，`review <group_id>` 是否也能
  做到同样的「一次读取」——留给 P2 探索续跑/组合编排时一并考察。
