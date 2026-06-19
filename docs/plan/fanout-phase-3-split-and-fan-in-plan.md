# Portico Fan-out Phase 3：任务分治与 Fan-in 合并 开发计划

> 本文是 Portico fan-out 系列计划的第三篇。前置：
> [Phase 1 — 并行执行与并发池](fanout-phase-1-parallel-execution-plan.md)、
> [Phase 2 — Group Run 模型与生命周期](fanout-phase-2-group-runs-plan.md)。

## 1. 背景

Phase 1 让 fan-out 能并行执行，Phase 2 让 fan-out 群体成为可管理、可导航、可异构、可迭代的
一等对象。但到 Phase 2 为止，fan-out 仍只覆盖了**竞争式**这一种语义：同一个 task 派给 N 个
agent，产出 N 份**互斥**的候选实现，最后由人选一个 apply（apply-one）。

真正的「分治」还没有：

1. **没有任务分解入口（split）**。无法把一个大 task 拆成 N 个**互补**子 task，分给 N 个 agent
   各做一块。
2. **没有 fan-in 合并**。Phase 2 的 group 里每个 child 产出独立 patch，`apply` 只能选一个；
   无法把 N 个互补的 patch**合并成一份**整体 patch 一起 apply。
3. **没有自动选优 / 评审**。竞争式仍依赖人读报告选一；缺少一个 judge 阶段帮助排序或推荐。

Phase 3 补齐这三块，把 fan-out 从「同一改动的多个竞争实现」扩展到「一个大改动的分治协作」，
并加入可选的自动评审。这一阶段技术上最难的是 **patch 合并的冲突处理**，因此本计划采用
「先互斥、后冲突可控」的保守策略。

## 2. 设计定位（与 Claude Agent SDK 的边界）

参考 Claude Agent SDK 的 subagent / Workflow 文档后，明确一条边界判断写进设计：

- **SDK subagent / Workflow fan-out**：进程内、上下文隔离、产出文本、轻量；适合**读侧 / 分析类**
  工作（探索、研究、评审建议）。
- **Portico fan-out**：跨进程、worktree 隔离、产出可复审 patch、重量、用户 gate apply；适合
  **写侧 / 实现类**工作。

因此 Phase 3 的两个关键点遵循：

1. **分治调度放在 orchestrator 这个确定性引擎里**（类似 Workflow「把编排移出对话上下文」的
   思路），对外是一次 delegate 调用，而不是让调用方 agent 自己循环 delegate（那会撞上
   `maxDepth=1` 且把调度放进不可靠的对话层）。
2. **fan-in 的 judge 用 Portico 自己的 `review` 模式 child 实现，保持 agent-agnostic**，
   不在 Portico 进程内引入 Agent SDK 依赖（会破坏 Portico「无 build、极简依赖、路由到用户
   已装的任意 CLI」三条约束）。

## 3. Phase 3 目标

1. 引入 **split 模式**：把一个 group task 分解为 N 个互补子 task（手动指定为主，planner 辅助
   为可选增强）。
2. 引入 **fan-in 合并**：把 N 个 child 的 patch 合并成 group 的一份整体 patch，支持 apply-all。
3. 引入 **冲突处理**：互斥文件直接叠加；重叠文件用 integration worktree 做三方合并，冲突作为
   artifact 上报，group 进入 `conflict` 状态而非硬合。
4. 引入可选的 **judge 评审**：一个 `review` 模式 child 读取所有候选 diff，输出排序 / 推荐，
   写进 group 报告。竞争式（compare）可借此从「人选」升级为「有推荐的人选」。

非目标：

1. 不做跨 repo 分治。
2. 不做无限自动修复循环（迭代修复仍走 Phase 2 的个体 resume）。
3. 不强制 planner；手动 split 是基线，planner 是可选项。

## 4. 模式与配置

### 4.1 新增 split 模式

```ts
export type DelegationMode = "implement" | "review" | "compare" | "split";
```

- **compare**（Phase 2 已有）：同 task，N child，patch 互斥，fan-in = 可选 judge + 人选一，
  apply-one。
- **split**（新增）：互补子 task，N child，patch 互补，fan-in = merge，apply-all（合并后整体
  apply）。

两种模式共用 Phase 1 的并行调度与 Phase 2 的 group 模型，差异只在**入口（如何产生 N 个 child）**
和**出口（如何收敛 N 份结果）**。

### 4.2 Fan-in 策略配置

在 `DelegateRequest` 上新增 fan-in 配置：

```ts
export interface FanInPolicy {
  /** patch 合并策略。 */
  merge?: "none" | "sequential" | "integration";
  /** 可选 judge：用一个 review child 评审/排序候选 diff。 */
  judge?: {
    /** judge agent provider。 */
    to: string;
    /** 评审指令（默认：按是否满足原始 task、正确性、可维护性排序并给出推荐）。 */
    instruction?: string;
  };
}

export interface DelegateRequest {
  // ... Phase 2 的 children / maxParallel / compareTargets ...
  /** Phase 3：fan-in 行为。 */
  fanIn?: FanInPolicy;
}
```

`merge` 默认值按 mode 推导：

- compare → `none`（候选互斥，不合并）。
- split → `integration`（互补子 patch 合并）。

### 4.3 ChildSpec.task 在 split 中的角色

Phase 2 已定义 `ChildSpec.task`（compare 下省略、继承 group task）。split 下 **每个
`ChildSpec.task` 必填**，且应配合 `allowedPaths` 把各 child 的改动边界划清，降低合并冲突概率。

```ts
// split 示例
{
  mode: "split",
  task: "Add OAuth login end-to-end",
  children: [
    { to: "claude", task: "Implement the OAuth backend routes and token exchange",
      allowedPaths: ["src/server/**"] },
    { to: "codex",  task: "Build the login UI and call the new routes",
      allowedPaths: ["src/web/**"] },
    { to: "gemini", task: "Add integration tests for the OAuth flow",
      allowedPaths: ["tests/**"] },
  ],
  fanIn: { merge: "integration" },
}
```

## 5. 任务分治（split 入口）

### 5.1 手动 split（基线）

调用方（人或上层 agent）直接提供 `children: ChildSpec[]`，每个带 `task` 与 `allowedPaths`。
orchestrator 不做分解，只负责并行执行 + fan-in。这是最确定、最可控的形态，作为 Phase 3 的
必交付基线。

### 5.2 Planner 辅助 split（可选增强）

提供一个可选的分解前置步骤：

1. 新增一个轻量 `planner` 步骤——用一个 agent（`review`/只读权限）读取 group task 与 repo
   结构，产出一组建议的 `ChildSpec`（含子 task 与建议的 allowedPaths）。
2. planner 的输出**必须经调用方确认**后才落为 children（不自动执行），避免不可控的自动分解。
3. planner 产出作为 group 的一个 artifact（`plan.json`）留痕。

planner 是增强项，可在 Milestone 末尾交付或推迟；手动 split 不依赖它。

## 6. Fan-in 合并

所有 child 都从同一个 `baseRef` 派生 worktree（Phase 2 的 group 已统一 baseRef）。这是合并能
成立的前提。

### 6.1 changed-file 互斥判定

合并前先收集各 child 的 `changedFiles`（已在各 child result.json 中）：

1. 求交集。**互斥**（交集为空）→ 走 6.2 顺序叠加，几乎不会冲突。
2. **重叠**（交集非空）→ 走 6.3 integration worktree 三方合并。

### 6.2 sequential：顺序叠加（互斥文件）

```
依次对各 child 的 diff.patch 做 git apply --3way 到一个干净的 integration worktree
（从 baseRef 创建）；互斥文件不会冲突，得到合并后的整体改动；
再对 integration worktree 生成一份合并 diff.patch 作为 group 的产物。
```

即使声明互斥，也用 `--3way` 兜底，遇到意外重叠能给出冲突信息而非静默错误。

### 6.3 integration：三方合并（重叠文件）

更健壮的通用路径，split 默认走这条：

1. 创建一个 integration worktree：`.portico/worktrees/<group_id>_integration`，分支
   `portico/<group_id>-merge`，从 `baseRef` 切出。
2. 依次把各 child 分支（`portico/<child_id>`）合并进来（`git merge --no-ff` 或逐个
   `git cherry-pick` / `git apply --3way`，实现时择一并写明）。
3. **无冲突** → integration worktree 即为合并结果；对其生成 group 的整体 `diff.patch`，
   group 状态 `ready`。
4. **有冲突** → 中止合并（`git merge --abort`），记录冲突文件清单到 group artifact
   `conflicts.json` 与 report，group 进入 **`conflict` 状态**（新增），**不**产出可 apply
   的整体 patch。引导用户用 Phase 2 的个体 resume 调整某个 child（缩小其改动范围）后重新合并，
   或手动解决。

新增 `RunStatus` 成员：

```ts
export type RunStatus =
  | ... | "partial" | "conflict"  // 新增：fan-in 合并冲突
  | ... ;
```

### 6.4 合并产物

split group 的 fan-in 产出：

- `diff.patch`：合并后的整体 patch（无冲突时）。
- `conflicts.json`：冲突文件与冲突来源 child（有冲突时）。
- `report.md`：列出各 child 的贡献、合并结果、（若有）冲突与建议。
- integration worktree：默认保留以便排查，受 group 的 cleanup 策略约束。

## 7. Fan-in 评审（可选 judge）

借鉴 Workflow 的 judge-panel 模式，但用 Portico 自己的 `review` child 实现，保持 agent-agnostic。

### 7.1 流程

1. 所有 child 完成后（merge 之前或之后，按 mode）：
   - **compare**：judge 读取各 child 的 diff.patch + 原始 task，输出排序与推荐（不合并）。
   - **split**：judge 可选地对合并结果做一次整体评审，输出是否满足原始 task。
2. judge 是一个 `mode: "review"`、`permissionProfile: "read-only"` 的 child run（复用现有
   review 路径，`orchestrator.ts:344-359`），只读、不改文件。
3. judge 的输出写进 group result 的 `selection` / `reviewSummary` 字段与 report。

```ts
export interface RunResult {
  // ... Phase 2 字段 ...
  /** judge 的评审结论（compare：排序+推荐；split：整体评审）。 */
  judge?: {
    to: string;
    recommendedChildId?: string;   // compare：推荐 apply 哪个
    ranking?: Array<{ childId: string; score?: number; note: string }>;
    verdict?: "approve" | "needs_attention";
  };
}
```

### 7.2 与 apply 的关系

- compare + judge：apply 仍是 **apply-one**（Phase 2），但 group report 现在带推荐，
  `portico status` 高亮 `recommendedChildId`。**人仍做最终决定**，judge 只给建议。
- split + judge：judge 是合并结果的整体把关；apply 是 **apply-all（合并 patch）**，见第 8 节。

judge 是可选的；不配置 `fanIn.judge` 时行为与 Phase 2 一致。

## 8. apply 语义扩展

在 Phase 2 的 `apply(repo, id, { child? })` 之上扩展：

```ts
apply(repo, id, options?: { child?: string; all?: boolean }): Promise<RunDetails>;
```

| group 类型 | apply 行为 |
| --- | --- |
| compare group | 必须 `--child <id>`（apply-one，同 Phase 2） |
| split group（合并成功，status=ready） | `--all` → apply 合并后的整体 `diff.patch`；落地全部 child 的贡献 |
| split group（status=conflict） | apply 被拒绝，提示先解决冲突（个体 resume 或手动） |

apply-all 复用现有 apply 的前置校验：working tree 必须干净
（`assertTrackedTreeClean`，`orchestrator.ts:722`），patch 用 `git apply --binary` 落地
（`orchestrator.ts:147`）。

CLI：

```bash
portico apply <split_group_id> --all       # 合并后整体 apply
portico apply <compare_group_id> --child X  # 竞争式选一
```

## 9. orchestrator 重构

在 Phase 2 的 `runGroupDelegation` 基础上：

1. `normalizeChildren` 支持 split：校验每个 child 有 `task`（split 模式强制）。
2. 并行执行阶段不变（Phase 1 合并工具 + Phase 2 lineage）。
3. 新增 **fan-in 阶段**（所有 child 结束后）：
   - 若配置了 `judge` 且 mode=compare：跑 judge review child，记录推荐。
   - 若 mode=split 或 `fanIn.merge != none`：跑合并（6.2 / 6.3），按结果置 group
     `ready` / `conflict`，产出合并 diff 或 conflicts.json。
   - 若 split 且配置了 judge：对合并结果再跑一次 judge。
4. fan-in 阶段也用一个独立的 integration worktree，受 worktree 串行化锁（Phase 1 §4.3）保护。

> fan-in 是 group 收尾的一部分，发生在合并循环 drain 之后、group `run_done` 之前。group
> `run_done` 的 `status` 反映 fan-in 结果（ready / conflict / partial）。

## 10. 事件扩展

新增 `DelegationEvent` 成员，覆盖 fan-in 阶段的可观测性：

```ts
export type DelegationEvent =
  | ... // 现有
  | { type: "fanin_start"; runId: string; strategy: "merge" | "judge" }
  | { type: "merge_done"; runId: string; status: "ready" | "conflict"; conflicts?: string[] }
  | { type: "judge_done"; runId: string; recommendedChildId?: string }
  | ...;
```

`runId` 为 group id。这些事件让 CLI/UI 能展示「合并中 / 合并完成 / 评审完成」的进度。

## 11. 安全与一致性

1. **apply 仍永远人工触发**。split 的 apply-all 也必须显式 `--all`，不自动 apply。
2. **冲突不硬合**：合并冲突一律中止 + 上报 + 进入 `conflict` 状态，绝不产出可能损坏的 patch。
3. **路径策略对每个 child 独立生效**（`enforcePathPolicy`，`orchestrator.ts:445`）；split 的
   `allowedPaths` 既是隔离手段、也是降低合并冲突的手段。
4. **judge 只读**：`permissionProfile: read-only` + `mode: review`，复用现有 review 的
   只读校验（`assertStatusUnchanged`，`orchestrator.ts:705`），保证 judge 不改任何文件。
5. **agent-agnostic**：fan-in 的 judge 与合并都不引入 Agent SDK 依赖；judge 是另一个普通的
   Portico delegation run，可指向用户已装的任意支持 review 的 agent。
6. **integration worktree 清理**受 group cleanup 策略约束，默认保留以便排查冲突。

## 12. 测试计划

### 12.1 split 入口

1. 手动 split：每个 child 带 task + allowedPaths，产出各自 patch，lineage 正确。
2. split 缺 `ChildSpec.task` → 校验报错。
3. （可选）planner 产出 `plan.json`，需确认后才落为 children。

### 12.2 Fan-in 合并

1. **互斥文件** split → sequential/integration 合并成功，group 整体 diff 包含全部贡献，
   apply-all 可落地。
2. **重叠无冲突**（不同 child 改同一文件不同区域）→ integration 三方合并成功。
3. **重叠有冲突**（改同一区域）→ 合并中止，`conflicts.json` 列出冲突文件，group 状态
   `conflict`，apply-all 被拒绝。
4. 冲突后用 Phase 2 个体 resume 缩小某 child 改动 → 重新合并成功。

### 12.3 Judge

1. compare + judge → group report 带排序与 `recommendedChildId`；apply 仍 apply-one。
2. split + judge → 合并结果被整体评审，verdict 写入 result。
3. judge child 全程只读（断言工作树未被改）。
4. 不配置 judge → 行为与 Phase 2 一致（回归）。

### 12.4 apply 语义

1. split group ready → `apply --all` 落地合并 patch。
2. split group conflict → `apply --all` 被拒绝。
3. compare group → `apply --all` 被拒绝（必须 `--child`）。

### 12.5 回归

1. Phase 1 并行、Phase 2 group/lineage/生命周期 不回归。
2. `npm test` 与 `npm run typecheck` 全绿。

## 13. 里程碑

### Milestone 1：split 模式与手动分治

目标：

1. 新增 `split` 模式与 split 下 `ChildSpec.task` 必填校验。
2. `runGroupDelegation` 支持 split（并行执行复用 Phase 1/2）。
3. 手动 split 端到端：N 个互补 child 各产出 patch。

验收标准：12.1 通过。

### Milestone 2：Fan-in 合并（互斥 + 三方）

目标：

1. 实现 sequential 与 integration 两种合并，integration worktree 受串行锁保护。
2. 互斥文件叠加成功；重叠无冲突三方合并成功。
3. 产出合并 `diff.patch`。

验收标准：12.2 的 1、2 通过。

### Milestone 3：冲突处理与 `conflict` 状态

目标：

1. 新增 `conflict` 状态；冲突中止 + `conflicts.json` + report。
2. 冲突后 Phase 2 个体 resume → 重新合并闭环。
3. 新增 fan-in 事件（`fanin_start` / `merge_done`）。

验收标准：12.2 的 3、4 通过。

### Milestone 4：apply 语义扩展

目标：

1. `apply --all`（split）、`apply --child`（compare）。
2. conflict / 模式不匹配的拒绝路径。

验收标准：12.4 通过。

### Milestone 5：Judge（可选评审）

目标：

1. `fanIn.judge` → 用 review child 评审；compare 出推荐、split 出整体 verdict。
2. `judge_done` 事件；result 的 `judge` 字段；report 高亮推荐。

验收标准：12.3 通过。

### Milestone 6：Planner（可选增强）与收尾

目标：

1. （可选）planner 辅助 split，产出 `plan.json`，需确认。
2. 更新 `docs/delegation.md`、`docs/review-and-compare.md`、`docs/daemon-api.md`、
   `README.md`、`docs/roadmap/roadmap.md`。
3. 全量回归 12.5。

验收标准：文档与 roadmap 更新；全绿。planner 可作为本里程碑的延伸项或推迟。

## 14. 风险与对策

| 风险 | 对策 |
| --- | --- |
| patch 合并冲突处理复杂、易损坏代码 | 先互斥叠加、后三方合并；冲突一律中止 + 上报，绝不硬合；引入 `conflict` 状态 |
| split 子 task 划分不当导致大量重叠冲突 | 强制/鼓励 `allowedPaths` 划界；planner 给建议；冲突后用个体 resume 收敛 |
| 自动分解不可控 | planner 仅给建议、必须人确认；手动 split 为基线 |
| 引入 Agent SDK 破坏 Portico 约束 | judge 用 Portico 自己的 review child，agent-agnostic，零新增依赖 |
| integration worktree 与 child worktree 并发 git 操作竞争 | 复用 Phase 1 的 worktree 串行化锁 |
| apply-all 落地大 patch 失败 | 沿用 working tree 干净校验 + `git apply --binary`；失败保留 artifacts 可追溯 |

## 15. 完成定义（Definition of Done）

1. split 模式可用：手动分治端到端跑通，lineage / 生命周期复用 Phase 2。
2. fan-in 合并可用：互斥叠加 + 三方合并，冲突进入 `conflict` 状态并可经 resume 收敛。
3. apply-all（split）与 apply-one（compare）语义清晰、拒绝路径正确。
4. 可选 judge 评审可用，agent-agnostic，全程只读。
5. fan-in 事件齐全，CLI/UI 可观测合并与评审进度。
6. 全量测试与 typecheck 全绿；文档与 roadmap 更新。
