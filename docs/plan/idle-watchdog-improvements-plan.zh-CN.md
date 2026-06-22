# Portico idle 看门狗改进 开发计划

> 让"静默干活"的委派 agent 不再被 idle 看门狗误杀：把判定信号修正为"任何子进程活动"，
> 暴露 per-run 与 per-agent 的可配置 idle 超时，并在杀之前先告警。

## 1. 背景

`portico delegate` 给每个 run 套了一个 **idle 看门狗**：agent 在 `idleTimeoutMs`（默认
**120s**）内没有"输出"就被判 `agent_stalled` 杀掉。在把 model-selection 委派给 antigravity /
opencode 的过程中，这个机制反复**误杀正在干活的 agent**——它们用自己的工具静默改文件、几乎不往
stdout 打字，于是"没有 stdout"被错判成"卡死"。

### 1.1 现状盘点（带锚点）

- 看门狗实现：`withIdleWatchdog(iterable, idleMs)`（`packages/orchestrator/src/orchestrator.ts:2795`）。
  它包的是 **adapter 产出的 `RuntimeEvent` 流**——`withIdleWatchdog(runAgent(...), request.idleTimeoutMs)`
  （`orchestrator.ts:1493` 的 resume/continue 路径、`orchestrator.ts:1877` 的 `runSingleDelegation`）。
  计时器只在每次 `iterator.next()` 拿到一个 `RuntimeEvent` 时被重置（靠 `Promise.race`）。
- 两个引擎（`packages/core/src/generic.ts`、`packages/core/src/stream-json.ts`）消费
  `spawnStream` 的 `ProcessEvent`（`stdout` / `stderr` / `exit`）。**stderr 只被累积进字符串、
  从不 yield 成 `RuntimeEvent`**，因此 **stderr 上的活动不会重置 idle 计时器**。
- generic-cli 引擎只在有 stdout chunk 时发 `content` 事件；一个静默改文件、不打 stdout 的 agent
  会长时间没有任何 `RuntimeEvent` → 触发看门狗。stream-json 引擎在 `--include-partial-messages`
  下会流式发 delta（claude 如此），所以 chatty agent 不受影响——看门狗本质上是**为会流式输出的
  agent 调的，对静默 edit-agent 不公平**。
- 链路其实已经通了：`DelegateRequest.idleTimeoutMs`（`packages/orchestrator/src/types.ts:104`）
  → 路由默认 `request.idleTimeoutMs ?? limits.idleTimeoutMs`（`packages/daemon/src/routes.ts:179`）
  → orchestrator → 看门狗。**只差 CLI flag 没暴露**。
- 默认值在 `packages/daemon/src/config.ts:45`（`idleTimeoutMs: 120_000`）。**没有**对应的 env 覆盖
  （env 只映射了 HOST/PORT/TOKEN/ALLOW_ORIGIN，见 `config.ts:114-131`）。
- config 的 `limits` **不热加载**：`server.ts` 的 `reload()` 只刷新 agent 注册表，改
  `~/.portico/config.json` 必须**重启 daemon** 才生效。
- 每个 `AgentOverride`（`config.ts:8`）当前只有 `path` / `enabled`，没有 per-agent 的超时。

### 1.2 根因

**"没有 stdout RuntimeEvent" 是 "stalled" 的坏代理。** 真正的"卡死"应该指"子进程在该有动静时
彻底没有任何动静"，而现在的实现把判据窄化成了"adapter 没 yield 事件"，漏掉了 stderr 活动、
长工具调用、以及静默文件编辑这几类"其实在干活"的情形。

## 2. 目标

1. **修正 idle 判据**：任何子进程 I/O（stdout **或** stderr）都重置计时器；可选地把"进行中的
   工具调用""worktree 文件变化"也计为活跃。
2. **暴露可配置项**：per-run `--idle-timeout` CLI flag（含关闭）、per-agent 配置默认、
   `PORTICO_IDLE_TIMEOUT_MS` env、以及（可选）`limits` 热加载。
3. **先告警再杀**：到阈值先发一个可见的 idle 警告，给更大的硬上限再终止，避免一刀切误杀。
4. **不破坏现有行为契约**：默认仍是 120s；chatty agent 的体验不变；只是误杀变少、可控性变强。

非目标：不改 `--timeout`（总时长）语义；不引入对 agent 子进程的 CPU/IO 采样这类重型探针
（worktree 文件心跳是更轻、更准的替代）。

## 3. 设计约束

1. **无 build step**：Node 原生 type stripping 直接跑 TS，新增代码必须是可擦除 TS（erasable-TS）。
2. **零新增运行时依赖**：计时器/心跳都用标准 `setTimeout` / `AsyncIterable`。
3. **引擎保持 provider-agnostic**：活动信号通过已有的 `RunContext` 线程化，引擎只负责"上报活动"，
   看门狗策略集中在 orchestrator。
4. **行为兼容**：默认 `idleTimeoutMs` 仍是 120s；未传 `--idle-timeout` 的 run 行为不变。

## 4. 分期设计

### 第 1 期：暴露 per-run `--idle-timeout`（最小、链路已通）

- `packages/cli/src/commands/delegate.ts`：parseArgs 加 `"idle-timeout": { type: "string" }`；
  请求构造处加 `idleTimeoutMs: parseIdle(values["idle-timeout"])`（照 `timeout` 的写法）。
- 语义：`--idle-timeout 0`（或 `off`）→ 显式置 `0`，看门狗关闭（`withIdleWatchdog` 已对
  `idleMs <= 0` 直接放行，见 `orchestrator.ts:2799`），只靠总 `--timeout` 兜底。
- help 文本补一行；区分它与 `--timeout`（一个是"无动静多久算卡死"，一个是"总时长上限"）。
- 注意区分"用户传了 0"与"用户没传"：没传时仍走路由默认（`routes.ts:179`），传 0 时要原样保留 0
  而不能被 `?? limits.idleTimeoutMs` 覆盖回 120s——`routes.ts` 的默认用的是 `??`，`0` 不会被
  覆盖（`0 ?? x === 0`），但 CLI 侧 `idleTimeoutMs` 字段必须真的写成 `0` 而不是 `undefined`。

测试：`packages/cli/tests/delegate.test.ts` 断言 `--idle-timeout 5000` 与 `--idle-timeout off`
进入请求体的 `idleTimeoutMs`（stub `fetch` 读 body，沿用现有模式）。

### 第 2 期：修正 idle 判据 —— 任何子进程 I/O 都重置（根因，ROI 最高）

核心思路：把"活动信号"从"adapter yield 了 RuntimeEvent"扩展到"子进程产生了任何 stdout/stderr"。

设计（DRY，集中策略）：
1. `RunContext`（`packages/core/src/types.ts:172`，已携带 `signal`/`env`/`onAgentSession`）新增
   可选回调 `onActivity?: () => void`。
2. 两个引擎在消费 `spawnStream` 时，**每收到一个 `stdout` 或 `stderr` chunk 就调
   `context.onActivity?.()`**（`generic.ts`、`stream-json.ts` 的 `for await … spawnStream` 循环里）。
   未提供回调的调用方行为不变。
3. orchestrator 重构 `withIdleWatchdog`：不再只靠 `Promise.race(iterator.next())` 重置，而是维护
   一个由 `onActivity`（以及每个 yield 出去的 RuntimeEvent）共同重置的独立计时器；计时器触发时
   `controller.abort()`（每个 run 已有 `AbortController`，`orchestrator.ts:1855` 附近）杀子进程，
   并向流里发 `agent_stalled` 错误。把这个 `reset` 函数作为 `onActivity` 通过 `runAgent` 的
   `RunContext` 传下去（`runAgent` 已转发 `onAgentSession` 等字段，加一个 `onActivity` 即可）。

效果：往 stderr 打进度日志的 agent 不再被误判；generic-cli 静默 agent 只要有任何 stderr 动静
即视为活跃。

测试：
- core：给 `spawnStream` 的消费路径写单测——构造一个只往 stderr 周期打点、stdout 静默的 fake
  agent（`test/fixtures/` 加一个 `heartbeat-stderr-agent.mjs`，或给现有 fake-agent 加一个
  `--stderr-heartbeat` 模式），断言 `onActivity` 被调用、且短 idle 下不被杀。
- orchestrator：用该 fixture + 一个小于其总时长但大于其打点间隔的 `idleTimeoutMs`，断言 run
  正常完成（不再 `agent_stalled`）；再用一个真正静默挂死的 fixture（已有 `--hang`）断言仍会
  按时 `agent_stalled`。

### 第 3 期：更好的默认（无需每次传 flag）

- **per-agent 配置**：`AgentOverride`（`config.ts:8`）加 `idleTimeoutMs?: number`；路由默认改为
  `request.idleTimeoutMs ?? config.agents[to]?.idleTimeoutMs ?? limits.idleTimeoutMs`
  （`routes.ts:179`）。已知易静默的 agent（antigravity/opencode）在 `~/.portico/config.json` 里
  配一次更长的缰绳即可。
- **env 覆盖**：`resolveConfig`（`config.ts:114` 附近）加 `PORTICO_IDLE_TIMEOUT_MS` →
  `limits.idleTimeoutMs`，与 HOST/PORT 对齐。
- **热加载（可选）**：让 `server.ts` 的 `reload()` 重新 `resolveConfig` 并更新 `limits`，或在
  `doctor` / 文档里明确"改 limits 需重启"。倾向于先做文档说明，热加载作为后续。

测试：config 单测覆盖 per-agent 默认与 env 覆盖的优先级链（CLI > 请求 > per-agent > limits）。

### 第 4 期（可选）：策略与更准的心跳

- **两段式**：到 `idleTimeoutMs` 先发一个 idle **warning**（进事件流 / 复用 `verdict_update`
  形态）让用户看见"agent 安静了 Ns"，到一个更大的硬上限（如 `idleTimeoutMs * N`）再终止。
- **进行中的工具调用视为活跃**：`tool_call` 与其 `tool_result` 之间给额外宽限（agent 在跑可能很长
  的命令）。
- **worktree 文件心跳**：implement-mode（worktree）run 周期性采样 worktree 的 mtime/大小，有变化
  即重置 idle——这是静默 edit-agent 最精准的"活着"信号，直击 antigravity/opencode 的失败模式。
- **启动宽限**：run 开头给更长的首事件宽限（冷启动加载模型 / 索引仓库）。

## 5. 数据流（改后）

```
子进程 stdout/stderr chunk
  → 引擎 onActivity?.()            （第 2 期：任何 I/O 都算活跃）
  → orchestrator 重置 idle 计时器
  （计时器触发 → controller.abort() → 杀子进程 → 发 agent_stalled）

idleTimeoutMs 的取值优先级（第 1、3 期）：
  CLI --idle-timeout  >  请求体 idleTimeoutMs  >  config.agents[to].idleTimeoutMs
  >  PORTICO_IDLE_TIMEOUT_MS / config limits.idleTimeoutMs  >  默认 120s
```

## 6. 测试计划（汇总）

1. CLI：`--idle-timeout <ms>` / `off` 进入请求体（第 1 期）。
2. core：`spawnStream` 消费路径在 stdout/stderr chunk 上触发 `onActivity`（第 2 期）。
3. orchestrator：stderr-only 心跳 agent 在短 idle 下不被杀；`--hang` 静默 agent 仍按时
   `agent_stalled`（第 2 期）。
4. config：优先级链（CLI > 请求 > per-agent > env/limits）（第 3 期）。
5. 回归：`npm run typecheck` 干净、`npm test` 全绿。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| stderr 噪声把"真卡死"也一直续命 | stderr 重置仍受总 `--timeout` 硬上限约束；第 4 期两段式让长时间安静仍可见、可终止 |
| `onActivity` 高频调用带来开销 | 只做一次计时器重置（清/设 `setTimeout`），可忽略；必要时节流到 ≥1s 粒度 |
| `--idle-timeout 0` 关掉看门狗后任务真挂死 | 仍有总 `--timeout` 兜底；help 文本说明二者关系 |
| per-run 0 被路由 `?? limits` 覆盖回 120s | `0 ?? x === 0` 不会被覆盖；CLI 侧确保写出真实 `0` 而非 `undefined`，并加测试 |
| 改 `withIdleWatchdog` 影响 resume/continue 与 single 两条调用路径 | 两处都走同一函数，集中改一处；对两条路径各加集成测试 |

## 8. 完成定义（DoD）

1. `--idle-timeout`（含 `off`）落地并有 CLI 测试。
2. idle 计时器在任何子进程 I/O（stdout/stderr）上重置；stderr-only 心跳 agent 不再误杀，
   `--hang` 仍按时 stalled。
3. per-agent 配置 + env 覆盖 + 明确的优先级链与文档。
4. （若纳入）两段式告警 / 工具调用宽限 / worktree 文件心跳。
5. `npm run typecheck` 与 `npm test` 全绿；companion 文件（SKILL.md / docs / README）同步
   `--idle-timeout` 与配置项。
