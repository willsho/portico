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
| M6 Public release | npm publish, Electron example, docs site | ⬜ not started |
| Later | cloud relay | 🔮 exploratory |
