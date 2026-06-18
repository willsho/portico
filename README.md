# Portico

> Portico is a local Agent runtime bridge and delegation router for web,
> desktop, CLI, and local coding-agent workflows.

Portico lets a Web App, Electron app, desktop tool, or CLI connect to the AI Agents a
user has **already installed on their machine** — Codex, Claude Code, and others — through
one uniform interface. It discovers installed Agent CLIs, detects versions and
capabilities, normalizes their wildly different invocation styles behind adapters, and
streams their output — text, reasoning, and tool calls — as one unified event type.

Portico also lets local coding agents delegate tasks to each other through a controlled
localhost daemon. Delegated work runs in an isolated git worktree, produces durable
artifacts (`diff.patch`, `report.md`, `result.json`, `events.ndjson`), can run configured
tests, and requires an explicit user action before a patch is applied back to the main
working tree.

The name is the architectural one: a portico is the entryway between the outside world
and the inside of a building. Portico is the entryway between your app and the user's
local Agents. It is **not** the host app and **not** the Agent — it is the doorway between
them.

## What Portico is and isn't

**It is** infrastructure for: discovering local Agents, abstracting their invocation,
exposing a localhost daemon so browsers can reach them, a small SDK for fast integration,
and a local delegation workflow for reviewable patches.

**It is not** (at least in phase one): a task platform, a project/issue/PR system, a cloud
orchestrator, a multi-tenant permission system, an Agent marketplace, and it is not bound
to any one host app's data model.

The first problem it solves:

> The host app provides context and a user message; Portico finds a suitable local Agent,
> launches it, and streams the output back.

The delegation problem it now also solves:

> One local coding agent delegates a bounded task to another local coding agent; Portico
> runs it in a separate worktree and returns a tested, reviewable patch.

## Packages

| Package            | For                     | Role                                                        |
| ------------------ | ----------------------- | ----------------------------------------------------------- |
| `@portico/core`    | Node / Electron / CLI   | In-process discovery, child-process runner, unified events  |
| `@portico/adapters`| Provider authors        | Per-provider adapters (generic-cli, codex, claude, …)       |
| `@portico/orchestrator` | Local delegation  | Run store, worktrees, artifacts, tests, apply/discard flow   |
| `@portico/daemon`  | Web apps / browsers     | Localhost HTTP/NDJSON server in front of core               |
| `@portico/client`  | Web / Electron / Node   | `health` / `listAgents` / streaming `chat`, error handling  |
| `@portico/cli`     | Everyone                | daemon, discovery, delegation, runs, apply/discard          |

## Requirements & setup

- **Node.js 20+** (developed on Node 24). Portico's TypeScript runs directly via Node's
  native type stripping — **there is no build step**. The only dev dependencies are
  `typescript` (typecheck) and `@types/node`.

```bash
npm install        # links the workspace packages
npm test           # 65 tests across all packages
npm run typecheck  # tsc --noEmit over the monorepo
```

## Quickstart (no real Agent required)

A fake Agent binary ships in `test/fixtures/fake-agent.mjs` so you can exercise the whole
chain immediately. Point any provider's env path at it:

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"

# See what Portico discovers
npm run portico -- agents

# Start the daemon
npm run portico -- start --port 8799
```

Then, from another terminal:

```bash
curl -s http://127.0.0.1:8799/agents
curl -s -X POST http://127.0.0.1:8799/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"codex","messages":[{"role":"user","content":"hello"}]}'
```

You'll see a stream of NDJSON `RuntimeEvent`s: `start` → `content` deltas → `done`.

## CLI

```bash
portico init
portico start [--host h] [--port p] [--lan --token T] [--allow-origin o] [--config path]
portico stop
portico daemon start
portico daemon stop
portico agents [--json]
portico delegate --to <agent> --repo . --task "<task>" [--test "npm test"]
portico delegate --mode review --to <agent> --repo . --task "<review task>"
portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>"
portico runs [--repo .]
portico status <run_id> [--repo .]
portico cancel <run_id> [--repo .]
portico apply <run_id> [--repo .]
portico discard <run_id> [--repo .]
portico doctor [--config path]
```

`portico doctor` reports Node/platform, config source, login-shell PATH recovery,
per-provider discovery (path, version, status, why-unavailable), port availability, and
the CORS/LAN security posture.

`portico init` creates `.portico/config.json`, `.portico/runs`,
`.portico/worktrees`, and local Portico Skill files for Claude Code and Codex-compatible
agent runtimes.

## Delegation

Delegation is the local-agent-router path: Claude Code, Codex, or another configured
agent asks Portico to hand a coding task to a different local agent. Portico creates a
dedicated git worktree, runs the target agent there, captures logs and events, generates a
diff, runs configured tests, checks whether the delegate changed files outside the
worktree, records telemetry, and leaves the final decision to the user.

Initialize a repo:

```bash
portico init
```

Start the daemon:

```bash
portico daemon start
```

Delegate work:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle to settings" \
  --test "npm test"
```

Inspect and decide:

```bash
portico runs
portico status run_20260617143454_65d33c76
portico apply run_20260617143454_65d33c76
portico discard run_20260617143454_65d33c76
```

Each run writes artifacts under `.portico/runs/<run_id>/`:

- `task.json` — original delegation request
- `events.ndjson` — full delegation event log
- `agent.ndjson` — target agent runtime events
- `test.log` — configured test command output
- `diff.patch` — patch produced from the isolated worktree
- `report.md` — human-readable summary, warnings, telemetry, and next actions
- `result.json` — stable machine-readable run result, including changed files,
  out-of-tree changes, gate warnings, and telemetry

Worktrees live under `.portico/worktrees/<run_id>/`. Portico excludes `.portico/` from the
repo's local git exclude file so artifacts and worktrees do not appear as ordinary
project changes.

Delegation controls in the MVP:

- Default max delegation depth is 1; nested delegation is blocked.
- Default forbidden paths include `.env`, `.ssh/**`, `node_modules/**`, `dist/**`, and
  `build/**`.
- `--allowed` and `--forbidden` constrain changed paths before a run becomes ready.
- `--isolation worktree|shared` controls workspace isolation. Implement runs default to
  `worktree`; review runs default to `shared` plus a read-only permission profile.
- `--base-ref <ref>` chooses the git ref used for isolated worktrees. Use
  `--base-ref defaultBranch` to branch from the repo's default branch when available.
- `--cleanup manual|onNoChanges|onSuccess|always` controls automatic worktree cleanup.
- `--permission-profile default|read-only|auto-edit` controls whether Portico asks the
  provider adapter for autonomous editing. Shared auto-edit runs require a clean working
  tree so Portico can attribute the resulting diff.
- `--mode compare --compare-to <agent>` runs isolated candidate implementations and records
  a parent comparison report with links to each candidate run.
- Test commands come from repeated `--test` flags or `.portico/config.json`
  `testCommands`.
- Worktree runs snapshot the caller's main checkout before and after the agent runs. If
  Portico observes out-of-tree changes, it marks the run failed, emits a
  `sandbox_escape_detected` event, and records `sandboxEscaped` / `outOfTreeChanges` in
  `result.json`.
- Run results include `telemetry` with total, agent, and test durations. When the target
  agent reports usage, Portico preserves the raw usage payload and extracts common token
  and cost fields.
- `apply` requires an explicit command, only applies implement runs, and refuses to run
  when tracked files in the main worktree are dirty.

## Skills

There is a single canonical Skill, [`packages/skills/portico/SKILL.md`](packages/skills/portico/SKILL.md).
`portico init` derives the per-agent variants from it so there's only one body to maintain:

- `.claude/skills/portico/SKILL.md` — the canonical Skill, including the Claude Code
  `allowed-tools` frontmatter.
- `.agents/skills/portico/SKILL.md` — the same Skill with the `allowed-tools` line removed
  for Codex-style loaders.

The Skill does not hard-code a single direction such as Claude → Codex. It tells the
current agent how to write a self-contained delegated task, choose an explicit
`--to <agent>` target (honoring a user-named one, otherwise a different capable local
agent), read the run's report and result, and decide apply vs discard with the user.

## HTTP API (daemon)

| Method & path | Body                | Response                          |
| ------------- | ------------------- | --------------------------------- |
| `GET /health` | –                   | `{ ok, name, version }`           |
| `GET /agents` | –                   | `{ agents: AgentEntry[] }`        |
| `POST /chat`  | `ChatRequest` JSON  | `application/x-ndjson` event stream |
| `POST /delegate` | `DelegateRequest` JSON | `application/x-ndjson` delegation stream |
| `GET /runs?repo=/path` | –          | `{ runs: Run[] }`                 |
| `GET /runs/:id?repo=/path` | –      | `RunDetails`                      |
| `GET /runs/:id/events?repo=/path` | – | `application/x-ndjson` event history |
| `POST /runs/:id/cancel?repo=/path` | – | `RunDetails`                    |
| `POST /runs/:id/apply?repo=/path` | – | `RunDetails`                     |
| `POST /runs/:id/discard?repo=/path` | – | `RunDetails`                   |
| `POST /reload`| –                   | `{ agents: AgentEntry[] }` (re-discover) |
| `GET /sessions` | –                 | `{ sessions: SessionRecord[] }`   |
| `DELETE /sessions/:id` | –          | `{ ok }` (or `404`)               |

`POST /chat` streams one JSON object per line. Agents that speak a structured protocol
(e.g. Claude Code) surface reasoning and tool use as their own events:

```json
{"type":"start","sessionId":"…","provider":"claude"}
{"type":"reasoning","delta":"Let me check the file…"}
{"type":"tool_call","name":"Read","input":{"file_path":"package.json"}}
{"type":"tool_result","name":"Read","output":"…"}
{"type":"content","delta":"The answer is…"}
{"type":"done","message":"…full answer…"}
```

The `start` event's `sessionId` (also returned as the `X-Portico-Session` response header)
is a continuation handle — send it back as `ChatRequest.sessionId` to resume the same
conversation. See [Sessions](#sessions).

## Client SDK

Browser / isomorphic (talks to the daemon):

```ts
import { createPorticoClient } from "@portico/client";

const client = createPorticoClient({ endpoint: "http://127.0.0.1:8787" });
const agents = await client.listAgents();

for await (const event of client.chat({
  provider: "codex",
  context,
  messages: [{ role: "user", content: "Summarize the key risks." }],
})) {
  render(event); // start | content | reasoning | tool_* | error | done
}
```

`chat()` never throws on transport failure — it yields a terminal `error` event so UIs can
**degrade gracefully** when Portico isn't running. `health()` / `listAgents()` throw a typed
`PorticoClientError` (`code: "unreachable" | "http_error" | "bad_response"`).

Node, in-process (no daemon):

```ts
import { createInProcessClient } from "@portico/client/node";
// or go lower level:
import { discoverAgents, runAgent } from "@portico/core";

const agents = await discoverAgents();
for await (const event of runAgent({ provider: "codex", context, messages })) {
  console.log(event);
}
```

## Sessions

A **session** is a continuable conversation with one agent in one working directory.
Portico is stateless by default; pass a `sessionId` to continue a prior turn:

- A `/chat` without a `sessionId` mints a handle, returned on the `start` event and the
  `X-Portico-Session` header.
- Send that handle back as `ChatRequest.sessionId` and Portico resumes the agent's own
  session (e.g. `claude --resume`) — it keeps full context, so you don't re-send history.
- Resume is keyed by `(session, cwd)` and skipped when the previous turn failed (the next
  turn starts fresh). One run per session at a time — a concurrent `/chat` gets `409`.
- `GET /sessions` lists records; `DELETE /sessions/:id` forgets one.

Records live in memory for the daemon's lifetime (file-backed persistence is a planned
switch; Codex resume is not wired yet). Details in
[`docs/session-management-plan.md`](docs/session-management-plan.md).

## Discovery

`discoverAgents()` probes in layers, mirroring how mature local runtimes survive a
GUI-stripped `PATH`:

1. explicit env path (`PORTICO_CODEX_PATH`, `PORTICO_GEMINI_PATH`, `PORTICO_ANTIGRAVITY_PATH`, …)
2. `PATH` lookup
3. login-shell fallback — `$SHELL -lc 'command -v <bin>'` (recovers Homebrew / fnm / nvm /
   volta)
4. `<bin> --version` → semver parse → capability registry

Unparseable versions don't block use: the Agent is still `available` with
`versionStatus: "unknown"`.

## Adapters

Each provider implements one interface; the generic-cli engine lives in core so every
provider has a working fallback.

```ts
export interface AgentAdapter {
  provider: AgentProvider;
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  buildPrompt(request: ChatRequest): Promise<string>;
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent>;
}
```

- **generic-cli** — spawn binary, pass the rendered prompt through stdin or argv, and stream
  stdout as `content`. The universal fallback; currently drives `codex` (`codex exec`),
  `gemini` (`gemini --prompt <prompt>`), `antigravity` (`agy run <prompt>`),
  and `opencode` (`opencode run <prompt>`).
- **stream-json** — parses Claude Code's `claude -p --output-format stream-json
  --include-partial-messages`: token-level `content` / `reasoning` deltas, `tool_call` /
  `tool_result` events, and `--resume`-based session continuity. Drives `claude`.
- **codex** — driven through generic-cli; its structured protocol and resume are deferred
  until the non-interactive contract is confirmed stable.
- **gemini / antigravity / opencode** — driven through generic-cli non-interactive modes.
  Antigravity is discovered as `agy` first, then `antigravity`; `PORTICO_ANTIGRAVITY_PATH`
  can pin an explicit binary. Its persistent CLI settings live under
  `~/.gemini/antigravity-cli/settings.json`, while delegation auto-edit mode passes
  `--dangerously-skip-permissions` as a launch override.
- **openclaw / hermes** — discovery + capability display only; a run ends with a clear
  `adapter_unsupported` error rather than hanging on an interactive CLI.

Register your own with `registerAdapter(myAdapter)`.

## Security model

- Binds to `127.0.0.1` by default. LAN exposure (`--lan` or a non-loopback `--host`) is
  **refused unless a `--token` is set**.
- CORS allows `localhost`/`127.0.0.1` on any port by default; production origins are opt-in
  via `--allow-origin`.
- The child-process runner enforces a timeout watchdog, a max-output cap, cancellation via
  `AbortSignal`, and guaranteed process cleanup.
- Delegation runs execute in isolated git worktrees and generate artifacts before any
  patch is applied to the main working tree. Portico also checks for observed
  out-of-tree writes and fails the run if a delegate modifies the caller's checkout.
- Delegation `apply` is never automatic; it must be triggered by the user and requires a
  clean tracked working tree.
- Portico holds no host-app secrets and never reads host data — it only processes the
  `context` (or short-lived `contextUrl`) handed to it per request.

See [`docs/agent-runtime-library-plan.md`](docs/agent-runtime-library-plan.md) for the full
design, milestones, and roadmap.

## Examples

- [`examples/web`](examples/web) — paste an article, pick a local Agent, and stream the
  answer in the browser with live reasoning, a tool-activity panel, and multi-turn
  follow-ups. `node examples/web/serve.mjs`, then open `http://localhost:5173`.
- [`examples/node-cli`](examples/node-cli) — `node examples/node-cli ask --provider codex
  --file context.md`.

## Project layout

```
packages/{core,adapters,orchestrator,daemon,client,cli} # runtime and delegation packages
packages/skills/portico/SKILL.md                        # unified Portico Skill
examples/{web,node-cli}                                  # runnable integrations
test/fixtures/{fake-agent,edit-agent}.mjs                # Agent stand-ins for tests
docs/agent-runtime-library-plan.md                       # runtime plan
docs/portico-delegation-mvp-plan.md                      # delegation MVP plan
```

## Status

This includes the runtime bridge MVP plus the first delegation MVP: core + adapters +
orchestrator + daemon + client + cli, generic-cli + stream-json engines, structured
Claude streaming (reasoning / tool events / token deltas), in-memory session resume,
isolated delegation worktrees, run artifacts, test logs, patch apply/discard, and unified
Skill instructions. Not yet included: Web UI, MCP server, cloud workers, automatic PRs,
LAN pairing, file-backed session persistence, Codex resume, an Electron auto-installer,
and a cloud relay.

MIT licensed.
