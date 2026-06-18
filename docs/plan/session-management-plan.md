# Session management plan

Status: **in progress** — v1 scope is Claude-first, in-memory store with a file-backed
store as a later switch. Codex resume is deferred.

## Problem

Each `/chat` is currently a fresh, stateless agent run: the prompt re-renders the full
`messages[]` every time and the agent keeps no memory across requests. We want **follow-up
turns** where the agent actually retains its own context, without Portico becoming a task
platform.

## What we borrow from Multica (and what we don't)

Multica's agent-session design has four transferable ideas:

1. **Capture → Pin** — the agent generates a native `session_id`; the daemon persists it as
   soon as it appears so a later turn can resume.
2. **Resume pointer** — that id is threaded back into the next run as a `--resume <id>` CLI arg.
3. **Poison detection** — a conversation that ended badly (loop / abnormal output) is *not*
   resumed; the next turn starts fresh.
4. **Persistence** — the session→agent mapping is stored durably.

We **drop** Multica's task-platform machinery — task queue, polling/claiming, retry/backoff,
orphaned-task recovery, and worktree creation/cleanup. Portico has no task entity; those are
the host app's job.

## Verified facts (real `claude` v2.1.178)

These shaped the design and were checked end to end, not assumed:

- The native `session_id` arrives on the stream-json `system`/`init` line.
- `claude -p --resume <id>` continues the conversation **with full memory** (it recalled a
  secret token set in a prior, separate process).
- **Resume is keyed by `(session_id, cwd)`**: resuming the same id from a different working
  directory fails — Claude stores each session's transcript per project directory. This is
  exactly why Multica pins `work_dir`, so Portico pins `cwd` too.

## Definition

> A **session** is a continuable conversation with one agent, in one working directory.

It is not a task, not a job, not a queue entry.

## Data model — `@portico/core`

```ts
type SessionStatus = "active" | "interrupted" | "ended";

interface SessionRecord {
  id: string;               // Portico handle (UUID), stable across turns
  provider: string;
  cwd?: string;             // second half of the resume key — must match to resume
  agentSessionId?: string;  // captured native id (the resume pointer); pinned after init
  status: SessionStatus;    // active = resumable, interrupted = last turn failed → fresh
  turns: number;
  createdAt: number;
  updatedAt: number;
}
```

## Pluggable persistence — `SessionStore`

```ts
interface SessionStore {
  create(input: { id?: string; provider: string; cwd?: string }): SessionRecord;
  get(id: string): SessionRecord | undefined;
  pinAgentSession(id: string, agentSessionId: string): void;  // the "Pin"
  setStatus(id: string, status: SessionStatus): void;
  touch(id: string): void;                                    // turns++ / updatedAt
  list(): SessionRecord[];
  delete(id: string): boolean;
}
```

- **`createInMemorySessionStore()`** — default. Continuity within a daemon run.
- **`FileSessionStore`** (deferred switch) — JSON at a state path (e.g. `~/.portico/sessions.json`)
  so sessions survive a daemon restart and can be listed. Same interface; the daemon picks one
  by config. Multica uses a DB; a file fits Portico's zero-infra ethos.

## Plumbing — `@portico/core`

- `ChatRequest.sessionId?: string` — the handle the client wants to continue (absent = new).
- `RunContext` gains:
  - `sessionId?` — stamped onto the `start` event (else a per-run UUID).
  - `resumeSessionId?` — when set and the provider supports resume, continue that agent session.
  - `onAgentSession?(agentSessionId)` — called once when the engine first sees the native id (the capture hook → daemon pins).
- `AgentProvider.resumeArgs?(agentSessionId): string[]` — provider-defined resume flags
  (`claude: id => ["--resume", id]`). Keeps the engine provider-agnostic; a provider without
  it simply can't resume.
- **stream-json engine**: `start.sessionId = ctx.sessionId ?? randomUUID()`; on `system`/`init`
  call `ctx.onAgentSession`; if `ctx.resumeSessionId` and `provider.resumeArgs`, append the
  resume args. The new prompt still streams in on stdin as the next turn.
- The generic-cli engine also honors `ctx.sessionId` for `start` (so the Portico id is
  consistent across providers) but does not capture/resume — that's how Codex stays "later".

## Orchestration — `@portico/daemon`

The daemon owns one `SessionStore` and the policy. On `POST /chat`:

1. **Resolve/create** the record from `request.sessionId` (unknown/evicted id → recreate under
   the same handle; none → `create`).
2. **In-flight guard** — one run per session; a concurrent `/chat` for the same id gets `409`
   (`session_busy`). This is Portico's analog of worktree isolation: one transcript, one writer.
3. **Resume vs fresh** — resume only when `status === "active"`, an `agentSessionId` is pinned,
   and `cwd` matches; otherwise run fresh and realign `cwd`.
4. Run with `ctx.sessionId = record.id` and `ctx.onAgentSession = pin`.
5. **Terminal handling** — clean `done` → `status = active`, `turns++`; any `error` →
   `status = interrupted` (next turn starts fresh).
6. Return the handle: it's already in `start.sessionId`, plus an `X-Portico-Session` header.

New endpoints: `GET /sessions` (list) and `DELETE /sessions/:id` (forget).

### Poison policy

| Outcome | Next turn |
| --- | --- |
| clean `done` | resume |
| any `error` (timeout / output cap / spawn fail / agent error / cancel) | fresh session |

Simpler than Multica's per-code table, same intent: never resume a half-written or looping
transcript. Can be refined later (e.g. treat `cancelled` as resumable).

## Worktree isolation

Portico does **not** create worktrees. The caller chooses `cwd` (which may be a git worktree).
Portico's contribution: it pins `cwd` to the session and refuses to resume across a `cwd`
change (resume is cwd-keyed), and the in-flight guard prevents two concurrent runs on one
transcript. A host app that wants isolation gives each session its own directory.

## Client

No client-package change for v1: the handle is already on the `start` event, so the web
example reads `start.sessionId` and resends it. A stateful `client.conversation()` helper that
hides the id plumbing is a nice-to-have (deferred with M4).

## Milestones

1. **core** — `SessionRecord` / `SessionStore` / in-memory store; type threading; engine
   capture + resume. Unit tests. ✅ scope
2. **claude adapter** — `resumeArgs = id => ["--resume", id]`. ✅ scope
3. **daemon** — record lifecycle, pin, poison, in-flight guard, `start`/header id,
   `/sessions` endpoints. Tests. ✅ scope
4. client `conversation()` helper — *deferred*.
5. **examples/web** — retain `sessionId`, render an accumulating transcript, support follow-up.
   ✅ scope
6. `FileSessionStore` for cross-restart persistence — *deferred switch*.
7. Codex resume (its own session mechanism) — *deferred*.
