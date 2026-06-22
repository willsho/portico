# Portico 部分完成 / 门禁受阻运行的落地计划

来源：用 antigravity 通过 Portico 委派「delegation 摩擦修复」这件多步任务时，连续遇到两类问题，
都让一个**已经产出有用 diff** 的运行无法走正常的 review→apply 路径，只能靠人工绕行。本计划记录
这两类摩擦、根因，并按「先止血、再降摩擦」排出分期。

> 关联：[[portico-delegation-pain-points-plan.zh-CN]]（P0/P1 已落地，本计划是其在「运行落地」维度的延续）。
> 本计划属于内部 plan 文档，沿用本目录其它 zh-CN-only plan 的惯例，不强制英文镜像。

## 背景复盘

把 5 个 delegation 摩擦写成一份 spec 交给单个 antigravity，实际跑了三趟：

1. `run_20260621155110`（P2，较小任务，3 功能）：一趟 ~4.4 min 干净完成，`ready`/`approve`，正常 apply。
2. `run_20260621162034`（摩擦修复 pass 1）：agent 内部抛 `Error: timed out waiting for response` **中途截断**，
   只做了痛点 1 + 痛点 2 核心就停了；产出了 diff、typecheck 过，运行判为 `ready`，但**任务只完成约 40%**，
   还顺手把一个已有测试跑红。
3. `run_20260621163331`（摩擦修复 pass 2）：再次 `timed out waiting for response` 截断；做了更多（痛点 3/4/5 + 测试 + 部分 SKILL.md），
   但**只因改了一个 `--allowed` 之外的共享 fixture（`test/fixtures/split-agent.mjs`，加了个安全的 opt-in 指令）被
   path policy 判 `path_not_allowed` → 运行 `failed`**。`portico apply` 拒绝 `failed` 运行，于是这份经审查、
   `npm test` 全绿的 diff 只能靠 `git apply` worktree diff **绕过 Portico apply 门禁**落地。

结论：真正的成本不在「agent 写得对不对」，而在「一个干了有用活、但没走到干净 `ready` 的运行，
Portico 没有一等的 review-and-land 路径」。这正是本计划要补的洞。两类触发条件不同，但落地困境同源。

## 问题 A（正确性/判读）：agent 自我截断，让部分完成的运行被误读为 ready

### 现象

- antigravity（v1.0.10）对**大任务**会被自己的请求超时（`Error: timed out waiting for response`）截断，
  与 Portico 的 `--timeout` 无关——Portico 给了 30 min，agent 仍在几分钟内自行停止。
- 截断后若已产出 diff 且配置的 test 通过，运行判为 `ready`，但任务**实际只完成一部分**。`ready` 在这里
  = 「产出了 diff + test 绿」，**不等于「任务做完了」**。
- 误读成本高：orchestrator 必须人工把产物逐条对照任务 spec，才发现缺了哪些项、文档没补、测试没加。

### 根因（已用代码确认）

- `buildRunResult` 推导 `ready` / `reviewDecision` 只看「有没有 diff、test/verify 是否绿、no-change、coverage gap」，
  **没有任何「任务完成度」的概念**。一个干了 40% 就停的 agent，typecheck 照样过、照样 `ready`。
- Portico 不解析 agent 最终消息里的截断信号（`timed out waiting for response` 这类 adapter 层 marker），
  所以「agent 提前停了」这个事实在 `## Portico Observations` 里完全不可见。
- 已有的 idle watchdog（本轮 [#17] 引入）解决的是**卡死**（无输出）；自我截断是 agent **干净退出但太早**，
  是不同情形，watchdog 抓不到。

### 计划

- **P0（流程，无需改码）**：大任务**按单个 agent 预算切小**——拆成顺序多趟或 `--mode split` 子任务；
  把每趟的好产物作为**中间 commit 落地**，再针对剩余项基于该 HEAD 重新委派（这样下一趟能看见并记录前一趟的成果）。
  把这条写进 `SKILL.md` 的 orchestrating 段，作为推荐模式。（本轮已用此法两趟收尾。）
- **P1（信号，复用已有结构）**：让部分完成**不再读作 done**。
  - 复用 `--expected-change` / `## Coverage`（痛点 7 已落地）：声明预期产物路径，只触及一部分 → 已经会 `needs_attention`。
    把它列为大任务的标准做法。
  - 新增**截断检测**：扫描 agent 最终消息 / `agent.ndjson` 是否含已知截断 marker，命中则 `reviewDecision: needs_attention`
    + gate warning「agent 可能提前停止（日志含截断标记），产物或不完整」。这是针对「干净退出但太早」的定向修法，
    与 watchdog 互补。判定**只用可观测信号**（adapter marker），不去 parse 任务自然语言。
- **P2（续跑，组合类）**：提供「在部分产物上续跑」的一等入口——`portico delegate --continue <run_id>`：以该运行的
  worktree/commit 为 base 起新运行，把剩余项接着做（现在是人工「提交 partial + 基于新 HEAD 再委派」）。
  需要 adapter 支持，属增量优化，按需再做。

## 问题 B（正确性）：path-policy 失败即 `failed`，好 diff 无一等落地路径

### 现象

- 运行只要改了 `--allowed` 之外**一个**文件，就 `path_not_allowed` → 整个运行 `failed`，哪怕其余 diff 正确、test 全绿。
- `portico apply` 拒绝 `failed` 运行，所以这份已审查的 diff 只能 `git apply` worktree diff 绕过门禁——
  绕行同时**丢掉了 apply 自带的 clean-tree 检查与 provenance**。
- `path_not_allowed` 的重试提示是「re-run with --allowed X」，**暗示重跑整个 agent**——当 diff 已经是好的，重跑纯属浪费
  （又一次 N 分钟 + 可能再被截断）。

### 根因（已用代码确认）

- `enforcePathPolicy` 把越界当**硬失败**（抛 `DelegationError("path_not_allowed")` → 运行 `failed`），
  把「scope 边界踩线」（多是 `--allowed` 配窄了的配置 nit）与「这个运行不可信」混为一谈。
- `apply` 只放行 `ready` 运行，**没有**「只 apply 边界内文件」或「用户显式确认后越界 apply」的路径。
- 于是「diff 是好的，只是 scope 配窄了」这一最常见的情况，在 Portico 里没有不重跑、不绕行的出口。

### 计划

- **P0（止血，仍需用户批准）**✅：给一个**不重跑 agent 就能落地好 diff** 的出口。已落地：
  `portico apply <run_id> --allow <path>…`（重复传参；单 run 与 `--child <child_id>` 的 group child
  都支持）。`packages/orchestrator/src/orchestrator.ts` 的 `resolvePathPolicyOverride()` 判定——只
  在 `result.pathPolicy.status === "failed"` 且 `forbidden` 为空（命中 `forbidden` 永不可 override）
  时生效，且 `--allow` 必须覆盖 `notAllowed` 的每一个路径，否则报错列出未覆盖的路径。其余前提不变
  （`assertTrackedTreeClean`、diff 必须存在）。落地后在 `result.json` 写入
  `pathPolicyOverride: { allow, appliedAt }` 留痕（回答了下面「未决问题」里关于是否留痕的疑问：写）。
  `path_not_allowed` 的错误提示也加了一行可直接复制的 `apply --allow` 落地命令。单测见
  `packages/orchestrator/tests/orchestrator.test.ts`（成功 override、`forbidden` 不可 override、
  `--allow` 未覆盖全部越界路径时报错三个场景）。
- **P1（判读 + 引导）**：
  - 在 status / report 里把「仅 path policy 失败」与「真失败」**区分**：例如子状态 `failed (path_policy)`，
    `review` 显示该运行的 diff 其实可审查，并提示上面的 `--allow` 落地路径。
  - `path_not_allowed` 的提示**加一行**：「或直接落地已有 diff：`portico apply <id> --allow <path>`」，
    让用户知道不必重跑 agent。
- **不软化边界**：path policy 是安全边界，**不**把越界普遍降级为 warning。定向修法是「apply 时用户显式确认的越界 override」，
  而非削弱 enforcement。`--forbidden` 命中这类真违规仍应硬失败，不进入 `--allow` override。

## 已有地基

- 本轮 [#17] 的「出错/超时/卡死也抓 worktree diff」（痛点 3）已经让**被截断的运行也能留下 diff.patch**，
  是问题 A 续跑/落地的前置；问题 B 的 diff 一直能生成（path policy 在 diff 之后才判），缺的是落地出口。

## 分期

| 阶段 | 类别 | 重点 | 目标 |
| --- | --- | --- | --- |
| P0 | 流程 + 止血 | A：大任务切小 + partial 落地再续（文档）；B：`apply --allow` 落地 policy-failed 好 diff（✅已完成） | 不再为一个越界文件重跑、不再绕过 apply 门禁 |
| P1 | 判读 | A：截断 marker 检测 → `needs_attention` + 复用 coverage；B：区分 `failed (path_policy)` + 提示落地路径 | 部分/受阻运行不被误读、有清晰下一步 |
| P2 | 组合 | A：`delegate --continue <run_id>` 在 partial 上续跑 | 大任务多趟协作更顺 |

## 非目标

- 不把「任务完成度」做成 Portico 内建的语义判断；只用可观测信号（截断 marker、coverage、test）旁敲侧击。
- 不软化 path policy 这条安全边界；越界落地必须用户显式确认，`--forbidden` 真违规不可 override。
- 不绕过用户确认自动 apply 任何 `failed` / `needs_attention` 运行。
- 不为某一个 agent 的截断行为做特判（marker 检测应是 adapter 可扩展的清单）。

## 验收标准

- ✅ 一个 path-policy-failed 但 diff 已绿的运行，能在**不重跑 agent、不离开 Portico** 的前提下，
  经用户确认落地（`apply --allow`），并保留 clean-tree 检查。
- 被 agent 自我截断的运行，在 report / status 里有**显著信号**（截断标记 / coverage gap → `needs_attention`），
  不再和真正做完的 `ready` 混在一起。
- `path_not_allowed` 与截断的提示都给出「落地已有产物」或「续跑」的下一步，而不是只会让人重跑整个 agent。

## 未决问题

- 截断 marker 清单放哪、谁维护？（adapter 层各家文案不同：antigravity 是 `timed out waiting for response`，
  其它 agent 待收集）——倾向 adapter 自报一个结构化「early-stop」事件，而非 orchestrator 猜文案。
- ~~`apply --allow` 越界落地：是要求用户重列完整允许集，还是只确认这几个越界路径？默认是否仍写入 result 以留痕？~~
  已落地并决策：只需确认越界的这几个路径（`--allow` 必须覆盖 `notAllowed`，不必重列完整允许集），
  且默认写入 `result.pathPolicyOverride` 留痕。
- `delegate --continue` 的 base 取 worktree 还是 partial commit？与现有 `--resume`（child-only、需 session）如何归并，避免两套语义？
- 问题 A 是否值得在 Portico 侧做任何事，还是纯靠「切小 + 文档」就够？（取决于截断在非 antigravity agent 上的普遍性。）
