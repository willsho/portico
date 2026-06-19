# Portico Roadmap

Status snapshot of what Portico ships today and what is still planned. The full design
lives in [`agent-runtime-library-plan.md`](agent-runtime-library-plan.md) (§18 milestones,
§23 MVP) and [`session-management-plan.md`](session-management-plan.md).

**Current state:** the MVP (plan §23) is complete and verified — core + daemon + client +
adapters + cli, with the generic-cli and stream-json engines, structured Claude streaming,
and in-memory session resume. 63 tests pass; `npm run typecheck` is clean. There is no build
step (Node native type stripping).

Legend: ✅ shipped · 🟡 partial · ⬜ planned · 🔮 later / deferred

---

## Shipped

### M1 — Core library (`@portico/core`) ✅

- Provider / event type definitions (`AgentProvider`, `AgentEntry`, `ChatRequest`, `RuntimeEvent`).
- Agent discovery in layers: explicit env path → `PATH` lookup → login-shell fallback
  (`$SHELL -lc 'command -v'`, recovers Homebrew / fnm / nvm / volta) → `--version` + semver parse.
- Capability registry; unparseable versions stay `available` with `versionStatus: "unknown"`.
- Child-process runner: timeout watchdog, max-output cap, `AbortSignal` cancellation,
  guaranteed process cleanup.
- Generic-CLI engine producing a unified `RuntimeEvent` `AsyncIterable` (`start` → `content` → `done`).
- Context rendering (`ContextBundle` → prompt).

### M2 — Daemon (`@portico/daemon`) ✅

- `portico start` localhost HTTP/NDJSON server.
- `GET /health`, `GET /agents`, `POST /chat` (NDJSON stream), `POST /reload` (re-discover).
- CORS handling, request timeout, and cancellation.

### M3 — Client SDK (`@portico/client`) ✅

- `createPorticoClient` with `health()`, `listAgents()`, streaming `chat()` async iterator.
- `AbortController` support and standardized typed errors (`PorticoClientError`).
- Graceful degradation: `chat()` yields a terminal `error` event instead of throwing on
  transport failure.
- Node in-process client (`@portico/client/node`) — no daemon required.

### M4 — Provider adapters (`@portico/adapters`) 🟡

- **generic-cli** — universal fallback; currently drives `codex` (`codex exec`). ✅
- **stream-json** — Claude Code: token-level `content` / `reasoning` deltas,
  `tool_call` / `tool_result` events, `--resume` session continuity. ✅
- **openclaw / hermes** — discovery + capability display only; runs end with a clear
  `adapter_unsupported` error rather than hanging. ✅
- Per-provider capability display. ✅
- _Remaining:_ Codex structured protocol + Codex resume — see below.

### CLI (`@portico/cli`) ✅

- `portico start` / `portico agents` / `portico doctor`.
- `doctor` reports Node/platform, config source, login-shell PATH recovery, per-provider
  discovery, port availability, and the CORS/LAN security posture.

### Sessions (beyond the original MVP) 🟡

- `SessionRecord` / `SessionStore` model; **in-memory** store. ✅
- Capture → pin the agent's native `session_id`; resume keyed by `(session, cwd)`. ✅
- Poison policy: a failed turn is not resumed (next turn starts fresh). ✅
- In-flight guard: one run per session, concurrent `/chat` gets `409`. ✅
- `GET /sessions` / `DELETE /sessions/:id`; handle on the `start` event and the
  `X-Portico-Session` header. ✅
- `examples/web` retains the handle and renders an accumulating multi-turn transcript. ✅

### Security (partial M5) 🟡

- Binds to `127.0.0.1` by default; LAN exposure refused unless a `--token` is set.
- Bearer-token auth; `--allow-origin` for production origins (localhost/127.0.0.1 allowed by default).
- Child-process safety (timeout, output cap, abort, cleanup); holds no host secrets.

### Examples & tooling ✅

- `examples/web` (paste an article → pick an agent → stream answer with reasoning + tool panel + follow-ups).
- `examples/node-cli` (`ask --provider … --file …`).
- `test/fixtures/fake-agent.mjs` streaming stand-in; 63 tests across all packages.

---

## Planned

### M4 leftovers — Codex parity ⬜

- Codex structured protocol (reasoning / tool events) instead of generic-cli stdout.
- Codex resume via its own session mechanism.
- _Deferred until Codex's non-interactive contract is confirmed stable._

### M5 — LAN & security enhancements 🟡 → ⬜

- ✅ `--lan` mode, bearer token, `--allow-origin`.
- ⬜ Pairing-code flow (初版) — easier LAN device pairing without hand-copying a token.

### Session persistence & ergonomics ⬜

- `FileSessionStore` — JSON at a state path (e.g. `~/.portico/sessions.json`) so sessions
  survive a daemon restart. Same `SessionStore` interface; selected by config.
- `client.conversation()` helper that hides the `sessionId` plumbing (deferred with M4 client work).

### Fan-out — 并行委派与分治协作 🟡

把现有的 `compare` 模式（同一 task、N 个 agent、各自独立 worktree、串行执行）扩展为完整的
fan-out 能力。分三阶段推进，各有独立的开发计划文档：

- **Phase 1 — 并行执行与并发池** ✅ — 见
  [`fanout-phase-1-parallel-execution-plan.md`](../plan/fanout-phase-1-parallel-execution-plan.md)。
  `mergeAsyncIterables` 事件多路复用、`maxConcurrentAgentProcesses` 并发上限、worktree 操作
  串行化，把 `compare` 从串行改为有界并行；对外行为不变，只是更快。已并入 orchestrator 并有
  单测 + 并行/并发上限集成测试覆盖。
- **Phase 2 — Group Run 模型与生命周期** ✅ — 见
  [`fanout-phase-2-group-runs-plan.md`](../plan/fanout-phase-2-group-runs-plan.md)。
  Group Run + lineage（`role`/`groupId`/`parentRunId`）、`partial` 聚合状态、`ChildSpec`
  异构配置（不同 agent/权限/模型）、`apply`(apply-one)/`cancel`/`discard`/`runs` 理解 group、
  子 run 个体 resume（迭代修复）。
- **Phase 3 — 任务分治与 Fan-in 合并** ✅ — 见
  [`fanout-phase-3-split-and-fan-in-plan.md`](../plan/fanout-phase-3-split-and-fan-in-plan.md)。
  `split` 模式、patch 合并（互斥叠加 + integration worktree 三方合并）、`conflict` 状态、
  apply-all、可选 judge 评审（用 Portico 自己的 review child，保持 agent-agnostic）。
  冲突一律中止上报、子 run resume 自动重新合并。

定位：Portico fan-out 覆盖**写侧 / 产 patch / worktree 隔离**的重型并行，与 Claude Agent SDK
subagent / Workflow 的**读侧 / 产文本 / 进程内**轻量 fan-out 互补，可组合使用。

### M6 — Public release ⬜

- npm publish (would need a real build step, e.g. `tsup`, since today there is none).
- Docs site or expanded `docs/`.
- Electron example + auto-installer.

### Later / exploratory 🔮

- Cloud relay (cross-network access without LAN exposure).
- Additional provider adapters as their non-interactive contracts stabilize.

---

## Milestone status at a glance

| Milestone | Scope | Status |
| --- | --- | --- |
| M1 Core library | discovery, runner, generic-cli, events | ✅ done |
| M2 Daemon | start, health/agents/chat/reload, CORS, timeout | ✅ done |
| M3 Client SDK | client, typed errors, async `chat()`, in-process | ✅ done |
| M4 Adapters | generic-cli, stream-json (Claude), detect-only | 🟡 Codex structured/resume left |
| M5 LAN & security | token + LAN refusal done; pairing code | 🟡 pairing left |
| Sessions | in-memory resume done; file store + helper | 🟡 persistence left |
| Fan-out P1 | parallel compare, concurrency pool, event merge | ✅ done |
| Fan-out P2 | group runs, lineage, heterogeneous children, resume | ✅ done |
| Fan-out P3 | split mode, patch merge / conflict, judge | ✅ done |
| M6 Public release | npm publish, Electron example, docs site | ⬜ not started |
| Later | cloud relay | 🔮 exploratory |
