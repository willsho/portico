# Portico Fan-out Phase 1：并行执行与并发池 开发计划

> 本文是 Portico fan-out 系列计划的第一篇。后续：
> [Phase 2 — Group Run 模型与生命周期](fanout-phase-2-group-runs-plan.md)、
> [Phase 3 — 任务分治与 Fan-in 合并](fanout-phase-3-split-and-fan-in-plan.md)。

## 1. 背景

Portico 当前已经具备 delegation 闭环（见
[Delegation MVP 计划](portico-delegation-mvp-plan.md)），并且已经存在一个 fan-out 的
雏形：`compare` 模式。`runCompareDelegation`（`packages/orchestrator/src/orchestrator.ts:167`）
会对 `[to, ...compareTargets]` 中的每个目标各起一个独立的 `implement` 子 run，每个子 run
在自己的 git worktree 里执行，最后汇总成一个父级 compare 报告。

但这个雏形有两个结构性限制：

1. **串行执行**：`for (const target of targets)` 循环里用 `for await` 把每个子 run
   *完整跑完*才会启动下一个（`orchestrator.ts:198-233`）。N 个候选实现的总耗时是 N 个 run 的
   *串行之和*，而不是最慢的那个。
2. **并发计费被绕过**：顶层 `delegate()` 只为父 run 占用了一个并发 slot
   （`orchestrator.ts:67-72`），而子 run 是直接调用内部的 `runSingleDelegation`、而非走
   `delegate()` 入口，所以它们不经过 `maxConcurrentRunsPerRepo` 计费。串行时这没有问题，
   一旦改成并行就会同时拉起 N 个 agent 子进程，没有任何上限保护。

Phase 1 的目标是把这个串行 fan-out 改造成**有界并行**，并补上它缺失的并发控制基建。这是
整个 fan-out 能力的地基：Phase 2 的 group 模型、Phase 3 的分治与合并都依赖 Phase 1 提供的
并行调度器和事件多路复用能力。

## 2. Phase 1 目标

在**不改变对外行为契约**的前提下，把 compare 模式从串行执行改为有界并行执行。

具体目标：

1. 新增一个通用的异步迭代器合并工具 `mergeAsyncIterables`，可以把多个
   `AsyncIterable<DelegationEvent>` 以受控并发度合并成一个流。
2. 新增一个 orchestrator 内部的并发池（信号量），限制同时运行的 agent 子进程数量。
3. 串行化 `git worktree add` / `git worktree remove`，避免并发写 `.git/worktrees` 元数据
   时的竞争。
4. 把 `runCompareDelegation` 的串行循环替换为基于上述工具的并行调度。
5. 修复子 run 绕过并发计费的问题：fan-out 的并发由专门的 agent-process 池统一约束。
6. 保证父级 run 的 `run_done` 事件一定在所有子 run 结束之后才发出。

非目标（留给后续 Phase）：

1. 不引入 group/parent run 数据模型（Phase 2）。
2. 不改 `apply` / `cancel` / `runs` 的语义（Phase 2）。
3. 不做任务分治、patch 合并、judge（Phase 3）。
4. 不引入 per-child 异构配置（Phase 2）。

## 3. 设计约束

1. **无 build step**：Portico 用 Node 原生 type stripping 直接运行 TypeScript，新增代码必须
   是可擦除的 TS（erasable-TS），不能引入需要编译的语法。
2. **零新增运行时依赖**：合并工具与并发池都用标准 `Promise` / `AsyncIterable` 实现，不引入
   第三方库。
3. **行为兼容**：`portico delegate --mode compare` 的输入参数、产出 artifacts、事件类型都
   保持不变；唯一可观测的变化是更快，以及事件流中不同 `runId` 的事件会交错出现。
4. **事件已自带 `runId`**：所有 `DelegationEvent` 都带 `runId`（`types.ts:97-107`），
   消费端（CLI / daemon / UI）已经可以按 `runId` 区分来源，因此交错的事件流不需要额外的
   demux 协议。

## 4. 核心机制设计

### 4.1 异步迭代器合并工具 `mergeAsyncIterables`

放在 `packages/orchestrator/src/merge.ts`（或 `@portico/core` 中，若 core 也需要复用）。

签名：

```ts
export interface MergeOptions {
  /** 同时处于活跃状态的源数量上限。默认不限制（Infinity）。 */
  concurrency?: number;
}

/**
 * 把若干个「惰性」异步可迭代源合并成一个流，按事件到达顺序产出。
 * 源以 thunk 形式传入，只有在拿到并发额度后才会被调用（即开始执行），
 * 这样 concurrency 既能限制合并、也能限制源的启动。
 */
export async function* mergeAsyncIterables<T>(
  sources: Array<() => AsyncIterable<T>>,
  options?: MergeOptions,
): AsyncIterable<T>;
```

行为定义：

1. 维护一个活跃迭代器集合，规模不超过 `concurrency`。
2. 每个活跃迭代器持有一个「下一个值」的 promise，用 `Promise.race` 竞速。
3. 某个迭代器产出值时：`yield` 该值，并立即为它重新发起 `next()`（补位）。
4. 某个迭代器 `done` 时：从活跃集合移除，如果还有排队的源，则启动一个新源填补空位。
5. 全部源耗尽后，generator 结束。
6. **错误处理**：`runSingleDelegation` 自身已经在内部 try/catch 中把错误转换成
   `run_error` 事件并正常返回（`orchestrator.ts:409-425`），不会向外抛。因此合并工具的
   常规路径不会收到异常。但为健壮起见，若某个源迭代器仍抛出异常，合并工具应捕获它、不让单个
   源的异常中断整个合并；可选择把异常转成一个终止性事件由调用方处理，或重新抛出（二选一，在
   实现时明确并写测试）。本计划采用**捕获并记录、不中断其他源**的策略。

实现要点（用「带标签的 race」模式）：

```ts
export async function* mergeAsyncIterables(sources, options = {}) {
  const concurrency = options.concurrency ?? Infinity;
  const queue = [...sources];
  const active = new Map(); // iterator -> Promise<{ iterator, result }>

  const pump = (iterator) =>
    iterator.next().then((result) => ({ iterator, result }));

  const start = () => {
    while (active.size < concurrency && queue.length > 0) {
      const it = queue.shift()()[Symbol.asyncIterator]();
      active.set(it, pump(it));
    }
  };

  start();
  while (active.size > 0) {
    const { iterator, result } = await Promise.race(active.values());
    if (result.done) {
      active.delete(iterator);
      start(); // 有空位则补位
      continue;
    }
    active.set(iterator, pump(iterator)); // 该源补位 race
    yield result.value;
  }
}
```

> 注意：上面是设计草图，实现时需补上 `try/catch`（步骤 6 的错误策略）以及对 `return()`
> 的处理——当调用方提前 `break` 出 for-await 时，应调用每个活跃迭代器的 `return()` 做清理，
> 避免泄漏正在运行的子 run。这一点对取消语义很重要，见 4.4。

### 4.2 并发池（agent-process 信号量）

放在 orchestrator 闭包内，作为模块级或 orchestrator 实例级状态。

```ts
function createSemaphore(limit: number) {
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (available > 0) { available--; return; }
      await new Promise<void>((resolve) => waiters.push(resolve));
      available--;
    },
    release() {
      available++;
      waiters.shift()?.();
    },
  };
}
```

引入新的 orchestrator 选项：

```ts
export interface OrchestratorOptions {
  maxDepth?: number;
  maxConcurrentRunsPerRepo?: number;       // 既有：顶层 delegate 调用的并发
  maxConcurrentAgentProcesses?: number;    // 新增：同时运行的 agent 子进程上限，默认 4
  defaultForbiddenPaths?: string[];
}
```

两个上限的语义边界要明确写进文档与代码注释：

- `maxConcurrentRunsPerRepo`：限制**同一 repo 同时进行的顶层 delegate 请求数**（包括一个
  compare/fan-out 父请求算作一个）。沿用现有 `delegate()` 入口的 slot 计费
  （`orchestrator.ts:67-72`），**不改**。
- `maxConcurrentAgentProcesses`：限制**整个 orchestrator 同时拉起的 agent 子进程数**。一个
  fan-out 父请求内部的 N 个子 run 共享这个池。这解决了「单个 fan-out 同时拉起 N 个进程没有
  上限」的问题。

并发池作用在「真正启动 agent」这一步：每个子 run 在调用 `runAgent`
（`orchestrator.ts:333`）之前 `acquire`，在该子 run 结束（成功/失败/取消）后 `release`。

### 4.3 worktree 操作串行化

`git worktree add` / `git worktree remove` / `git worktree prune` 会写
`.git/worktrees/<id>` 元数据并对其加锁，并发执行可能相互竞争甚至报错。Agent 的执行可以并行，
但 worktree 的创建与删除这一步要串行化。

方案：在 orchestrator 内部维护一个 worktree 操作互斥锁（async mutex，可用 `limit=1` 的信号量
复用 4.2 的实现），包裹 `createWorktree`（`orchestrator.ts:626`）和 `removeWorktree`
（`orchestrator.ts:634`）里实际执行 git 命令的部分。

代价极小：worktree add 通常是毫秒级，串行化它不会成为 fan-out 的瓶颈（瓶颈是 agent 执行本身）。

### 4.4 取消语义

合并工具必须正确处理调用方提前终止：

1. 当 daemon/CLI 侧的请求被取消、或调用方 `break` 出 for-await 循环时，`mergeAsyncIterables`
   的 `return()` 被调用，它要对所有活跃子迭代器调用 `return()`。
2. 每个子 run 的 `runSingleDelegation` 内部持有 `AbortController`（注册在 `activeControllers`，
   `orchestrator.ts:318-319`）。`return()` 触发的清理路径要确保对应的 controller 被 abort，
   从而杀掉 agent 子进程并释放并发池额度。
3. Phase 1 不引入 group 级别的「取消整组」命令（那是 Phase 2 的 `cancel(group)`），但要保证
   底层的级联清理路径在 Phase 1 就正确，Phase 2 只是在其上加一个入口。

## 5. `runCompareDelegation` 重构

把现有串行循环（`orchestrator.ts:198-233`）替换为并行调度。重构后结构：

```ts
async function* runCompareDelegation(request, repoPath, context, deps) {
  const targets = [request.to, ...(request.compareTargets ?? [])].filter(Boolean);
  if (targets.length < 2) throw new DelegationError("compare_requires_targets", ...);

  // ... 创建父 run、写 task.json、发 run_start（与现状一致）

  // 为每个 target 构造一个「惰性子 run 源」
  const sources = targets.map((target) => () => {
    const candidateRequest = buildCandidateRequest(request, target); // 同现状
    return runSingleDelegation(candidateRequest, repoPath, context, deps);
  });

  // 并行执行并合并事件流
  const childDoneByRun = new Map();
  for await (const event of mergeAsyncIterables(sources, {
    concurrency: deps.agentSemaphore /* 由并发池约束，见下 */,
  })) {
    yield event; // 直接转发，事件已带 runId
    if (event.type === "run_done" || event.type === "run_error") {
      childDoneByRun.set(event.runId, event);
    }
  }

  // 所有子 run 已结束，读取各自 result.json 汇总（同现状逻辑）
  // ... 计算 failed、写父 result.json、写 report、发父 run_done
}
```

并发约束的接入点二选一（实现时定一种并写注释）：

- **A：合并层限并发** —— `mergeAsyncIterables` 的 `concurrency` 直接设为
  `maxConcurrentAgentProcesses`，由合并工具控制同时启动的子 run 数。简单，但并发额度是
  per-fan-out 的，多个并行 fan-out 之间不共享。
- **B：信号量限并发（推荐）** —— 合并层不限并发（`concurrency: Infinity`），改为在每个子 run
  的 `runSingleDelegation` 内部、`runAgent` 调用前后 `acquire`/`release` 全局
  `agentSemaphore`。这样额度在整个 orchestrator 范围内共享，更准确。

推荐 **B**，因为它让 `maxConcurrentAgentProcesses` 成为真正的全局上限，且为 Phase 2/3 的
group/split 复用同一套池。

`runSingleDelegation` 需要的改动很小：把 `acquire`/`release` 包在 `runAgent` 那段
（`orchestrator.ts:316-342`）外层，并用 `try/finally` 保证 `release`。

## 6. 数据模型变更

Phase 1 **不改** `Run` / `RunResult` / `DelegationEvent` 的结构。

唯一的类型新增是 `OrchestratorOptions.maxConcurrentAgentProcesses`（见 4.2）。

`DelegateRequest` 也不新增字段；compare 的入参保持现状。

> per-child 异构配置（`children: ChildSpec[]`）、`maxParallel` 等入参留到 Phase 2，因为它们
> 与 group 模型一起引入更自洽。

## 7. 事件流与并发的可观测性

1. 父 `run_start` 仍然第一个发出。
2. 各子 run 的 `run_start` / `worktree_created` / `agent_start` / `agent_event` /
   `test_*` / `diff_ready` / `run_done` 会**交错**出现，每个事件带自己的 `runId`。
3. 父 `run_done` 一定最后发出（合并循环结束后）。
4. CLI 渲染：Phase 1 可以先简单按事件到达顺序打印（带 `runId` 前缀）。更友好的「按子 run
   分组的并发进度视图」属于 UI 优化，可放到 Phase 2 随 group 模型一起做。

## 8. 安全与资源控制

1. `maxConcurrentAgentProcesses` 默认值要保守（建议 4），避免在普通开发机上同时拉起过多 agent
   进程导致内存/CPU 打满。该值可由 `.portico/config.json` 配置。
2. 每个子 run 仍在独立 worktree 中执行，路径策略 `enforcePathPolicy`
   （`orchestrator.ts:445`）对每个子 run 独立生效，并行不放松任何隔离。
3. worktree 操作串行化（4.3）避免并发 git 元数据损坏。
4. 取消路径（4.4）保证不会留下「孤儿」agent 子进程或未释放的并发额度。

## 9. 测试计划

新增 / 调整的测试（沿用 `node:test`，放在 `packages/orchestrator/tests/`）：

### 9.1 `mergeAsyncIterables` 单元测试

1. 两个源、各产出若干值 → 合并后产出全部值，数量正确。
2. `concurrency: 1` → 退化为顺序消费（用带延迟的源验证不会并发启动第二个源）。
3. `concurrency: 2`、三个源 → 第三个源只在前两个之一结束后才启动（用计数器验证活跃峰值 ≤ 2）。
4. 某个源中途抛异常 → 不影响其他源继续产出（验证错误策略，见 4.1 步骤 6）。
5. 调用方提前 `break` → 所有活跃源的 `return()` 被调用（验证清理）。

### 9.2 并发池 / 信号量单元测试

1. `acquire` 超过 limit 时阻塞，`release` 后被唤醒。
2. limit=1 时退化为互斥锁。

### 9.3 compare 并行集成测试

复用现有的 fake agent fixture（`test/fixtures/fake-agent.mjs`）。

1. 三目标 compare → 三个子 run 各自产出 result.json，父 report 列出三个候选（行为与现状一致）。
2. **并发性验证**：让 fake agent 故意 sleep 一段固定时间，断言三目标 compare 的总耗时
   显著小于 3×单 run 耗时（证明确实并行）。
3. **并发上限验证**：`maxConcurrentAgentProcesses=2`、三目标 → 通过 fake agent 写时间戳
   /计数文件，断言任意时刻活跃 agent 进程数 ≤ 2。
4. **worktree 不竞争**：三目标并行不出现 `git worktree add` 失败；三个 worktree 都正确创建。
5. **部分失败**：一个目标的 agent 返回错误事件 → 该子 run 状态 failed，父 run 状态 failed，
   其余子 run 仍正常完成（不被牵连）。
6. **取消**：compare 运行中取消请求 → 所有活跃子 run 的 controller 被 abort，无孤儿进程。

### 9.4 回归

1. `npm test` 全绿（现有 65 测试不回归）。
2. `npm run typecheck` 干净。

## 10. 里程碑

### Milestone 1：合并工具与并发池

目标：

1. 实现 `mergeAsyncIterables`（含错误策略与 `return()` 清理）。
2. 实现信号量 `createSemaphore`。
3. 单元测试 9.1、9.2 通过。

验收标准：

1. 合并工具在 `concurrency` 约束下行为正确、可取消、单源异常不牵连其他源。
2. 信号量在超额时阻塞、释放时唤醒。

### Milestone 2：worktree 串行化与子 run 并发计费

目标：

1. 用 `limit=1` 信号量包裹 `createWorktree` / `removeWorktree` 的 git 调用。
2. 在 `runSingleDelegation` 的 `runAgent` 外层接入 `agentSemaphore` 的
   `acquire`/`release`（try/finally）。
3. 新增 `maxConcurrentAgentProcesses` 选项与默认值。

验收标准：

1. 并发创建多个 worktree 不报错。
2. 单测验证同时运行的 agent 子进程数受 `maxConcurrentAgentProcesses` 约束。

### Milestone 3：compare 并行化

目标：

1. 用 `mergeAsyncIterables` 重构 `runCompareDelegation`。
2. 保证父 `run_done` 在所有子 run 之后发出。
3. 集成测试 9.3 通过。

验收标准：

1. compare 对外行为与现状一致（入参、artifacts、事件类型）。
2. 三目标 compare 总耗时显著低于串行之和。
3. 部分失败、取消路径行为正确。

### Milestone 4：收尾

目标：

1. 更新 `docs/delegation.md` / `README.md` 中关于 compare 的描述（标注现在是并行执行）。
2. 更新 `docs/roadmap/roadmap.md`，把 fan-out Phase 1 标为 shipped。
3. 全量回归 9.4。

验收标准：

1. 文档与实际行为一致。
2. `npm test` 与 `npm run typecheck` 全绿。

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 并发 `git worktree add` 损坏元数据 | 4.3 串行化 worktree 操作 |
| fan-out 同时拉起过多 agent 进程打满机器 | 4.2 全局 agent-process 信号量，默认保守值 4 |
| 提前取消留下孤儿子进程 / 未释放额度 | 4.4 `return()` 级联清理 + try/finally release |
| 合并工具吞掉单源异常导致父 run 误判 | 9.1.4 明确错误策略并测试；父 run 仍依据各子 result.json 汇总状态 |
| 事件交错让现有 CLI 输出难读 | Phase 1 接受带 `runId` 前缀的交错输出；分组视图留到 Phase 2 |

## 12. 完成定义（Definition of Done）

1. `mergeAsyncIterables` 与信号量实现完成并有单测。
2. `runCompareDelegation` 改为并行，行为兼容、性能提升可测量。
3. worktree 操作串行化、agent 子进程并发受全局上限约束。
4. 取消路径级联清理正确。
5. `npm test`（含新增测试）与 `npm run typecheck` 全绿。
6. 相关文档与 roadmap 更新到位。
