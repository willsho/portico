# Security Model

Portico is a local agent bridge. Its safety model is layered: local binding, optional
token auth, CORS checks, child-process limits, workspace isolation, path policy, tests,
durable artifacts, and explicit apply.

It is not a full sandbox for arbitrary code.

## Trust Boundary

Portico runs local agent CLIs already installed on the user's machine. Those CLIs may read
local configuration, use their own credentials, and execute provider-specific behavior.

Portico controls how they are launched and how their output is captured. It does not
rewrite or fully sandbox the provider itself.

## Network Exposure

The daemon binds to loopback by default:

```text
127.0.0.1:8787
```

LAN exposure is refused without a token:

```bash
portico start --host 0.0.0.0 --lan
# refused unless --token or PORTICO_TOKEN is set
```

Safe LAN example:

```bash
portico start \
  --host 0.0.0.0 \
  --lan \
  --token "$PORTICO_TOKEN"
```

Any request must then include:

```http
Authorization: Bearer <token>
```

## CORS

Requests without an `Origin` header are allowed. Browser requests are allowed from:

- `localhost`;
- `127.0.0.1`;
- `[::1]`;
- configured `allowOrigins`;
- any origin if `allowOrigins` contains `*`.

Add a production origin explicitly:

```bash
portico start --allow-origin https://example.internal
```

CORS protects browser callers. It is not authentication; use a token for exposed daemons.

## Child Process Controls

Portico runs providers as child processes and applies:

- timeout watchdog;
- max output cap;
- abort signal cancellation;
- guaranteed cleanup when the stream is abandoned.

Defaults:

```json
{
  "limits": {
    "defaultTimeoutMs": 120000,
    "maxContextChars": 120000,
    "maxOutputChars": 200000
  }
}
```

Delegation requests can set `timeoutMs`.

## Workspace Isolation

Implementation delegation defaults to isolated git worktrees:

```text
.portico/worktrees/<run_id>
```

The target agent edits that worktree. The caller's main checkout is not modified until
the user runs:

```bash
portico apply <run_id>
```

Review delegation defaults to shared workspace plus read-only permission profile. Portico
checks that `git status --porcelain` is unchanged after the run.

Shared auto-edit runs are possible but intentionally explicit:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Directly edit this checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

Portico requires a clean worktree before shared auto-edit runs so the resulting diff can
be attributed to the delegated agent.

## Permission Profiles

Portico controls whether provider-specific autonomous editing flags are requested:

| Profile | Behavior |
| --- | --- |
| `default` | No provider auto-edit flags |
| `read-only` | Read-only run semantics; required for review |
| `auto-edit` | Appends provider auto-edit args when available |

Examples:

| Provider | Auto-edit args |
| --- | --- |
| Codex | `--full-auto` |
| Claude Code | `--permission-mode acceptEdits` |
| Gemini | `--yolo` |
| Antigravity | `--dangerously-skip-permissions` |
| OpenCode | `--dangerously-skip-permissions` |

Provider flags are version-sensitive and may have broader effects inside the execution
workspace. Prefer isolated worktrees for auto-edit.

## Path Policy

Portico rejects runs that change forbidden paths or paths outside an allowed set.

Defaults:

```text
.env
.ssh/**
node_modules/**
dist/**
build/**
```

Request-level controls:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Update the settings UI" \
  --allowed "src/**" \
  --allowed "tests/**" \
  --forbidden "src/secrets/**"
```

Path policy is enforced after diff generation. It does not prevent the child process from
attempting a change, but it prevents a forbidden patch from becoming ready.

## Apply Gate

`apply` is never automatic. It must be requested explicitly:

```bash
portico apply <run_id>
```

Portico refuses to apply when:

- the run is not `ready`;
- the run is not `implement`;
- the patch is missing;
- the main worktree has tracked changes;
- `git apply` fails.

Applied changes are unstaged. The user remains responsible for final review and commit.

## Artifacts and Auditability

Every run writes durable artifacts:

```text
.portico/runs/<run_id>/task.json
.portico/runs/<run_id>/events.ndjson
.portico/runs/<run_id>/agent.ndjson
.portico/runs/<run_id>/diff.patch
.portico/runs/<run_id>/test.log
.portico/runs/<run_id>/report.md
.portico/runs/<run_id>/result.json
```

Reports record workspace isolation, base ref, cleanup policy, permission profile, target
agent, changed files, tests, and next actions.

## What Portico Does Not Guarantee

Portico does not currently guarantee:

- OS-level sandboxing;
- network isolation for provider CLIs;
- secret redaction from provider output;
- prevention of all filesystem reads by providers;
- durable session persistence across daemon restarts;
- automatic security review of generated patches.

Use Portico as a controlled local orchestration layer, not as a hostile-code sandbox.

