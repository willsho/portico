# Portico 路线图 (Roadmap)

Portico 当前发布内容及未来计划的状态快照。完整设计位于 [`agent-runtime-library-plan.zh-CN.md`](../plan/agent-runtime-library-plan.zh-CN.md)（第 18 节 里程碑，第 23 节 MVP）和 [`session-management-plan.zh-CN.md`](../plan/session-management-plan.zh-CN.md)。

**当前状态：** MVP（计划第 23 节）已完成并经过验证——核心（core）+ 守护进程（daemon）+ 客户端（client）+ 适配器（adapters）+ 命令行界面（cli），包含 generic-cli 和 stream-json 引擎、结构化的 Claude 流传输以及内存中的会话恢复。63 个测试通过；`npm run typecheck` 干净无错。没有构建步骤（Node 原生类型剥离）。

图例：✅ 已发布 · 🟡 部分完成 · ⬜ 计划中 · 🔮 稍后 / 推迟

---

## 已发布 (Shipped)

### M1 — 核心库 (`@portico/core`) ✅

- 提供商/事件类型定义（`AgentProvider`, `AgentEntry`, `ChatRequest`, `RuntimeEvent`）。
- 分层代理发现：明确的环境变量路径 → `PATH` 查找 → 登录 shell 后备（`$SHELL -lc 'command -v'`，恢复 Homebrew / fnm / nvm / volta） → `--version` + 语义化版本解析。
- 能力注册表；不可解析的版本保持 `available`（可用），状态为 `versionStatus: "unknown"`。
- 子进程运行器：超时看门狗、最大输出上限、`AbortSignal` 取消、保证进程清理。
- Generic-CLI 引擎，生成统一的 `RuntimeEvent` `AsyncIterable`（`start` → `content` → `done`）。
- 上下文渲染（`ContextBundle` → 提示词）。

### M2 — 守护进程 (`@portico/daemon`) ✅

- `portico start` 本地主机 HTTP/NDJSON 服务器。
- `GET /health`、`GET /agents`、`POST /chat`（NDJSON 流）、`POST /reload`（重新发现）。
- CORS 处理、请求超时和取消。

### M3 — 客户端 SDK (`@portico/client`) ✅

- 带有 `health()`、`listAgents()`、流式 `chat()` 异步迭代器的 `createPorticoClient`。
- `AbortController` 支持和标准化的类型化错误（`PorticoClientError`）。
- 优雅降级：在传输失败时，`chat()` 会生成终端 `error` 事件，而不是抛出异常。
- Node 进程内客户端（`@portico/client/node`）——不需要守护进程。

### M4 — 提供商适配器 (`@portico/adapters`) 🟡

- **generic-cli** — 通用后备方案；目前驱动 `codex`（`codex exec`）。✅
- **stream-json** — Claude Code：token 级别的 `content` / `reasoning` 增量，`tool_call` / `tool_result` 事件，`--resume` 会话连续性。✅
- **openclaw / hermes** — 仅发现 + 能力显示；运行以明确的 `adapter_unsupported` 错误结束，而不是挂起。✅
- 逐个提供商的能力显示。✅
- _剩余：_ Codex 结构化协议 + Codex 恢复 —— 见下文。

### 命令行界面 (`@portico/cli`) ✅

- `portico start` / `portico agents` / `portico doctor`。
- `doctor` 报告 Node/平台、配置来源、登录 shell PATH 恢复、逐个提供商的发现、端口可用性以及 CORS/LAN 安全态势。

### 会话 (超出最初的 MVP) 🟡

- `SessionRecord` / `SessionStore` 模型；**内存中（in-memory）**存储。✅
- 捕获 → 固定代理的原生 `session_id`；通过 `(session, cwd)` 进行恢复。✅
- 中毒策略（Poison policy）：失败的轮次不被恢复（下一轮次重新开始）。✅
- 运行中保护（In-flight guard）：每个会话一个运行，并发的 `/chat` 得到 `409`。✅
- `GET /sessions` / `DELETE /sessions/:id`；处理 `start` 事件和 `X-Portico-Session` 头。✅
- `examples/web` 保留句柄并渲染累积的多轮文字记录。✅

### 安全 (部分 M5) 🟡

- 默认绑定到 `127.0.0.1`；除非设置了 `--token`，否则拒绝 LAN 暴露。
- Bearer-token 身份验证；`--allow-origin` 用于生产环境来源（默认允许 localhost/127.0.0.1）。
- 子进程安全（超时、输出上限、中止、清理）；不持有主机机密。

### 示例与工具 ✅

- `examples/web`（粘贴文章 → 选择代理 → 流式回答推理过程 + 工具面板 + 后续跟进）。
- `examples/node-cli`（`ask --provider … --file …`）。
- `test/fixtures/fake-agent.mjs` 流传输替代品；跨所有包有 63 个测试。

---

## 计划中 (Planned)

### M4 遗留 — Codex 对齐 ⬜

- Codex 结构化协议（推理/工具事件）代替 generic-cli 的标准输出。
- 通过其自己的会话机制恢复 Codex。
- _推迟到确认 Codex 的非交互式契约稳定。_

### M5 — LAN 和安全增强 🟡 → ⬜

- ✅ `--lan` 模式、bearer token、`--allow-origin`。
- ⬜ 配对码流程（初版）— 无需手动复制令牌即可更轻松地进行 LAN 设备配对。

### 会话持久化与人体工程学 ⬜

- `FileSessionStore` — 状态路径处的 JSON（例如 `~/.portico/sessions.json`），以便会话在守护进程重启后仍然存在。相同的 `SessionStore` 接口；通过配置选择。
- 隐藏 `sessionId` 管道的 `client.conversation()` 辅助函数（与 M4 客户端工作一起推迟）。

### Fan-out — 并行委派与分治协作 🟡

把现有的 `compare` 模式（同一 task、N 个 agent、各自独立 worktree、串行执行）扩展为完整的 fan-out 能力。分三阶段推进，各有独立的开发计划文档：

- **Phase 1 — 并行执行与并发池 (Phase 1 — Parallel execution and concurrency pool)** ✅ — 见 [`fanout-phase-1-parallel-execution-plan.zh-CN.md`](../plan/fanout-phase-1-parallel-execution-plan.zh-CN.md)。`mergeAsyncIterables` 事件多路复用、`maxConcurrentAgentProcesses` 并发上限、worktree 操作串行化，把 `compare` 从串行改为有界并行；对外行为不变，只是更快。已并入 orchestrator 并有单测 + 并行/并发上限集成测试覆盖。
- **Phase 2 — Group Run 模型与生命周期 (Phase 2 — Group Run model and lifecycle)** ✅ — 见 [`fanout-phase-2-group-runs-plan.zh-CN.md`](../plan/fanout-phase-2-group-runs-plan.zh-CN.md)。Group Run + lineage（`role`/`groupId`/`parentRunId`）、`partial` 聚合状态、`ChildSpec`异构配置（不同 agent/权限/模型）、`apply`(apply-one)/`cancel`/`discard`/`runs` 理解 group、子 run 个体 resume（迭代修复）。
- **Phase 3 — 任务分治与 Fan-in 合并 (Phase 3 — Task split and Fan-in merge)** ✅ — 见 [`fanout-phase-3-split-and-fan-in-plan.zh-CN.md`](../plan/fanout-phase-3-split-and-fan-in-plan.zh-CN.md)。`split` 模式、patch 合并（互斥叠加 + integration worktree 三方合并）、`conflict` 状态、apply-all、可选 judge 评审（用 Portico 自己的 review child，保持 agent-agnostic）。冲突一律中止上报、子 run resume 自动重新合并。

定位：Portico fan-out 覆盖**写侧 / 产 patch / worktree 隔离**的重型并行，与 Claude Agent SDK subagent / Workflow 的**读侧 / 产文本 / 进程内**轻量 fan-out 互补，可组合使用。

### M6 — 公开发布 ⬜

- npm 发布（需要一个真正的构建步骤，例如 `tsup`，因为目前没有）。
- 文档网站或扩展的 `docs/`。
- Electron 示例 + 自动安装程序。

### 稍后 / 探索性 🔮

- 云中继（无 LAN 暴露的跨网络访问）。
- 随着其他提供商非交互式契约的稳定，增加额外的提供商适配器。

---

## 里程碑状态一览

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| M1 核心库 | 发现、运行器、generic-cli、事件 | ✅ 已完成 |
| M2 守护进程 | start、health/agents/chat/reload、CORS、超时 | ✅ 已完成 |
| M3 客户端 SDK | 客户端、类型化错误、异步 `chat()`、进程内 | ✅ 已完成 |
| M4 适配器 | generic-cli、stream-json (Claude)、仅检测 | 🟡 剩余 Codex 结构化/恢复 |
| M5 LAN 与安全 | 令牌 + 拒绝 LAN 已完成；配对码 | 🟡 剩余配对 |
| 会话 (Sessions) | 内存恢复已完成；文件存储 + 辅助函数 | 🟡 剩余持久化 |
| Fan-out P1 | 并行 compare、并发池、事件合并 | ✅ 已完成 |
| Fan-out P2 | group 运行、血统、异构子项、恢复 | ✅ 已完成 |
| Fan-out P3 | split 模式、补丁合并/冲突、裁判 | ✅ 已完成 |
| M6 公开发布 | npm 发布、Electron 示例、文档网站 | ⬜ 未开始 |
| 稍后 | 云中继 | 🔮 探索性 |
