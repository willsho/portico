# Daemon API

The Portico daemon exposes a local HTTP API. JSON endpoints return JSON responses.
Streaming endpoints return newline-delimited JSON.

Default base URL:

```text
http://127.0.0.1:8787
```

## Authentication

If the daemon is configured with a token, every request must include:

```http
Authorization: Bearer <token>
```

Without a configured token, requests are accepted without authentication. LAN exposure is
refused unless a token is configured.

## Error Shape

JSON error responses use:

```json
{
  "error": "Human-readable message.",
  "code": "machine_code"
}
```

Streaming endpoints may either return normal JSON errors before streaming starts or emit
terminal `error` events in the NDJSON stream.

## `GET /health`

Returns daemon health and version.

```bash
curl -s http://127.0.0.1:8787/health
```

Response:

```json
{
  "ok": true,
  "name": "portico",
  "version": "0.1.0"
}
```

## `GET /agents`

Returns discovered agents.

```bash
curl -s http://127.0.0.1:8787/agents
```

Response:

```json
{
  "agents": [
    {
      "provider": "codex",
      "displayName": "Codex",
      "available": true,
      "path": "/usr/local/bin/codex",
      "version": "1.0.0",
      "versionStatus": "ok",
      "protocols": ["app-server", "json-stream", "generic-cli"],
      "source": "path"
    }
  ]
}
```

## `POST /reload`

Re-runs agent discovery and returns the new agent list.

```bash
curl -s -X POST http://127.0.0.1:8787/reload
```

Response:

```json
{
  "agents": []
}
```

## `POST /chat`

Runs one agent turn and streams `RuntimeEvent` objects as NDJSON.

```bash
curl -N http://127.0.0.1:8787/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude",
    "messages": [
      { "role": "user", "content": "Summarize this repo" }
    ],
    "options": {
      "cwd": ".",
      "timeoutMs": 120000
    }
  }'
```

Request shape:

```ts
interface ChatRequest {
  provider: string;
  context?: ContextBundle;
  contextUrl?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  options?: {
    cwd?: string;
    timeoutMs?: number;
    stream?: boolean;
    model?: string;
    maxContextChars?: number;
    maxOutputChars?: number;
    autoEdit?: boolean;
  };
  sessionId?: string;
}
```

Stream event examples:

```json
{"type":"start","sessionId":"...","provider":"claude"}
{"type":"content","delta":"..."}
{"type":"reasoning","delta":"..."}
{"type":"tool_call","name":"Read","input":{"file_path":"README.md"}}
{"type":"tool_result","name":"Read","output":"..."}
{"type":"done","message":"..."}
```

The response also includes:

```http
X-Portico-Session: <session_id>
```

Send that session id on a later request to continue the session when the provider supports
resume and the `cwd` matches.

## `GET /sessions`

Lists in-memory sessions.

```bash
curl -s http://127.0.0.1:8787/sessions
```

Response:

```json
{
  "sessions": [
    {
      "id": "...",
      "provider": "claude",
      "cwd": "/path/to/repo",
      "agentSessionId": "...",
      "status": "active",
      "turns": 1,
      "createdAt": 1760000000000,
      "updatedAt": 1760000000000
    }
  ]
}
```

## `DELETE /sessions/:id`

Deletes a session handle from the in-memory store.

```bash
curl -s -X DELETE http://127.0.0.1:8787/sessions/<session_id>
```

Response:

```json
{
  "ok": true
}
```

## `POST /delegate`

Starts a delegation run and streams `DelegationEvent` objects as NDJSON.

```bash
curl -N http://127.0.0.1:8787/delegate \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "codex",
    "repo": ".",
    "task": "Create delegated.txt",
    "testCommands": ["test -f delegated.txt"]
  }'
```

Request shape:

```ts
interface DelegateRequest {
  from?: string;
  to: string;
  compareTargets?: string[];
  repo: string;
  task: string;
  mode?: "implement" | "review" | "compare";
  isolation?: "worktree" | "shared" | {
    workspace: "worktree" | "shared";
    baseRef?: string;
    cleanup?: "manual" | "onNoChanges" | "onSuccess" | "always";
  };
  baseRef?: string;
  cleanup?: "manual" | "onNoChanges" | "onSuccess" | "always";
  permissionProfile?: "default" | "read-only" | "auto-edit";
  testCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  timeoutMs?: number;
  depth?: number;
}
```

Event examples:

```json
{"type":"run_start","runId":"run_...","status":"created"}
{"type":"worktree_created","runId":"run_...","path":".portico/worktrees/run_...","branch":"portico/run_..."}
{"type":"agent_start","runId":"run_...","agent":"codex"}
{"type":"agent_event","runId":"run_...","event":{"type":"content","delta":"..."}}
{"type":"diff_ready","runId":"run_...","path":".portico/runs/run_.../diff.patch","changedFiles":["delegated.txt"]}
{"type":"test_start","runId":"run_...","command":"npm test"}
{"type":"test_done","runId":"run_...","command":"npm test","status":"passed","exitCode":0}
{"type":"run_done","runId":"run_...","status":"ready","reportPath":"...","resultPath":"..."}
```

`sandbox_escape_detected` is emitted only when a worktree-isolated run changes the
caller's main checkout. Such a run is marked `failed`; the worktree diff remains separate
from the out-of-tree changes.

```json
{"type":"sandbox_escape_detected","runId":"run_...","changes":[{"path":"docs/generated.md","status":"??","raw":"?? docs/generated.md"}]}
{"type":"run_done","runId":"run_...","status":"failed","reportPath":"...","resultPath":"..."}
```

## `GET /runs?repo=<path>`

Lists delegation runs for a repository.

```bash
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)"
```

Response:

```json
{
  "runs": []
}
```

## `GET /runs/:id?repo=<path>`

Returns run details.

```bash
curl -s "http://127.0.0.1:8787/runs/<run_id>?repo=$(pwd)"
```

Response shape:

```ts
interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
}
```

Relevant result shapes:

```ts
interface RunResult {
  run: Run;
  artifacts: RunArtifact;
  changedFiles: string[];
  tests: TestResult[];
  agentEvents: RuntimeEvent[];
  compareResults?: RunResult[];
  sandboxEscaped?: boolean;
  outOfTreeChanges?: OutOfTreeChange[];
  agentGateMismatch?: boolean;
  gateWarnings?: string[];
  telemetry?: RunTelemetry;
  error?: string;
}

interface TestResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationMs?: number;
}

interface OutOfTreeChange {
  path: string;
  status: string;
  raw: string;
}

interface RunTelemetry {
  totalDurationMs: number;
  agentDurationMs?: number;
  testDurationMs: number;
  usage: UsageTelemetry;
}

interface UsageTelemetry {
  available: boolean;
  raw?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  unavailableReason?: string;
}
```

`usage.raw` is the provider-reported usage payload from the terminal agent event. Portico
extracts common token and cost fields when present, but it does not estimate missing
costs.

## `GET /runs/:id/events?repo=<path>`

Returns the stored delegation event log as NDJSON.

```bash
curl -N "http://127.0.0.1:8787/runs/<run_id>/events?repo=$(pwd)"
```

## `POST /runs/:id/apply?repo=<path>`

Applies a ready implementation run.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/apply?repo=$(pwd)"
```

Only `implement` runs can be applied.

## `POST /runs/:id/discard?repo=<path>`

Removes the run worktree and keeps artifacts.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/discard?repo=$(pwd)"
```

## `POST /runs/:id/cancel?repo=<path>`

Cancels an active run.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/cancel?repo=$(pwd)"
```

## CORS

Requests with no `Origin` header are allowed. Browser origins from `localhost`,
`127.0.0.1`, and `[::1]` are allowed by default. Additional origins come from config or
`--allow-origin`.
