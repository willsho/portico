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
portico delegate --to <agent> (--task <task> | --task-file <path>) [options]
portico runs [options]
portico status <run_id> [options]
portico review <run_id> [options]
portico integrate <group_id> [options]
portico logs <run_id> [options]
portico apply <run_id> [options]
portico cancel <run_id> [options]
portico discard <run_id> [options]
portico cleanup [options]
portico doctor [--config <path>] [options]
```

All commands support the `-h` or `--help` flag to print their specific usage and available options.

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

`init` must run inside a git repository. Existing `.portico/config.json` files are not
overwritten. Portico-managed skill files at the paths above are refreshed from the
canonical bundled Skill on every run; other project-level skills are not touched.

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

Before binding, `start` runs a preflight that surfaces sandbox/permission problems early
instead of letting the first `delegate` fail. If the pidfile location isn't writable the
daemon still starts and serves requests, but `portico stop` and discovery are limited (it
prints a warning saying so). If the current repo's `.portico` / `.git` directories aren't
writable it warns that delegations there will fail to create worktrees, with a hint to grant
write access or run outside the sandbox.

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
| `--task <task>` | Self-contained task prompt (exactly one of `--task` or `--task-file` is required) |
| `--task-file <path>` | Read task prompt from a UTF-8 file or stdin (`-`) |

Common options:

| Option | Meaning |
| --- | --- |
| `--from <agent>` | Calling/root agent label |
| `--repo <path>` | Repository path; default current directory |
| `--mode implement|review|compare|split` | Delegation mode; default `implement` |
| `--compare-to <agent>` | Additional compare candidate; repeatable |
| `--child <json>` | Child spec (JSON); repeatable. `task` required in split mode |
| `--merge none|sequential|integration` | Fan-in merge strategy (split → `integration`, compare → `none`) |
| `--judge-to <agent>` | Optional read-only judge over the candidates / merged result |
| `--judge-instruction <text>` | Override the judge's default review instruction |
| `--resume <child_id>` | Re-run a child in its existing worktree with a new task (requires `--task` or `--task-file`) |
| `--name <slug>` | Human-readable run name shown in `runs` / `watch` (defaults to a slug of the task) |
| `--test <cmd>` | Test command; repeatable |
| `--verify <cmd>` | Verification check, reported separately from tests (e.g. doc/policy checks); repeatable |
| `--allowed <pattern>` | Allowed changed path pattern; repeatable |
| `--forbidden <pattern>` | Forbidden changed path pattern; repeatable |
| `--timeout <ms>` | Agent/test timeout |
| `--expect-no-changes` | Treat a no-change result as acceptable: suppress the implement-mode no-change warning and keep the review decision `approve` |
| `--json` | Print delegation events as JSON lines |
| `--review-summary` | After the run, print a one-click apply command plus a risk summary |
| `--apply-on-ready` | Auto-apply a single ready run when all safety guards pass (opt-in; see below) |
| `--auto-start` | If the loopback daemon isn't running, start it and retry the request once |
| `--detach` | Exit as soon as the run registers, printing its id; the run keeps running on the daemon |
| `--notify` | OS-notify when the run reaches a terminal state (`ready`/`partial`/`conflict`/`failed`); pairs with `--detach`. macOS only for now |
| `-y, --yes` | Skip the fan-out preflight confirmation prompt |
| `--follow <run_id>` | Re-attach to a run's event log (same as `logs --follow`); ignores other run flags |
| `--url <url>` | Daemon URL override |
| `--token <token>` | Bearer token |

Before any agent launches, `delegate` prints a **preflight** to stderr — the resolved daemon
URL, the **absolute** repo path (a relative `--repo .` is resolved CLI-side, so it can never
retarget the daemon's own cwd), the base ref, the worktree root, and the agents about to run.
For a multi-agent fan-out at an interactive terminal it then asks for confirmation, so a wrong
repo or base ref is caught before N agents burn time. Confirmation is skipped with `--yes` and
for non-interactive (agent-driven / scripted) use, and the echo goes to stderr so it never
corrupts a `--json` stdout stream.

`--apply-on-ready` only applies a **single** ready run, and only when every guard holds: you
passed `--allowed` (a path boundary), the main tree's tracked files are clean, path policy
passed, no sandbox escape was detected, and all tests + verify checks passed. If any guard is
unmet it applies nothing and prints the unmet items plus the review summary. `--auto-start` is
loopback-only — LAN/remote daemons are never auto-started.

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
  --test "npm test" \
  --judge-to gemini
```

Split one task into complementary sub-tasks and merge the results:

```bash
portico delegate \
  --mode split \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --child '{"to":"claude","task":"Backend routes","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Login UI","allowedPaths":["src/web/**"]}'
```

Iterate on a single child run in place (re-runs it in its existing worktree, regenerates
the diff, re-runs tests, and recomputes the group):

```bash
portico delegate --resume <child_id> --task "the test fails because X; fix only Y"
# or
cat feedback.md | portico delegate --resume <child_id> --task-file -
```

Resume requires the child's adapter to support native session resume (Claude does;
generic-CLI adapters may not) and the worktree to still exist.

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
portico runs --flat
portico runs --status failed,cancelled
portico runs --since 2h
portico runs --watch
```

By default `runs` shows a folded view with group runs and their children nested. A run's name
(from `--name`, else a slug of the task) leads each row, and group rows show `children
<ready>/<total> ready`:

```text
run_abc_group  fan-out  compare  partial  (children 2/3 ready, 1 failed)
  ├─ run_def_a  claude  ready    a-label
  ├─ run_ghi_b  codex   ready    b-label
  └─ run_jkl_c  gemini  failed
```

A single (non-group) row includes:

```text
run_id    name    status    target_agent    created_at    task
```

`--flat` returns the legacy flat list with every run (groups and children) on its own row.

| Option | Meaning |
| --- | --- |
| `--status <s1,s2>` | Keep only runs whose status is in this comma-separated set |
| `--since <dur>` | Keep only runs created within the window (`90s`, `30m`, `2h`, `1d`; a bare number is seconds) |
| `--watch` | Open the live status board (equivalent to `portico watch`, sharing these filters) |

Runs with a live agent process are tagged `[active]` in the human output.

## `portico watch`

A live status board for runs — the multi-run companion to `runs`. It polls the runs list on an
interval and groups runs by state, surfacing the ones that need a decision at the top:

```bash
portico watch
portico watch --needs-review        # only ready / partial / conflict
portico watch --to codex            # only runs targeting one agent
portico watch --once                # one snapshot, then exit
```

```text
portico watch   3 ready · 1 conflict · 2 active

Needs decision
    ready     dark-mode      codex      add a dark mode toggle             2m
  ● partial   fan-out        codex,…    split · 2/3 ready · 1 failed       1m
    └ ready   backend        codex      implement the API                  1m

Working
  ● running   flaky-test     claude     investigate the flaky checkout…    30s

Done
    applied   sound-effects  codex      export the SFX                     4h
    … 6 more done
```

Groups: decision-needed (`ready`/`partial`/`conflict`) on top, then working, then done. Older
finished runs fold into a `… N more done` row; failures always stay visible.

Select a row with `↑`/`↓` and act on it inline — the board delegates to the existing commands and
never relaxes a gate:

| Key | Action |
| --- | --- |
| `a` | Apply (shows a one-line guard check first, then asks to confirm) |
| `d` / `c` | Discard / cancel (with confirm) |
| `f` | Follow the run's event log |
| `r` / `i` | Review / integrate (group runs) |
| `enter` | Show the run's status (peek) |
| `q` / `esc` | Quit |

| Option | Meaning |
| --- | --- |
| `--needs-review` | Shorthand for `--status ready,partial,conflict` |
| `--to <agent>` | Only runs targeting this agent (keeps a group with a matching child) |
| `--status <s1,s2>` / `--since <dur>` | Same server-side filters as `runs` |
| `--interval <ms>` | Poll interval (default `2000`) |
| `--notify` | OS-notify when a run transitions into a decision-needed or failed state |
| `--once` / `--json` | Print a single snapshot (the default when stdout is not a TTY) and exit |

The board is a hand-written ANSI TUI with no extra dependencies. When stdout is not a TTY (a pipe
or redirect), or with `--once` / `--json`, it prints one snapshot and exits so it stays scriptable.

## `portico status`

Shows details for a run:

```bash
portico status <run_id>
portico status <run_id> --json
portico status <run_id> --json --summary
portico status <run_id> --json --fields status,changedFiles,telemetry
```

Human output includes status, live progress (current phase, whether an agent is still
running, and the last recorded event with its time), target, branch, worktree, report /
events / diff paths, changed files, sandbox escape warnings, gate warnings, telemetry, and
test summaries.

`--json` returns `RunDetails` (including a `progress` object) with duplicate nested
`result.run` and `result.artifacts` removed. `--summary` returns a compact top-level object
for scripts and LLM callers. `--fields` selects comma-separated fields from the summary view.

## `portico review`

Aggregates a group run's children (or a single run) into one review view, so you don't
have to open each child's status, report, and diff by hand:

```bash
portico review <run_id>
portico review <run_id> --ready-only
portico review <run_id> --json
portico review <run_id> --open-diff
```

For each child it shows label, status, changed-file count, test/verify/policy results, an
**apply check**, and the report and diff paths, plus a per-child next action (`apply --child`
when ready, `delegate --resume` when failed). It highlights **overlapping files** changed by
more than one child — the spots that need careful manual merging — and the per-child
`apply ok` / `apply FAILS` flag reports whether that child's own patch applies cleanly to the
group base. The two are complementary: a child can have `overlap: []` yet still `apply FAILS`
(its patch drifted from the base), which the apply check surfaces up front instead of at merge
time. A failing child prints the underlying `git apply` reason.

| Option | Description |
| --- | --- |
| `--ready-only` | Only show children that are ready to apply |
| `--json` | Emit the structured aggregation (children + overlap + applyCheck) |
| `--open-diff` | Also print each shown child's full diff inline |

## `portico integrate`

Merges a group's **ready** children into one patch on demand:

```bash
portico integrate <group_id>
portico integrate <group_id> --json
```

Unlike the automatic split fan-in, `integrate` does not require every child to be ready, so
it can combine a `partial` group (some children failed/cancelled, some resumed to ready) or a
group created with `--merge none`. It reuses the split three-way merge into a fresh
integration worktree:

- On a clean merge it writes the merged group `diff.patch` and reports the apply order; apply
  it with `portico apply <group_id> --all`.
- On a conflict it lists the conflicting files, their source child, the conflict kind
  (`overlap` vs `apply_failure`), the underlying `git apply` reason, and a suggested review
  order, and leaves no appliable merged patch. For `overlap`, narrow a child with
  `delegate --resume`; for `apply_failure`, re-run that child. Then run `integrate` again.

Compare groups are rejected (`integrate_unsupported`) — their children are competing
implementations of the same task, so pick one with `apply <group_id> --child <child_id>`.

## `portico logs`

Streams or follows a run's event log:

```bash
portico logs <run_id>
portico logs <run_id> --follow
portico logs <run_id> --json
```

Prints existing delegation events and agent progress. If `--follow` is specified, it
continues to poll and print new events until the run finishes (`run_done` or
`run_error`). The `--json` flag outputs raw NDJSON events instead of formatted human
output.

## `portico apply`

Applies a ready run:

```bash
portico apply <run_id>                 # single implement run
portico apply <group_id> --child <id>  # compare group: pick one candidate
portico apply <group_id> --all         # split group: apply the merged patch
```

Options:

| Option | Meaning |
| --- | --- |
| `--repo <path>` | Repository path |
| `--child <child_id>` | Apply one candidate of a compare group |
| `--all` | Apply the merged patch of a split group |
| `--json` | Print `RunDetails` as JSON |
| `--url <url>` | Daemon URL override |
| `--token <token>` | Bearer token |

A single run must be `implement`. A compare group requires `--child`; a split or integrated
group uses `--all` (refused while the group is in `conflict` or has no merged patch — run
`portico integrate <group_id>` first). `apply` requires the main worktree's tracked files to
be clean.

## `portico discard`

Removes a run worktree and keeps artifacts:

```bash
portico discard <run_id>
```

Use this after applying, rejecting, or finishing inspection of a run. For a group run,
discard cascades to remove every child worktree (and a split group's integration
worktree); it is idempotent.

## `portico cancel`

Cancels an in-flight run:

```bash
portico cancel <run_id>
```

Cancellation aborts the tracked process when the run is still active and marks the run
`cancelled`. For a group run, cancel cascades to every active child; it is idempotent.

## `portico cleanup`

Reclaims finished runs:

```bash
portico cleanup --failed
portico cleanup --failed --older-than 7d
portico cleanup --status failed,cancelled --purge
```

By default `cleanup` removes only the worktree and **keeps** each run's artifacts
(`report.md` / `diff.patch` / `events.ndjson`) for post-hoc inspection. `ready` / `applied`
runs and anything still in-flight are never touched.

| Option | Meaning |
| --- | --- |
| `--failed` | Target failed + cancelled runs (the default when no `--status` is given) |
| `--status <s1,s2>` | Explicit statuses to reclaim; overrides `--failed` (ready/applied still protected) |
| `--older-than <dur>` | Only runs finished more than this ago (`1h`, `7d`; bare number is seconds) |
| `--purge` | Also delete artifacts, not just the worktree |
| `--json` | Emit the structured `{ cleaned, skipped }` result |

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
