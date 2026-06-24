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
portico agents [--url <url>] [--token <token>] [--json]
portico models [--to <agent>] [--json]
portico profiles list|show [<name>] [--repo .] [--json]
portico delegate --to <agent> --repo . (--task "<task>" | --task-file <path>) [--test "npm test"]
portico delegate --profile <name> --repo . --task "<task>"  # apply a saved preset; flags override it
portico delegate --mode review --to <agent> --repo . --task "<review task>"
portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" --judge-to <agent-c>
portico delegate --mode split --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","task":"backend","allowedPaths":["src/server/**"]}' \
  --child '{"to":"claude","task":"frontend","allowedPaths":["src/web/**"]}'
portico delegate --to <agent-a> --repo . --task "<task>" \
  --child '{"to":"codex","permissionProfile":"auto-edit"}' \
  --child '{"to":"claude","model":"sonnet"}'
portico delegate --resume <child_id> (--task "fix the failing tests" | --task-file feedback.txt)
portico delegate --continue <run_id> (--task "keep going from the current worktree" | --task-file feedback.txt)
portico delegate --to <agent> --repo . --task "<task>" --allowed "src/**" --apply-on-ready  # auto-apply if guards pass
portico delegate --to <agent> --repo . --task "<task>" --detach   # exit at run_start, keep running
portico delegate --to <agent> --repo . --task "<task>" --detach --notify  # OS-notify on terminal state
portico delegate --to <agent> --repo . --task "<task>" --name dark-mode   # human-readable run name
portico delegate --to <agent> --repo . --task "<task>"  # auto-starts a loopback daemon if down (default)
portico delegate --to <agent> --repo . --task "<task>" --no-auto-start  # fail fast instead
portico delegate --mode split --to <agent> --repo . --task "<task>" --child '{...}' --child '{...}' -y  # skip fan-out confirm
portico delegate --follow <run_id>           # re-attach to a detached run's event log
portico runs [--repo .] [--flat] [--status failed,cancelled] [--since 2h] [--watch]
portico watch [--repo .] [--needs-review] [--to <agent>] [--status s1,s2] [--once] [--json]
portico status <run_id> [--repo .]
portico logs <run_id> [--repo .] [--follow]
portico review <group_id> [--ready-only] [--open-diff] [--json]
portico patch-stack <run_id> <run_id>...  # read-only file overlap & apply-order summary
portico integrate <group_id> [--repo .]      # merge a group's ready children into one patch
portico cancel <run_id> [--repo .]
portico apply <run_id> [--repo .]            # single run
portico apply <group_id> --child <child_id>  # compare: pick one candidate
portico apply <group_id> --all               # split/integrated: apply the merged patch
portico discard <run_id> [--repo .]
portico cleanup [--repo .] [--failed] [--older-than 7d] [--purge]  # reclaim finished worktrees
portico doctor [--config path]
```

`portico doctor` reports Node/platform, config source, login-shell PATH recovery,
per-provider discovery (path, version, status, why-unavailable), delegate profiles (with lint
warnings for unknown keys / invalid values), port availability, and the CORS/LAN security posture.

`portico init` creates `.portico/config.json`, `.portico/runs`,
`.portico/worktrees`, example delegate profiles under `.portico/agents/` (`reviewer`,
`implementer`), and local Portico Skill files for Claude Code and Codex-compatible
agent runtimes. Re-running it refreshes those Portico-managed Skill files from the
canonical bundled Skill without overwriting an existing `.portico/config.json`, an existing
profile, or other project-level skills.

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
portico runs --flat
portico runs --status failed,cancelled --since 2h
portico status run_20260617143454_65d33c76
portico logs run_20260617143454_65d33c76 --follow
portico apply run_20260617143454_65d33c76
portico apply <group_id> --child <child_id>
portico integrate <group_id>
portico discard run_20260617143454_65d33c76
portico cleanup --failed --older-than 7d
```

Each run writes artifacts under `.portico/runs/<run_id>/`:

- `task.json` — original delegation request
- `events.ndjson` — full delegation event log
- `agent.ndjson` — target agent runtime events
- `test.log` — configured test command output
- `diff.patch` — patch produced from the isolated worktree
- `report.md` — human-readable summary, Portico observations, warnings, telemetry, and next actions
- `result.json` — stable machine-readable run result, including changed files,
  out-of-tree changes, the `reviewDecision`, gate warnings, and telemetry

Worktrees live under `.portico/worktrees/<run_id>/`. Portico excludes `.portico/` from the
repo's local git exclude file so artifacts and worktrees do not appear as ordinary
project changes.

Delegation controls in the MVP:

- `--profile <name>` applies a reusable **delegate profile** — a named preset stored at
  `.portico/agents/<name>.md` (project, version-controllable) or `~/.portico/agents/<name>.md`
  (user). Its frontmatter fills any of `to` / `mode` / `model` / `effort` / `permissionProfile` /
  `allowed` / `forbidden` / `testCommands` / `idleTimeoutMs` you didn't pass, and its Markdown body
  is prepended to the task as standing instructions. Resolution is CLI-side and only fills unset
  fields, so precedence is explicit flag > profile > config > default; a `--child '{"profile":…}'`
  works the same per child. `portico profiles list` / `show <name>` inspect them; `portico init`
  scaffolds `reviewer` and `implementer` examples. See [docs/delegation.md](docs/delegation.md#delegate-profiles).
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
- `--model <id>` selects the target agent's model (e.g. `opus` or `claude-opus-4-8`) and
  `--effort <level>` its reasoning effort (e.g. `low|medium|high`), where the adapter supports
  them. Portico translates each to the agent's native flag; omit them to use the agent's own
  default. In a fan-out, a child's `model`/`effort` (in its `--child` spec) overrides these.
  An unknown `--model` for an agent with a known catalog is rejected before launch; `--model-force`
  sends a custom id as-is. Run `portico models [--to <agent>]` to see each agent's valid ids
  (claude has a fixed catalog; cursor and opencode are probed live from their CLIs). The model
  and effort a run used are recorded in its `report.md`.
- `--mode compare --compare-to <agent>` runs isolated **competing** candidate
  implementations in parallel (bounded by `maxConcurrentAgentProcesses`, default 4) and
  records a parent group report with links to each candidate run. Apply one candidate with
  `portico apply <group_id> --child <child_id>`.
- `--mode split` divides one task into **complementary** sub-tasks (each child must declare
  its own `task`), runs them in parallel, then merges their patches in an integration
  worktree. Apply the merged patch with `portico apply <group_id> --all`. Overlapping edits
  move the group to a `conflict` status (recorded in `conflicts.json`, never force-merged);
  resuming a child to narrow it re-merges automatically.
- `--merge none|sequential|integration` sets the fan-in merge strategy (defaults: compare →
  `none`, split → `integration`).
- `--judge-to <agent> [--judge-instruction "..."]` adds an optional read-only judge: for
  compare it ranks the candidates and records a `recommendedChildId`; for split it vets the
  merged result with an `approve` / `needs_attention` verdict. The judge never changes apply
  semantics — you still decide.
- `--child '{"to":"agent","permissionProfile":"auto-edit","label":"c1"}'` (repeatable)
  defines heterogeneous child specs with per-child agent, task, permission profile, model,
  effort, and path policy. The old `--compare-to` syntax is normalized into children.
- `--resume <child_id> (--task "new task" | --task-file <path>)` re-runs a child in its existing
  worktree **and native agent session** to iterate on a fix, regenerating the diff and recomputing
  the group status (and, for a split group, re-running the fan-in merge). Requires a stored
  `agentSessionId`.
- `--continue <run_id> (--task "new task" | --task-file <path>)` re-runs a run in its existing
  worktree with a fresh agent session. It does not require or pass `agentSessionId`; continuation
  comes from the partial files already in the worktree plus the new `[continue]` task text.
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
- `integrate <group_id>` merges an implement/split group's **ready** children into one patch
  on demand — useful for a `partial` group (some children failed, some ready) that did not
  auto-merge. On a conflict it records the conflicting files, their source child, and a
  suggested review order; apply the merged result with `apply <group_id> --all`. Compare
  groups are rejected (their children are competing implementations — pick one with `--child`).
- `--iterate-from <run_id>` (delegate) splices a previous run's failure/result summary (top
  risks, failing test/verify output, changed files) into the new task's `## Context` section,
  then launches an ordinary new run — never a continuation. Orthogonal to `--resume`, which
  re-runs a child in its existing worktree/session, and `--continue`, which reuses the worktree
  but starts a fresh agent session.
- `--dry-run` (delegate) lints the task text for a named file, acceptance criteria, and a test
  command, then exits (0 if all three pass, 1 otherwise) — no network call, no worktree.
  `--context <path-or-glob>` / `--context-diff <ref>` (repeatable) deterministically splice file
  contents or a `git diff` into the task before sending, capped at 40,000 combined characters.
- Before any agent launches, `delegate` also runs a fast local agent-availability check
  (no `--version` probes) against every target the request would launch, failing fast with no
  worktree created if one is missing — instead of surfacing as `agent_unavailable` after a
  cold start is already burned.
- Before launching, `delegate` prints a **preflight** to stderr — resolved daemon URL,
  **absolute** repo path (a relative `--repo .` is resolved CLI-side so it can't retarget the
  daemon's cwd), base ref, worktree root, and the agents about to run — and, for a multi-agent
  fan-out at an interactive terminal, asks for confirmation. `-y` / `--yes` skips the prompt;
  it is also skipped for non-interactive (agent-driven / scripted) use.
- `--apply-on-ready` (delegate) auto-applies a single ready run only when every guard holds:
  an explicit `--allowed` boundary, a clean tracked tree, path policy passed, no sandbox
  escape, and all tests + verify checks green. Otherwise it prints the unmet guards and the
  review summary and applies nothing.
- `--detach` (delegate) returns as soon as the run registers, printing its id; the run keeps
  executing on the daemon. Re-attach with `portico delegate --follow <run_id>` (or
  `portico logs <run_id> --follow`).
- `--name <slug>` (delegate) sets a human-readable run name shown in `runs` / `watch` (defaults
  to a slug of the task). Children keep their `--child` label.
- `--notify` (delegate) fires an OS notification when the run reaches a terminal state
  (`ready` / `partial` / `conflict` / `failed`). Pairs with `--detach` — a detached background
  watcher delivers the notification after the foreground process has exited. macOS only for now;
  a no-op elsewhere.
- `delegate` (including `delegate --resume` and `delegate --continue`) auto-starts a loopback daemon and retries once if none is
  reachable — no prior `portico start` needed. Loopback only — LAN/remote daemons are never
  auto-started, so a non-loopback `--url`/`PORTICO_URL` still fails fast. Pass
  `--no-auto-start` to fail fast on loopback too.
- `runs --status <s1,s2>` and `runs --since <dur>` filter the listing server-side; runs with a
  live agent are tagged `[active]`, and group rows show `children <ready>/<total> ready`. `status`
  also reports live progress (phase, whether an agent is still running, and the last recorded event).
- `watch` (or `runs --watch`) is a live status board: it polls the runs list on an interval and
  groups runs by state — decision-needed (`ready`/`partial`/`conflict`) on top, then working, then
  done (older finished runs fold into a `… N more` row; failures stay visible). Select a row and
  press a key to act on it inline (`a` apply, `d` discard, `c` cancel, `f` follow, `r` review,
  `i` integrate, `enter` status); `apply` first shows a one-line guard check and asks to confirm.
  Active rows flag `idle <ago>` (time since the last event); the rightmost column is the run's
  duration — elapsed so far while in flight, the final `startedAt → completedAt` span once done.
  Finish time is preserved across apply/discard, so the duration reflects the run, not the wait.
  `--needs-review` / `--to <agent>` / `--status` / `--since` filter the board. With no TTY (or
  `--once` / `--json`) it prints a single snapshot instead, so it stays scriptable. The board is a
  hand-written ANSI TUI with no extra dependencies; in interactive terminals it uses the alternate
  screen and skips unchanged redraws so refreshes do not fill scrollback. It delegates every action
  to the existing commands — it never relaxes a gate (`apply` still requires a clean tracked tree).
- `cleanup` reclaims finished runs: by default it removes only the worktree and keeps
  artifacts (`report.md` / `diff.patch` / `events.ndjson`); `--purge` also deletes artifacts.
  It targets failed + cancelled runs by default (`--status` to override, `--older-than <dur>`
  to bound by age) and never touches `ready` / `applied` or in-flight runs.

## Skills

There is a single canonical Skill, [`packages/skills/portico/SKILL.md`](packages/skills/portico/SKILL.md).
`portico init` derives the per-agent variants from it so there's only one body to maintain:

- `.claude/skills/portico/SKILL.md` — the canonical Skill, including the Claude Code
  `allowed-tools` frontmatter.
- `.agents/skills/portico/SKILL.md` — the same Skill with the `allowed-tools` line removed
  for Codex-style loaders.

Re-running `portico init` refreshes these two Portico-managed output files from the
canonical Skill. Keep project-specific guidance in separate project-level skills rather
than editing the generated Portico files directly.

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
| `GET /runs?repo=/path&flat=true` | – | `{ runs: Run[] }` (folded by default) |
| `GET /runs/:id?repo=/path` | –      | `RunDetails` (group: + children)  |
| `GET /runs/:id/events?repo=/path` | – | `application/x-ndjson` event history |
| `POST /runs/:id/cancel?repo=/path` | – | `RunDetails` (cascades for groups) |
| `POST /runs/:id/apply?repo=/path` | `{ child? }` | `RunDetails` (child id for groups) |
| `POST /runs/:id/discard?repo=/path` | – | `RunDetails` (cascades for groups) |
| `POST /runs/:id/resume?repo=/path` | `{ task }` | `application/x-ndjson` delegation stream |
| `POST /runs/:id/continue?repo=/path` | `{ task }` | `application/x-ndjson` delegation stream |
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
  `gemini` (`gemini --prompt <prompt>`), `antigravity` (`agy -p -` with stdin),
  `opencode` (`opencode run <prompt>`), and `cursor` (`cursor-agent -p <prompt>`, with
  `--trust` always passed and `--force` as the auto-edit override).
- **stream-json** — parses Claude Code's `claude -p --output-format stream-json
  --include-partial-messages`: token-level `content` / `reasoning` deltas, `tool_call` /
  `tool_result` events, and `--resume`-based session continuity. Drives `claude`.
- **codex** — driven through generic-cli; its structured protocol and resume are deferred
  until the non-interactive contract is confirmed stable.
- **gemini / antigravity / opencode / cursor** — driven through generic-cli non-interactive modes.
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
- The child-process runner enforces a total timeout, an idle watchdog (stops an agent that
  produces no stdout/stderr output for too long — tunable per run with `--idle-timeout`, per
  agent, or via `PORTICO_IDLE_TIMEOUT_MS`), a max-output cap, cancellation via `AbortSignal`,
  and guaranteed process cleanup.
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
test/fixtures/{fake,edit,escape,split,judge}-agent.mjs   # Agent stand-ins for tests
docs/agent-runtime-library-plan.md                       # runtime plan
docs/portico-delegation-mvp-plan.md                      # delegation MVP plan
```

## Status

This includes the runtime bridge MVP plus the first delegation MVP: core + adapters +
orchestrator + daemon + client + cli, generic-cli + stream-json engines, structured
Claude streaming (reasoning / tool events / token deltas), in-memory session resume,
isolated delegation worktrees, run artifacts, test logs, patch apply/discard, parallel
compare fan-out (bounded agent concurrency, serialized worktree bookkeeping), group run
model with lineage roles and aggregate status, per-child heterogeneous fan-out
configuration, individual child resume/iteration, folded run listing, cascade
cancel/discard for groups, and task splitting with fan-in merge (integration-worktree
three-way merge, `conflict` status, apply-all, and an optional agent-agnostic judge). Not
yet included: Web UI, MCP server, cloud workers, automatic PRs, LAN pairing, file-backed
session persistence, Codex resume, an Electron auto-installer, and a cloud relay.

MIT licensed.
