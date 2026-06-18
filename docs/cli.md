# CLI Reference

The `portico` CLI starts the daemon, discovers local agents, sends delegation requests,
and manages run artifacts.

From the repository checkout, examples use:

```bash
npm run portico -- <command>
```

When installed as a binary, use:

```bash
portico <command>
```

## Commands

```text
portico init
portico start [options]
portico stop
portico daemon start [options]
portico daemon stop
portico agents [--json]
portico delegate --to <agent> --task <task> [options]
portico runs [options]
portico status <run_id> [options]
portico apply <run_id> [options]
portico cancel <run_id> [options]
portico discard <run_id> [options]
portico doctor [--config <path>]
```

## `portico init`

Initializes Portico metadata in the current git repository:

```bash
portico init
```

Creates:

```text
.portico/config.json
.portico/runs/
.portico/worktrees/
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

`init` must run inside a git repository. Existing skill files are not overwritten.

## `portico start`

Starts the local daemon:

```bash
portico start
```

Options:

| Option | Meaning |
| --- | --- |
| `--host <host>` | Bind host, default `127.0.0.1` |
| `--port <port>` | Bind port, default `8787` |
| `--lan` | Mark the daemon as intentionally exposed beyond loopback |
| `--token <token>` | Bearer token required for requests |
| `--allow-origin <origin>` | Additional allowed CORS origin; repeatable |
| `--config <path>` | Config file path |

Aliases:

```bash
portico daemon start
```

Portico refuses LAN exposure without a token.

If a daemon is already recorded and still running, `portico start` prints
`daemon already running (pid ..., port ..., ...)` and exits successfully.

## `portico stop`

Stops the daemon recorded by the local pid file:

```bash
portico stop
portico daemon stop
```

If the pid file is stale, Portico removes it.

## `portico agents`

Lists discovered agents:

```bash
portico agents
portico agents --json
```

Discovery uses provider defaults, environment path overrides such as
`PORTICO_CODEX_PATH`, PATH lookup, login-shell PATH recovery, and config overrides.

## `portico delegate`

Starts a delegation run:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add the requested feature" \
  --test "npm test"
```

Required:

| Option | Meaning |
| --- | --- |
| `--to <agent>` | Target provider id |
| `--task <task>` | Self-contained task prompt |

Common options:

| Option | Meaning |
| --- | --- |
| `--from <agent>` | Calling/root agent label |
| `--repo <path>` | Repository path; default current directory |
| `--mode implement|review|compare` | Delegation mode; default `implement` |
| `--compare-to <agent>` | Additional compare candidate; repeatable |
| `--test <cmd>` | Test command; repeatable |
| `--allowed <pattern>` | Allowed changed path pattern; repeatable |
| `--forbidden <pattern>` | Forbidden changed path pattern; repeatable |
| `--timeout <ms>` | Agent/test timeout |
| `--json` | Print delegation events as JSON lines |
| `--url <url>` | Daemon URL override |
| `--token <token>` | Bearer token |

Isolation options:

| Option | Meaning |
| --- | --- |
| `--isolation worktree|shared` | Execution workspace |
| `--base-ref <ref>` | Git ref for isolated worktrees |
| `--cleanup manual|onNoChanges|onSuccess|always` | Automatic worktree cleanup policy |
| `--permission-profile default|read-only|auto-edit` | Agent editing permission profile |

Examples:

```bash
portico delegate --mode review --to claude --repo . --task "Review the auth flow"
```

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement the parser fix" \
  --test "npm test"
```

If a worktree-isolated run changes files in the caller's main checkout, human output
prints a `WARNING: sandbox escape detected` block. JSON output includes a
`sandbox_escape_detected` event with the changed paths. Delegate connection failures also
include the daemon URL and a more specific connection, timeout, DNS, or abort reason when
available.

## `portico runs`

Lists runs for a repository:

```bash
portico runs
portico runs --repo .
portico runs --json
```

Each row includes:

```text
run_id    status    target_agent    created_at    task
```

## `portico status`

Shows details for a run:

```bash
portico status <run_id>
portico status <run_id> --json
portico status <run_id> --json --summary
portico status <run_id> --json --fields status,changedFiles,telemetry
```

Human output includes status, target, branch, worktree, report path, changed files,
sandbox escape warnings, gate warnings, telemetry, and test summaries.

`--json` returns `RunDetails` with duplicate nested `result.run` and `result.artifacts`
removed. `--summary` returns a compact top-level object for scripts and LLM callers.
`--fields` selects comma-separated fields from the summary view.

## `portico apply`

Applies a ready implementation run:

```bash
portico apply <run_id>
```

Options:

| Option | Meaning |
| --- | --- |
| `--repo <path>` | Repository path |
| `--json` | Print `RunDetails` as JSON |
| `--url <url>` | Daemon URL override |
| `--token <token>` | Bearer token |

`apply` only works for `implement` runs and requires the main worktree's tracked files to
be clean.

## `portico discard`

Removes a run worktree and keeps artifacts:

```bash
portico discard <run_id>
```

Use this after applying, rejecting, or finishing inspection of a run.

## `portico cancel`

Cancels an in-flight run:

```bash
portico cancel <run_id>
```

Cancellation aborts the tracked process when the run is still active and marks the run
`cancelled`.

## `portico doctor`

Prints diagnostics:

```bash
portico doctor
portico doctor --config ./path/to/config.json
```

The report includes:

- Node and platform;
- config path and loaded status;
- environment config applied;
- login-shell PATH recovery;
- discovered agents;
- port availability;
- CORS and LAN/token posture.
