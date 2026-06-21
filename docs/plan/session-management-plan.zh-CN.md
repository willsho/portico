# Session management plan

Status: **in progress** — v1 范围是以 Claude 为首的，内存存储，后续将切换为文件后备存储。Codex 恢复被推迟。

## 问题

目前，每个 `/chat` 都是一个全新的、无状态的 agent 运行：每次提示都会重新渲染完整的 `messages[]`，且 agent 在请求之间不保留任何记忆。我们需要**跟进轮次 (follow-up turns)**，让 agent 真正保留自己的上下文，同时又不会使 Portico 变成一个任务平台。

## 我们从 Multica 借鉴什么（和不借鉴什么）

Multica 的 agent-session 设计有四个可迁移的理念：

1. **捕获 → 钉扎 (Capture → Pin)** — agent 生成一个原生的 `session_id`；守护进程在其出现时立即持久化，以便后续轮次能够恢复。
2. **恢复指针 (Resume pointer)** — 该 ID 会作为 `--resume <id>` CLI 参数，在下一次运行时被传回。
3. **毒性检测 (Poison detection)** — 一个以糟糕状态结束（循环 / 异常输出）的对话**不应**被恢复；下一轮重新开始。
4. **持久化 (Persistence)** — session 与 agent 的映射关系会被持久存储。

我们**放弃** Multica 的任务平台机制 — 任务队列、轮询/认领、重试/退避、孤儿任务恢复，以及工作树创建/清理。Portico 没有任务实体；这是宿主应用的职责。

## 已验证事实 (真实 `claude` v2.1.178)

这些事实塑造了设计并经过端到端验证，而非假设：

- 原生 `session_id` 出现在 stream-json 的 `system`/`init` 行上。
- `claude -p --resume <id>` 会**带着完整记忆**继续对话（它能回忆起在先前独立进程中设置的秘密令牌）。
- **恢复操作由 `(session_id, cwd)` 键控**：从不同的工作目录恢复同一个 id 会失败 — Claude 针对每个项目目录分别存储每个会话的对话记录。这正是 Multica 钉扎 `work_dir` 的原因，因此 Portico 也钉扎 `cwd`。

## 定义

> **会话 (session)** 是指在同一个工作目录下，与同一个 agent 进行的可继续的对话。

它不是一个任务，不是一个作业，也不是一个队列条目。

## 数据模型 — `@portico/core`

```ts
type SessionStatus = "active" | "interrupted" | "ended";

interface SessionRecord {
  id: string;               // Portico 句柄 (UUID)，跨轮次保持稳定
  provider: string;
  cwd?: string;             // 恢复键的另一半 — 必须匹配才能恢复
  agentSessionId?: string;  // 捕获的原生 id（恢复指针）；在 init 之后钉扎
  status: SessionStatus;    // active = 可恢复，interrupted = 上一轮失败 → 全新开始
  turns: number;
  createdAt: number;
  updatedAt: number;
}
```

## 可插拔持久化 — `SessionStore`

```ts
interface SessionStore {
  create(input: { id?: string; provider: string; cwd?: string }): SessionRecord;
  get(id: string): SessionRecord | undefined;
  pinAgentSession(id: string, agentSessionId: string): void;  // 即 "Pin"
  setStatus(id: string, status: SessionStatus): void;
  touch(id: string): void;                                    // turns++ / updatedAt
  list(): SessionRecord[];
  delete(id: string): boolean;
}
```

- **`createInMemorySessionStore()`** — 默认。守护进程运行期间保持连续性。
- **`FileSessionStore`** (延后切换) — 在某个状态路径下的 JSON（例如 `~/.portico/sessions.json`），以便会话能够在守护进程重启后存活，且可被列出。相同的接口；守护进程通过配置选择其中之一。Multica 使用数据库；而文件符合 Portico 的零基础设施理念。

## 管道 — `@portico/core`

- `ChatRequest.sessionId?: string` — 客户端想要继续的句柄（缺失 = 新建）。
- `RunContext` 增加：
  - `sessionId?` — 盖在 `start` 事件上（否则按每次运行使用 UUID）。
  - `resumeSessionId?` — 当其被设置且 provider 支持恢复时，继续该 agent 会话。
  - `onAgentSession?(agentSessionId)` — 引擎首次看到原生 id 时调用一次（捕获钩子 → 守护进程钉扎）。
- `AgentProvider.resumeArgs?(agentSessionId): string[]` — 由 provider 定义的恢复参数 (`claude: id => ["--resume", id]`)。使引擎保持与 provider 无关；如果没有它，provider 就单纯无法恢复。
- **stream-json engine**：`start.sessionId = ctx.sessionId ?? randomUUID()`；在 `system`/`init` 时调用 `ctx.onAgentSession`；如果存在 `ctx.resumeSessionId` 和 `provider.resumeArgs`，则附加恢复参数。新提示仍会作为下一轮通过 stdin 流入。
- generic-cli engine 对于 `start` 同样遵守 `ctx.sessionId`（因此 Portico id 在多个 provider 间一致），但不捕获/恢复 — 这正是 Codex 留作“后续”的原因。

## 编排 — `@portico/daemon`

守护进程拥有一个 `SessionStore` 和策略。在 `POST /chat` 时：

1. **解析/创建** 来自 `request.sessionId` 的记录（未知/已驱逐的 id → 在相同句柄下重新创建；没有 → `create`）。
2. **防重入守卫** — 每个会话只允许一个运行；对于同一 id 的并发 `/chat` 会收到 `409` (`session_busy`)。这是 Portico 对工作树隔离的对应机制：一份对话记录，一个写入者。
3. **恢复 vs 全新开始** — 仅当 `status === "active"`、有一个被钉扎的 `agentSessionId`，且 `cwd` 匹配时才恢复；否则全新运行，并重新对齐 `cwd`。
4. 使用 `ctx.sessionId = record.id` 和 `ctx.onAgentSession = pin` 运行。
5. **终态处理** — 干净的 `done` → `status = active`, `turns++`；任何 `error` → `status = interrupted`（下一轮全新开始）。
6. 返回句柄：它已经在 `start.sessionId` 中，再加上一个 `X-Portico-Session` HTTP 头。

新端点：`GET /sessions`（列表）和 `DELETE /sessions/:id`（遗忘）。

### 毒性策略

| 结果 | 下一轮 |
| --- | --- |
| 干净的 `done` | 恢复 |
| 任何 `error`（超时 / 输出上限 / spawn 失败 / agent 错误 / 取消） | 全新会话 |

比 Multica 针对各个代码的配置表更简单，但意图相同：绝不恢复写了一半或者正在死循环的对话记录。后续可做优化（例如将 `cancelled` 视为可恢复）。

## 工作树隔离

Portico **不**创建工作树。调用者选择 `cwd`（可以是一个 git 工作树）。Portico 的贡献在于：它将会话钉扎到 `cwd` 上，并拒绝跨 `cwd` 变更进行恢复（恢复是基于 cwd 的），同时防重入守卫防止在同一个对话记录上进行两次并发运行。如果宿主应用需要隔离，它会为每个会话提供其独立的目录。

## 客户端

v1 中客户端包无需更改：句柄已在 `start` 事件上，因此 web 示例可以读取 `start.sessionId` 并重新发送它。一个能够隐藏 ID 管道的、有状态的 `client.conversation()` 辅助函数是一个锦上添花的功能（与 M4 一同延后）。

## 里程碑

1. **core** — `SessionRecord` / `SessionStore` / 内存 store；类型传递；引擎捕获 + 恢复。单元测试。✅ scope
2. **claude adapter** — `resumeArgs = id => ["--resume", id]`。✅ scope
3. **daemon** — 记录生命周期、钉扎、毒性、防重入守卫、`start`/header id、`/sessions` 端点。测试。✅ scope
4. client `conversation()` 辅助函数 — *deferred*。
5. **examples/web** — 留存 `sessionId`，渲染累加的对话记录，支持跟进。✅ scope
6. 用于跨重启持久化的 `FileSessionStore` — *deferred switch*。
7. Codex resume（其自身的会话机制） — *deferred*。
