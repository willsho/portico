# Delegation

Portico delegation lets one local coding agent hand a bounded task to another local coding
agent through the Portico daemon. The result is a durable run with logs, a report, and, for
implementation work, a reviewable patch.

Delegation is intentionally not a direct agent-to-agent shell-out. Portico owns the run
lifecycle: workspace selection, path policy, testing, artifacts, and apply/discard.

## Quick Start

Start the daemon:

```bash
portico daemon start
```

Delegate an implementation task:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle to settings" \
  --test "npm test"
```

Inspect the result:

```bash
portico runs
portico status <run_id>
```

Apply or discard after review:

```bash
portico apply <run_id>
portico discard <run_id>
```

## Run Lifecycle

Every delegation run moves through the same broad lifecycle:

1. Portico validates the request and finds the target agent.
2. Portico resolves the repository root.
3. Portico prepares the workspace.
4. Portico runs the target agent with a self-contained task prompt.
5. For implementation runs, Portico generates `diff.patch`.
6. Portico enforces path policy.
7. Portico runs configured tests.
8. Portico writes `result.json` and `report.md`.
9. The user decides whether to apply or discard.

The target agent never applies changes back to the caller's main checkout. For isolated
implementation runs, it leaves changes on disk in the run workspace; Portico turns those
changes into a patch.

## Modes

Portico supports three delegation modes:

| Mode | Purpose | Default workspace | Can apply directly? |
| --- | --- | --- | --- |
| `implement` | Produce a patch for a bounded coding task | `worktree` | Yes |
| `review` | Ask another agent to inspect and report | `shared` | No |
| `compare` | Produce multiple candidate implementations | candidate worktrees | No, apply a chosen candidate |

If `mode` is omitted, Portico uses `implement`.

## Artifacts

Each run writes artifacts under `.portico/runs/<run_id>/`:

| Artifact | Meaning |
| --- | --- |
| `task.json` | Original request plus normalized execution settings |
| `events.ndjson` | Portico delegation event stream |
| `agent.ndjson` | Target agent runtime events |
| `diff.patch` | Patch for implementation runs; empty for read-only review runs |
| `test.log` | Output from configured test commands |
| `report.md` | Human-readable summary |
| `result.json` | Stable machine-readable result |

The final `run_done` event includes the `reportPath` and `resultPath`.

## Path Policy

Delegation can constrain what files a run may change:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Update the settings panel" \
  --allowed "src/**" \
  --allowed "tests/**" \
  --forbidden "src/secrets/**"
```

Default forbidden paths are:

```text
.env
.ssh/**
node_modules/**
dist/**
build/**
```

Path policy is enforced after diff generation and before a run becomes ready.

## Tests

Test commands come from repeated `--test` flags or `.portico/config.json`:

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Fix the parser edge case" \
  --test "npm test" \
  --test "npm run typecheck"
```

Tests run in the execution workspace. If a test fails, the run status becomes `failed`, but
the artifacts remain available for diagnosis.

## Apply

Only `implement` runs can be applied:

```bash
portico apply <run_id>
```

`apply` refuses when:

- the run is not `ready`;
- the run mode is not `implement`;
- the run has no `diff.patch`;
- the main worktree has tracked changes;
- `git apply` fails.

Applied changes land in the main worktree as ordinary unstaged file changes. Portico does
not commit them.

## Discard

Discard removes the run worktree and keeps artifacts:

```bash
portico discard <run_id>
```

This is useful after applying a patch, rejecting a patch, or cleaning up failed runs that
you no longer need to inspect in-place.

## Writing Good Delegation Tasks

The delegate gets a fresh process and only the task prompt Portico sends it. Good tasks are
self-contained:

- state the goal;
- name files, directories, or symbols to inspect first;
- define what "done" means;
- mention constraints and files not to touch;
- include verification commands when relevant.

Good:

```text
In src/settings.tsx add a dark-mode toggle wired to the existing useTheme() hook.
Persist the choice in localStorage under "theme". Match existing toggle styling.
Done when the toggle flips the theme and the choice survives a reload.
```

Weak:

```text
add dark mode
```

