# Portico

> Portico is a local Agent runtime bridge for web and desktop apps.

Portico lets a Web App, Electron app, desktop tool, or CLI connect to the AI Agents a
user has **already installed on their machine** — Codex, Claude Code, and others — through
one uniform interface. It discovers installed Agent CLIs, detects versions and
capabilities, normalizes their wildly different invocation styles behind adapters, and
streams their output as a single event type.

The name is the architectural one: a portico is the entryway between the outside world
and the inside of a building. Portico is the entryway between your app and the user's
local Agents. It is **not** the host app and **not** the Agent — it is the doorway between
them.

## What Portico is and isn't

**It is** infrastructure for: discovering local Agents, abstracting their invocation,
exposing a localhost daemon so browsers can reach them, and a small SDK for fast
integration.

**It is not** (at least in phase one): a task platform, a project/issue/PR system, a cloud
orchestrator, a multi-tenant permission system, an Agent marketplace, and it is not bound
to any one host app's data model.

The single problem it solves:

> The host app provides context and a user message; Portico finds a suitable local Agent,
> launches it, and streams the output back.

## Packages

| Package            | For                     | Role                                                        |
| ------------------ | ----------------------- | ----------------------------------------------------------- |
| `@portico/core`    | Node / Electron / CLI   | In-process discovery, child-process runner, unified events  |
| `@portico/adapters`| Provider authors        | Per-provider adapters (generic-cli, codex, claude, …)       |
| `@portico/daemon`  | Web apps / browsers     | Localhost HTTP/NDJSON server in front of core               |
| `@portico/client`  | Web / Electron / Node   | `health` / `listAgents` / streaming `chat`, error handling  |
| `@portico/cli`     | Everyone                | `portico start` · `portico agents` · `portico doctor`       |

## Requirements & setup

- **Node.js 20+** (developed on Node 24). Portico's TypeScript runs directly via Node's
  native type stripping — **there is no build step**. The only dev dependencies are
  `typescript` (typecheck) and `@types/node`.

```bash
npm install        # links the workspace packages
npm test           # 36 tests across all packages
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
portico start [--host h] [--port p] [--lan --token T] [--allow-origin o] [--config path]
portico agents [--json]
portico doctor [--config path]
```

`portico doctor` reports Node/platform, config source, login-shell PATH recovery,
per-provider discovery (path, version, status, why-unavailable), port availability, and
the CORS/LAN security posture.

## HTTP API (daemon)

| Method & path | Body                | Response                          |
| ------------- | ------------------- | --------------------------------- |
| `GET /health` | –                   | `{ ok, name, version }`           |
| `GET /agents` | –                   | `{ agents: AgentEntry[] }`        |
| `POST /chat`  | `ChatRequest` JSON  | `application/x-ndjson` event stream |
| `POST /reload`| –                   | `{ agents: AgentEntry[] }` (re-discover) |

`POST /chat` streams one JSON object per line:

```json
{"type":"start","sessionId":"…","provider":"codex"}
{"type":"content","delta":"The strongest counterargument is…"}
{"type":"done","message":"…full answer…"}
```

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

## Discovery

`discoverAgents()` probes in layers, mirroring how mature local runtimes survive a
GUI-stripped `PATH`:

1. explicit env path (`PORTICO_CODEX_PATH`, `PORTICO_CLAUDE_PATH`, …)
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

- **generic-cli** — spawn binary, pipe the rendered prompt to stdin, stream stdout as
  `content`. The MVP basis for `codex` and `claude`.
- **codex / claude** — discovered and driven through generic-cli (`codex exec`,
  `claude -p`). Deeper structured protocols are deferred until their non-interactive
  contracts are confirmed stable.
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
- Portico holds no host-app secrets and never reads host data — it only processes the
  `context` (or short-lived `contextUrl`) handed to it per request.

See [`docs/agent-runtime-library-plan.md`](docs/agent-runtime-library-plan.md) for the full
design, milestones, and roadmap.

## Examples

- [`examples/web`](examples/web) — paste an article, pick a local Agent, stream the answer
  in the browser. `node examples/web/serve.mjs`, then open `http://localhost:5173`.
- [`examples/node-cli`](examples/node-cli) — `node examples/node-cli ask --provider codex
  --file context.md`.

## Project layout

```
packages/{core,adapters,daemon,client,cli}   # the five MVP packages
examples/{web,node-cli}                       # runnable integrations
test/fixtures/fake-agent.mjs                  # streaming Agent stand-in for tests
docs/agent-runtime-library-plan.md            # full development plan
```

## Status

This is the MVP described in the plan's §23: core + daemon + client + adapters + cli, with
a generic-cli adapter and codex/claude discovery. Not yet included: LAN pairing, session
persistence, provider-private advanced protocols, an Electron auto-installer, and a cloud
relay.

MIT licensed.
