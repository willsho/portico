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
  children?: ChildSpec[];
  maxParallel?: number;
  fanIn?: FanInPolicy;
  repo: string;
  task: string;
  mode?: "implement" | "review" | "compare" | "split";
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

interface ChildSpec {
  to: string;
  task?: string;        // required in split mode (the complementary sub-task)
  permissionProfile?: "default" | "read-only" | "auto-edit";
  model?: string;
  effort?: string;
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  label?: string;
}

interface FanInPolicy {
  // Patch merge strategy. Defaults by mode: compare → "none", split → "integration".
  merge?: "none" | "sequential" | "integration";
  // Optional judge: a read-only review run that evaluates the candidate / merged diffs.
  judge?: { to: string; instruction?: string };
}
```

A split request supplies `mode: "split"` and `children` with a `task` each:

```json
{
  "to": "claude",
  "repo": ".",
  "task": "Add OAuth login end-to-end",
  "mode": "split",
  "children": [
    { "to": "claude", "task": "Backend OAuth routes", "allowedPaths": ["src/server/**"] },
    { "to": "codex", "task": "Login UI", "allowedPaths": ["src/web/**"] }
  ],
  "fanIn": { "merge": "integration", "judge": { "to": "gemini" } }
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

For fan-out groups, the fan-in phase emits its own events on the group id after the
children drain and before the group's `run_done` (`runId` is the group id):

```json
{"type":"fanin_start","runId":"<group_id>","strategy":"merge"}
{"type":"merge_done","runId":"<group_id>","status":"ready"}
{"type":"fanin_start","runId":"<group_id>","strategy":"judge"}
{"type":"judge_done","runId":"<group_id>","recommendedChildId":"run_...","verdict":"approve"}
{"type":"run_done","runId":"<group_id>","status":"ready","reportPath":"...","resultPath":"..."}
```

On a merge conflict the group's `run_done` carries `status: "conflict"`:

```json
{"type":"merge_done","runId":"<group_id>","status":"conflict","conflicts":["src/auth.ts"]}
{"type":"run_done","runId":"<group_id>","status":"conflict","reportPath":"...","resultPath":"..."}
```

## `GET /runs?repo=<path>&flat=true`

Lists delegation runs for a repository. By default returns a folded view
(children nested under their group). Use `?flat=true` for the flat legacy listing.

```bash
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)"
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)&flat=true"
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)&status=failed,cancelled"
curl -s "http://127.0.0.1:8787/runs?repo=$(pwd)&since=7200000"
```

Query parameters:

| Param | Meaning |
| --- | --- |
| `repo` | Repository path (default: daemon cwd) |
| `flat` | `true` for the flat listing (no group folding) |
| `status` | Comma-separated status allow-list (server-side filter) |
| `since` | Only runs created within the last N **milliseconds** |

Response (runs with a live agent carry a transient `_active: true`):

```json
{
  "runs": []
}
```

## `GET /runs/:id?repo=<path>`

Returns run details. For group runs, includes `childRunIds` in the run object
and `childResults` / `groupSummary` in the result.

```bash
curl -s "http://127.0.0.1:8787/runs/<run_id>?repo=$(pwd)"
```

Response shape:

```ts
interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
  // Live progress computed at query time (not persisted).
  progress?: {
    phase: RunStatus;            // mirrors run.status
    active: boolean;             // a live agent controller exists (group: any child)
    lastEvent?: { type: string; at: string };
  };
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
  childResults?: RunResult[];      // canonical (Phase 2)
  compareResults?: RunResult[];    // legacy alias
  groupSummary?: {
    total: number;
    ready: number;
    failed: number;
    cancelled: number;
  };
  // Split groups (Phase 3) — fan-in outcome.
  merge?: {
    strategy: "sequential" | "integration";
    status: "ready" | "conflict";
    integrationWorktree?: string;
  };
  conflicts?: Array<{ file: string; child: string }>;
  judge?: {
    to: string;
    runId?: string;
    recommendedChildId?: string;                                 // compare
    ranking?: Array<{ childId: string; score?: number; note: string }>;
    verdict?: "approve" | "needs_attention";                     // split
  };
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

Applies a ready run. For a compare group, send `{ "child": "<child_id>" }` to apply one
candidate; for a split group, send `{ "all": true }` to apply the merged patch.

```bash
# Apply a single run
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/apply?repo=$(pwd)"

# Apply a child from a compare group
curl -s -X POST "http://127.0.0.1:8787/runs/<group_id>/apply?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"child": "<child_id>"}'

# Apply the merged patch from a split group
curl -s -X POST "http://127.0.0.1:8787/runs/<group_id>/apply?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"all": true}'
```

A single run must be `implement`. A compare group apply without `child` returns an error; an
`all` apply against a compare group, or a group still in `conflict` / without a merged patch,
is refused (run `integrate` first for non-split groups).

## `POST /runs/:id/integrate?repo=<path>`

Merges a group's **ready** children into one patch on demand (implement/split groups; compare
groups are rejected). Reuses the split three-way merge into a fresh integration worktree, and
does not require every child to be ready — so a `partial` group can be combined.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<group_id>/integrate?repo=$(pwd)"
```

Response (`IntegrateResult`):

```ts
interface IntegrateResult {
  details: RunDetails;
  status: "ready" | "conflict";
  order: Array<{ id: string; label?: string }>;   // children merged, in apply order
  conflicts?: Array<{ file: string; child: string }>;  // only on conflict
  mergedDiffPath?: string;                         // only on a clean merge
}
```

On `ready`, apply with `POST /runs/:id/apply` + `{ "all": true }`. On `conflict`, no merged
patch is produced; narrow a child via `resume` and integrate again. Errors: `not_a_group`,
`integrate_unsupported` (compare group), `no_ready_children`.

## `POST /runs/:id/discard?repo=<path>`

Removes the run worktree and keeps artifacts. For group runs, cascades to remove all
child worktrees.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/discard?repo=$(pwd)"
```

## `POST /runs/:id/cancel?repo=<path>`

Cancels an active run. For group runs, cascades to cancel all active children.

```bash
curl -s -X POST "http://127.0.0.1:8787/runs/<run_id>/cancel?repo=$(pwd)"
```

## `POST /runs/:id/resume?repo=<path>`

Re-runs a child run in its existing worktree with a new task. Requires the child to have
a stored `agentSessionId` and the worktree to still exist.

```bash
curl -N "http://127.0.0.1:8787/runs/<child_id>/resume?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"task": "fix the failing test: the assertion at line 42 needs to be updated"}'
```

Streams `DelegationEvent` NDJSON. Regenerates the diff, re-runs tests, refreshes
`report.md` / `result.json`, and recomputes the parent group's status. For a split group it
also re-runs the fan-in merge, so narrowing a child can clear a prior `conflict`.

## `POST /cleanup?repo=<path>`

Reclaims finished runs. By default removes only the worktree and keeps artifacts; ready /
applied and in-flight runs are never touched.

```bash
curl -s -X POST "http://127.0.0.1:8787/cleanup?repo=$(pwd)" \
  -H 'Content-Type: application/json' \
  -d '{"failed": true, "olderThanMs": 604800000, "purge": false}'
```

Request body (all optional):

```ts
interface CleanupBody {
  failed?: boolean;        // target failed + cancelled (default when no status given)
  status?: RunStatus[];    // explicit allow-list; overrides failed
  olderThanMs?: number;    // only runs finished more than this many ms ago
  purge?: boolean;         // also delete artifacts, not just the worktree
}
```

Response (`CleanupResult`):

```ts
interface CleanupResult {
  cleaned: Array<{ id: string; status: RunStatus; worktreeRemoved: boolean; purged: boolean }>;
  skipped: number;         // runs examined but left untouched
}
```

## CORS

Requests with no `Origin` header are allowed. Browser origins from `localhost`,
`127.0.0.1`, and `[::1]` are allowed by default. Additional origins come from config or
`--allow-origin`.
