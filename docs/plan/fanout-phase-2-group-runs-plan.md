# Portico Fan-out Phase 2：Group Run 模型与生命周期 开发计划

> 本文是 Portico fan-out 系列计划的第二篇。前置：
> [Phase 1 — 并行执行与并发池](fanout-phase-1-parallel-execution-plan.md)。
> 后续：[Phase 3 — 任务分治与 Fan-in 合并](fanout-phase-3-split-and-fan-in-plan.md)。

## 1. 背景

Phase 1 让 fan-out 能够**并行执行**，但 fan-out 的「群体」本身还不是一等公民：

1. **父子关系不可导航**。`Run`（`packages/orchestrator/src/types.ts:53-71`）没有
   `parentRunId` / `groupId` 字段。compare 的父子关系只埋在父 `result.json` 的
   `compareResults`（`types.ts:116`）里，无法从子 run 反查父、也无法从 `portico runs` 的
   列表里把一组 run 折叠展示。
2. **生命周期命令不理解「组」**。`apply` 只接受 `mode: "implement"` 且 `status: "ready"`
   的单个 run（`orchestrator.ts:137-142`）；`cancel` 只 abort 单个 run 的 controller
   （`orchestrator.ts:128`）；`runs` / `status` 把所有 run 平铺。fan-out 产生的一组 run
   无法作为整体被 apply / cancel / 查看。
3. **fan-out 是同构的**。compare 给所有目标发的是**同一个 task**，差异只有目标 agent。无法
   让每个子 run 用不同的 agent、不同的权限档、不同的模型。
4. **子 run 不可单独迭代**。某个子 run 测试挂了，只能整组重跑，不能「只针对那个子 run 让它
   接着修」。

Phase 2 的目标是把 fan-out 群体变成可管理、可导航、可异构、可迭代的一等对象。这是让 fan-out
从「能跑」走向「能用」的关键一步，也是 Phase 3（分治 + 合并）所依赖的容器。

## 2. Phase 2 目标

1. 引入 **Group Run** 数据模型与 lineage：`Run` 增加 `role` / `groupId` / `parentRunId` /
   `childRunIds`，子 run 可反查父，列表可折叠。
2. 引入聚合状态：group run 的状态由其子 run 的状态派生（含 `partial`）。
3. 引入 **per-child 异构配置** `ChildSpec`：每个子 run 可指定不同 agent、权限档、模型、
   effort、路径策略。compare 成为它的一个特例。
4. 让 `apply` / `cancel` / `discard` / `runs` / `status` 全部理解 group：
   - `apply` 支持 apply-one（compare 选一）。
   - `cancel` 支持级联取消整组。
   - `discard` 支持整组清理。
   - `runs` / `status` 支持折叠与展开。
5. 引入**子 run 的个体 resume**：捕获目标 agent 的原生 session，支持
   `portico delegate --resume <child_id>` 在子 run 的 worktree 里续跑、迭代修复。

非目标：

1. 不做任务分治（task decomposition）与 patch 合并——那是 Phase 3。Phase 2 的 group 里每个
   子 run 仍各自产出独立 patch，`apply` 只支持 apply-one（不做多 patch 合并）。
2. 不做 judge agent 自动选优——Phase 3。

## 3. 数据模型变更

### 3.1 Run：增加 lineage 与角色

```ts
export type RunRole = "single" | "group" | "child";

export interface Run {
  // ... 现有字段不变 ...

  /** 该 run 在 fan-out 结构中的角色。缺省视为 "single"（向后兼容旧 run.json）。 */
  role?: RunRole;
  /** child run 指向其 group run 的 id；group/single 为空。 */
  groupId?: string;
  /** 与 groupId 同义的更通用别名，便于 Phase 3 的多层结构；child 上等于 groupId。 */
  parentRunId?: string;
  /** group run 列出其全部 child run id；child/single 为空。 */
  childRunIds?: string[];
  /** 子 run 的展示标签（来自 ChildSpec.label，便于在并发视图里区分）。 */
  label?: string;
  /** 目标 agent 的原生 session id（用于个体 resume），由 adapter 捕获后写入。 */
  agentSessionId?: string;
}
```

向后兼容：旧的 `run.json` 没有 `role`，读取时缺省按 `"single"` 处理；所有新增字段都是可选。

### 3.2 ChildSpec：per-child 异构配置

借鉴 Claude Agent SDK 的 `AgentDefinition` 工厂模式——每个子 agent 可独立配置（不同 agent、
权限、模型）。把 compare 现有的「扁平目标字符串列表」升级为结构化的子配置列表。

```ts
export interface ChildSpec {
  /** 目标 agent provider。 */
  to: string;
  /** 子 run 的任务。compare 模式下省略（继承 group task）；Phase 3 split 模式下必填。 */
  task?: string;
  /** 覆盖权限档；省略则按 mode/isolation 推导（见 normalizePermissionProfile）。 */
  permissionProfile?: PermissionProfile;
  /** 模型覆盖（adapter 支持时透传，如 Claude）。 */
  model?: string;
  /** 推理 effort 覆盖（adapter 支持时透传）。 */
  effort?: string;
  /** per-child 路径策略，覆盖 group 级默认。 */
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  /** 展示标签。 */
  label?: string;
}
```

### 3.3 DelegateRequest：fan-out 入口

```ts
export interface DelegateRequest {
  // ... 现有字段不变 ...

  /** 显式 fan-out：每个 ChildSpec 产生一个子 run。 */
  children?: ChildSpec[];
  /** fan-out 并发度上限（覆盖 orchestrator 默认）。 */
  maxParallel?: number;

  /** 兼容保留：compare 的旧入参。内部归一化为 children。 */
  compareTargets?: string[];
}
```

归一化规则（在 `delegate()` 入口做一次）：

- `mode: "compare"` 且提供了 `compareTargets`：归一化为 `children = [to, ...compareTargets]
  .map(t => ({ to: t }))`，每个 child 的 task 继承 group task。这保证旧 CLI/HTTP 调用不变。
- 显式提供 `children`：直接使用。`mode` 默认推断为 `"compare"`（同 task）或由调用方显式指定。

### 3.4 GroupResult：聚合结果

复用现有 `RunResult`，但 group run 的 result 语义化字段更明确：

```ts
export interface RunResult {
  // ... 现有字段 ...
  /** group run：各子 run 的结果（取代 compareResults，compareResults 保留为别名/兼容）。 */
  childResults?: RunResult[];
  /** group run：聚合状态摘要。 */
  groupSummary?: {
    total: number;
    ready: number;
    failed: number;
    cancelled: number;
  };
}
```

> `compareResults` 字段保留以兼容已落盘的旧 result.json 与 README 文档；新代码写
> `childResults`，读取时两者都认。

## 4. 聚合状态机

group run 的 `status` 由其 child 派生：

| 条件 | group status |
| --- | --- |
| 任一 child 处于 running/testing/planning/reviewing | `running` |
| 全部 child = ready | `ready` |
| 全部 child = failed/cancelled | `failed`（或 `cancelled`，若全是取消） |
| 部分 ready、部分 failed/cancelled | `partial`（**新增状态**） |

新增 `RunStatus` 成员：

```ts
export type RunStatus =
  | "created" | "planning" | "running" | "testing" | "reviewing"
  | "ready" | "partial"   // 新增：group 部分成功
  | "failed" | "cancelled" | "applied" | "discarded";
```

`partial` 仅用于 group run。单 run 不会进入 `partial`。

聚合在两处发生：

1. **实时**：每当某个 child 发出 `run_done` / `run_error`，group 重新计算并持久化状态
   （便于 `portico status` 在运行中查询到中间态）。
2. **收尾**：合并循环结束后做最终聚合并写 group 的 result.json / report.md。

## 5. orchestrator 重构

### 5.1 统一的 `runFanout`

把 Phase 1 重构后的 `runCompareDelegation` 进一步抽象为 `runGroupDelegation`（或
`runFanout`）：

```ts
async function* runGroupDelegation(request, repoPath, context, deps) {
  const children = normalizeChildren(request); // compareTargets / children 归一化
  if (children.length < 2) throw new DelegationError("fanout_requires_children", ...);

  const group = createGroupRun(repoPath, request, children); // role: "group"
  // 写 group 的 task.json、run.json、events.ndjson，发 group run_start

  const sources = children.map((spec) => () =>
    runSingleDelegation(buildChildRequest(request, group, spec), repoPath, context, deps),
  );

  const childResults = new Map();
  for await (const event of mergeAsyncIterables(sources, { /* Phase 1 信号量 */ })) {
    yield event;
    if (event.type === "run_done" || event.type === "run_error") {
      await recomputeGroupStatus(group); // 实时聚合并持久化
      childResults.set(event.runId, await readChildResult(repoPath, event.runId));
    }
  }

  await finalizeGroup(group, childResults); // 最终聚合、写 result/report，发 group run_done
}
```

`buildChildRequest` 用 `ChildSpec` 覆盖 group 默认值，并把 lineage 写进 child run：
`role: "child"`, `groupId: group.id`, `parentRunId: group.id`, `label: spec.label`。

`createGroupRun` 创建的 group run **不拥有 worktree**（worktree 属于各 child）；group 的
`worktreePath` 字段可留空或指向一个仅用于聚合 artifacts 的逻辑路径。

### 5.2 child run 写 lineage

`runSingleDelegation` 的 `createRun` 调用（`orchestrator.ts:284-291`）接受新的可选参数，把
`role` / `groupId` / `parentRunId` / `label` 落进 child 的 run.json。单独发起的（非 fan-out）
delegate 仍写 `role: "single"`。

### 5.3 group 与并发计费

- group 父请求在 `delegate()` 入口占用一个 `maxConcurrentRunsPerRepo` slot（沿用现状）。
- group 内 N 个 child 共享 Phase 1 的全局 `agentSemaphore`（`maxConcurrentAgentProcesses`）。
- `request.maxParallel` 若提供，则作为该 group 内部的并发上限（取 `min(maxParallel,
  全局信号量额度)`）。

## 6. 生命周期命令适配

### 6.1 `apply`

现状只接受单个 implement run（`orchestrator.ts:134-154`）。Phase 2 扩展：

```ts
apply(repo, id, options?: { child?: string }): Promise<RunDetails>;
```

规则：

1. `id` 是 **single run** → 行为同现状（apply 该 run 的 diff）。
2. `id` 是 **group run（compare 类）** 且未指定 `child` → **报错**，提示「compare 组是同一改动
   的多个竞争实现，必须指定要 apply 的子 run：`portico apply <group_id> --child <child_id>`」。
3. `id` 是 **group run** 且指定了 `child` → 校验该 child 属于此 group、且 child 状态为
   `ready`、有 diff.patch，然后 apply 该 child 的 diff。apply 成功后：child 状态置 `applied`，
   group 状态置 `applied`（语义：该组已通过选一落地）。
4. **apply-all / 合并多 patch** 不在 Phase 2 范围（compare 的多个候选是互斥实现，叠加无意义）；
   split 模式的 apply-all/合并留给 Phase 3。

CLI：

```bash
portico apply <group_id> --child <child_id>
```

### 6.2 `cancel`（级联）

现状 abort 单个 controller（`orchestrator.ts:125-132`）。Phase 2：

1. `id` 是 single → 同现状。
2. `id` 是 group → 遍历 `childRunIds`，对每个仍活跃的 child abort 其 controller
   （`activeControllers.get(childId)?.abort()`），把未结束的 child 标记 `cancelled`，
   group 标记 `cancelled`。
3. 复用 Phase 1 的级联清理路径（合并工具 `return()` → 子迭代器 `return()` → abort），
   `cancel(group)` 只是把它显式暴露为命令入口。

### 6.3 `discard`（整组）

1. `id` 是 single → 同现状（删 worktree、状态 discarded）。
2. `id` 是 group → 遍历 `childRunIds`，逐个删 child worktree、标记 discarded，group 标记
   discarded。artifacts 默认保留。

### 6.4 `runs`（折叠）

`listRuns` 现状平铺读取所有 run.json（`orchestrator.ts:99-110`）。Phase 2：

1. 仍读取全部 run.json。
2. 返回结构支持折叠：child run 不在顶层平铺，而是挂在其 group 之下。
3. 兼容：保留一个 `?flat=true` 选项返回平铺列表（便于调试）。

CLI `portico runs` 默认展示折叠视图：

```
run_2026..._group  compare  partial  (3 children: 2 ready, 1 failed)
  ├─ run_2026..._a  claude  ready    src/foo.ts, src/bar.ts
  ├─ run_2026..._b  codex   ready    src/foo.ts
  └─ run_2026..._c  gemini  failed   (test failed)
```

### 6.5 `status`

`portico status <group_id>` 展示 group 摘要 + 各 child 一行；`portico status <child_id>`
展示单个 child 详情并标注其所属 group。

## 7. 个体 Resume（迭代修复）

借鉴 Claude Agent SDK 的 resume 能力（`agentId` + session 续跑）：fan-out 后某个 child 失败，
直接续跑那个 child，而不是整组重来。

### 7.1 捕获 session

Portico 的 `/chat` 路径已经支持 Claude 的 `--resume` 会话续接（见 README「Sessions」）。
delegation run 目前是一次性的、不捕获 session。Phase 2 增加：

1. 在 `runSingleDelegation` 消费 agent 事件时（`orchestrator.ts:333-342`），从 adapter 的
   `start` 事件里读取原生 `sessionId`（Claude 的 stream-json 适配器已经产出该字段），写入
   child run 的 `agentSessionId`。
2. 对暂不支持 resume 的 adapter（如当前的 Codex），`agentSessionId` 为空，resume 命令对其
   返回明确的 `resume_unsupported` 错误。

### 7.2 resume 命令

```bash
portico delegate --resume <child_id> --task "tests are failing on X, fix them"
```

行为：

1. 读取 child run 及其 worktree。**前置条件**：worktree 仍存在（即 cleanup 策略没有把它删掉；
   resume 与 `cleanup: always/onSuccess` 互斥，需在文档中说明，或在创建时若调用方意图 resume
   则强制 `cleanup: manual`）。
2. 校验 `agentSessionId` 非空且目标 adapter 支持 resume。
3. 在该 worktree 里以 resume 模式再次调用 agent（如 `claude --resume <sessionId>`），把新的
   `--task` 作为后续指令。
4. 重新生成 diff、重跑测试、刷新 report 与 result。
5. child 状态回到 `ready` / `failed`；若该 child 属于某 group，触发 group 状态重算。

### 7.3 与 group 的关系

resume 作用于单个 child，但会更新其 group 的聚合状态。这让「fan-out → 个别失败 → 单独修复 →
组重新评估」成为一个闭环，避免昂贵的整组重跑。

## 8. CLI / HTTP 接口变更

### 8.1 CLI

```bash
# fan-out（异构）：每个 --child 一段 JSON 或重复 flag
portico delegate --repo . --task "<group task>" \
  --child '{"to":"claude","permissionProfile":"auto-edit"}' \
  --child '{"to":"codex"}' \
  --child '{"to":"gemini","model":"..."}'

# 兼容旧 compare 写法（内部归一化为 children）
portico delegate --mode compare --to claude --compare-to codex --repo . --task "..."

# 生命周期
portico apply  <group_id> --child <child_id>
portico cancel <group_id>          # 级联
portico discard <group_id>         # 级联
portico runs                       # 折叠视图，--flat 平铺
portico status <group_id|child_id>

# 个体迭代
portico delegate --resume <child_id> --task "..."
```

`--child` 的 JSON 解析要给出清晰的错误信息（字段名拼写、未知字段警告）。也可提供更友好的
简写（如 `--child to=codex,model=...`），实现时择一。

### 8.2 HTTP（daemon）

- `POST /delegate`：body 接受 `children: ChildSpec[]` 与 `maxParallel`；兼容
  `compareTargets`。
- `GET /runs`：返回折叠结构（child 挂在 group 下），`?flat=true` 平铺。
- `GET /runs/:id`：group id 返回 group 摘要 + child 摘要列表。
- `POST /runs/:id/apply`：body 接受 `{ child?: string }`。
- `POST /runs/:id/cancel`、`POST /runs/:id/discard`：group id 触发级联。
- 新增（resume）：`POST /runs/:id/resume`，body `{ task: string }`，对 child id 生效。

> 路由实现集中在 `packages/daemon/src/routes.ts`；保持现有鉴权与 CORS 策略不变。

## 9. 安全与一致性

1. **apply 仍永远人工触发**，且 group apply 必须显式指定 child，杜绝「一键 apply 一组竞争实现」
   这种语义不清的操作。
2. **apply 前清洁工作树检查**沿用现状（`assertTrackedTreeClean`，`orchestrator.ts:722`）。
3. **级联取消/丢弃**要保证幂等：对已结束的 child 再次取消/丢弃不报错。
4. **lineage 一致性**：group 的 `childRunIds` 与各 child 的 `groupId` 必须在创建时一次性写好；
   并行环境下 child run.json 各自独立文件、id 唯一（`newRunId`，`orchestrator.ts:480`），
   无写冲突。
5. **resume 的 worktree 前置条件**要在创建 group 时就根据 cleanup 策略校验或调整，避免 resume
   时才发现 worktree 已被清理。

## 10. 测试计划

### 10.1 数据模型与归一化

1. `compareTargets` → `children` 归一化正确；旧入参产出与 Phase 1 一致的行为。
2. 显式 `children` 异构配置（不同 to / permissionProfile / model）正确透传到各 child run.json。
3. 旧 run.json（无 `role`）读取时按 `single` 处理，不报错。

### 10.2 聚合状态

1. 全 ready → group ready。
2. 部分 ready 部分 failed → group `partial`。
3. 全 failed → group failed；全 cancelled → group cancelled。
4. 运行中查询 group status 能拿到中间态。

### 10.3 生命周期

1. `apply group` 不带 child → 报错并提示用法。
2. `apply group --child <id>` → 该 child 的 diff 被 apply，group 置 applied。
3. `apply group --child <非本组 child>` → 报错。
4. `cancel group` → 所有活跃 child 被 abort，无孤儿进程；幂等。
5. `discard group` → 所有 child worktree 删除，artifacts 保留。
6. `runs` 折叠视图正确把 child 挂在 group 下；`--flat` 平铺正确。

### 10.4 Resume

1. Claude child（有 `agentSessionId`）resume → 在原 worktree 续跑、重测、刷新 result，
   状态正确更新，group 聚合重算。
2. Codex child（无 session 支持）resume → 返回 `resume_unsupported`。
3. worktree 已被清理时 resume → 返回明确错误。

### 10.5 回归

1. Phase 1 的并行行为不回归。
2. `npm test` 与 `npm run typecheck` 全绿。

## 11. 里程碑

### Milestone 1：数据模型与 lineage

目标：

1. `Run` 增加 lineage 字段；新增 `ChildSpec`、`partial` 状态、`childResults`。
2. `delegate()` 入口实现 `compareTargets` / `children` 归一化。
3. `runGroupDelegation` 写 group run、child 写 lineage。

验收标准：10.1 通过；group 与 child 的父子关系可双向导航。

### Milestone 2：聚合状态机

目标：

1. 实现实时 + 收尾两处聚合。
2. group result.json / report.md 含 `groupSummary` 与子 run 链接。

验收标准：10.2 通过。

### Milestone 3：生命周期命令适配

目标：

1. `apply`（apply-one）、`cancel`（级联）、`discard`（级联）。
2. `runs`（折叠 / `--flat`）、`status`（group / child）。
3. daemon 路由与 CLI 参数到位。

验收标准：10.3 通过。

### Milestone 4：个体 Resume

目标：

1. delegation run 捕获 `agentSessionId`。
2. `portico delegate --resume <child_id>` 与 `POST /runs/:id/resume`。
3. resume 后 group 状态重算。

验收标准：10.4 通过。

### Milestone 5：异构 fan-out 与收尾

目标：

1. `--child` 异构配置端到端可用（不同 agent/权限/模型）。
2. 更新 `docs/delegation.md`、`docs/daemon-api.md`、`README.md`、`docs/roadmap/roadmap.md`。
3. 全量回归 10.5。

验收标准：异构 fan-out 可跑通；文档与 roadmap 更新；全绿。

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 旧 run.json / result.json 不兼容新字段 | 全部新增字段可选；`role` 缺省 single；`compareResults` 读写双认 |
| group/child 状态不一致（实时聚合并发写） | 聚合只在 group run.json 上单点写；child 各自独立文件 |
| apply 一组竞争实现语义不清 | group apply 强制 `--child`，不提供 apply-all（留给 Phase 3 split） |
| resume 时 worktree 已被清理 | 创建时按 cleanup 策略校验；resume 前显式检查并给出明确错误 |
| Codex 等不支持 resume | `agentSessionId` 为空时返回 `resume_unsupported`，不静默失败 |

## 13. 完成定义（Definition of Done）

1. Group Run 模型与 lineage 落地，列表可折叠、父子可导航。
2. 聚合状态机（含 `partial`）实时 + 收尾两路正确。
3. `apply`（apply-one）/ `cancel` / `discard` / `runs` / `status` 全部理解 group。
4. per-child 异构 fan-out 可用。
5. 子 run 个体 resume 可用（支持的 adapter）。
6. 全量测试与 typecheck 全绿；文档与 roadmap 更新。
