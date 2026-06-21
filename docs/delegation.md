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
5. For worktree runs, Portico checks whether the caller's main checkout changed while the
   agent was running.
6. For implementation runs, Portico generates `diff.patch`.
7. Portico enforces path policy.
8. Portico runs configured tests.
9. Portico writes `result.json` and `report.md`.
10. The user decides whether to apply or discard.

The target agent is instructed to leave implementation changes in the run workspace.
Portico turns those changes into a patch. If a worktree-isolated run changes files outside
that workspace, Portico records the out-of-tree changes separately, marks the run failed,
and emits a `sandbox_escape_detected` event.

## Modes

Portico supports four delegation modes:

| Mode | Purpose | Default workspace | Can apply directly? |
| --- | --- | --- | --- |
| `implement` | Produce a patch for a bounded coding task | `worktree` | Yes |
| `review` | Ask another agent to inspect and report | `shared` | No |
| `compare` | Produce multiple **competing** candidate implementations of one task | candidate worktrees | No, apply a chosen candidate via `--child` |
| `split` | Split one task into **complementary** sub-tasks, then merge the results | candidate worktrees | No, apply the merged patch via `--all` |

If `mode` is omitted, Portico uses `implement`.

`compare` and `split` are the two fan-out shapes. They share the same parallel execution
and group model; they differ at the edges:

- **compare** — same task, N children, **mutually exclusive** patches, converge by picking
  one (`apply --child`). Optional judge ranks the candidates.
- **split** — N complementary sub-tasks, **mutually complementary** patches, converge by
  **merging** them into one patch (`apply --all`). Optional judge vets the merged result.

## Group Runs (Fan-out)

When Portico receives `compareTargets` or explicit `children`, it creates a **group run**
that orchestrates multiple **child runs**. Each child runs independently in its own
worktree. The group run has no worktree of its own; its status is derived from its
children.

Group run artifacts live under `.portico/runs/<group_id>/` and include:
- `result.json` with `childResults` (list of per-child `RunResult`) and `groupSummary`
  (`{ total, ready, failed, cancelled }`)
- `report.md` with a candidate-by-candidate table and per-candidate apply instructions

### Heterogeneous Fan-out

Each child can be configured independently:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Add a dark mode toggle" \
  --child '{"to":"codex","label":"codex-impl"}' \
  --child '{"to":"claude","model":"sonnet","permissionProfile":"auto-edit","label":"claude-impl"}'
```

`ChildSpec` fields: `to` (required), `task` (optional, inherits group task), `label`,
`permissionProfile`, `model`, `effort`, `allowedPaths`, `forbiddenPaths`.

The old `--compare-to` syntax is preserved and normalized into children internally.

### Apply a Group Result

Group results contain multiple competing implementations. You must explicitly pick one:

```bash
portico apply <group_id> --child <child_id>
```

Applying a group without `--child` returns an error with usage instructions.

### Cancel / Discard Groups

Both operations cascade to all children:

```bash
portico cancel <group_id>   # cascades cancel to every child
portico discard <group_id>  # removes all child worktrees, keeps artifacts
```

These are idempotent — re-cancelling or re-discarding a finished group is safe.

### Folded Run Listing

`portico runs` shows a folded view with children nested under their groups:

```text
run_abc_group  compare  partial  (3 children: 2 ready, 1 failed)
  ├─ run_def_a  claude  ready    src/foo.ts, src/bar.ts
  ├─ run_ghi_b  codex   ready    src/foo.ts
  └─ run_jkl_c  gemini  failed   (test failed)
```

Use `portico runs --flat` for the legacy flat list.

### Individual Child Resume

To iterate on a failed child without re-running the entire group:

```bash
portico delegate --resume <child_id> --task "the test is failing because of X"
```

This re-runs the child in its existing worktree, capturing a new diff, re-running tests,
and recomputing the parent group's status. Only works when the target adapter supports
native session resume (Claude does; generic-CLI adapters may not) and the worktree still
exists.

## Task Split and Fan-in

`split` mode turns a single large task into N **complementary** sub-tasks, runs them in
parallel like any group, and then **merges** the resulting patches into one. Each child
declares its own `task` (required in split mode) and should scope its changes with
`allowedPaths` to keep the merge clean.

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --mode split \
  --child '{"to":"claude","task":"Implement the OAuth backend routes and token exchange","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Build the login UI and call the new routes","allowedPaths":["src/web/**"]}' \
  --child '{"to":"gemini","task":"Add integration tests for the OAuth flow","allowedPaths":["tests/**"]}'
```

### Fan-in merge

After every child is `ready`, Portico merges their patches into a fresh **integration
worktree** branched from the shared `baseRef`:

- All children derive from the same base, so non-overlapping changes stack cleanly and
  overlapping-but-disjoint edits merge three-way.
- The merged patch is written to the group's `diff.patch`; the group becomes `ready`.
- The integration worktree lives at `.portico/worktrees/<group_id>_integration` and is kept
  for inspection (subject to the group cleanup policy).

The merge strategy is set by `--merge` (or `fanIn.merge` in the API): `none`, `sequential`,
or `integration`. It defaults to `integration` for split and `none` for compare.

### Merge conflicts

When a child's patch cannot be merged, Portico **never force-merges**. It aborts, records the
conflict to `conflicts.json`, leaves any conflict markers in the integration worktree, and
moves the group to a `conflict` status. `apply --all` is refused while a group is in
`conflict`.

The report and `conflicts.json` classify the failure so you know how to fix it:

- **`overlap`** — two children edited the same region (a real three-way merge conflict).
  Narrow one child with `--resume`; Portico re-merges automatically.
- **`apply_failure`** — a single child's *own* patch did not apply to the group base at all
  (drifted context or a malformed diff), even on a file no other child touched. This is why a
  non-overlapping child can still conflict. Re-run that child rather than narrowing it.

`conflicts.json` carries the `kind`, the `failingChild`, the underlying `git apply` `reason`,
the group/child base refs, and the conflicting files (with the first failing `file:line` for
an apply failure). The `report.md` Fan-in Merge section shows the same `Conflict Kind` and
`Git Reason`.

To resolve an `overlap`, narrow one child and let Portico re-merge automatically:

```bash
portico delegate --resume <child_id> --task "stop touching auth.ts; only change the route file"
```

A successful child resume re-runs the fan-in merge; once it is clean the group returns to
`ready`.

### Apply a split result

```bash
portico apply <group_id> --all      # apply the merged patch (every child's contribution)
```

`apply --all` is only valid for a `ready` split group. It is refused for `compare` groups
(use `--child`) and for split groups still in `conflict`. You may still apply a single
contribution of a split group with `--child <child_id>`.

### Fan-in judge

Both fan-out shapes accept an optional **judge** — a read-only `review` run that evaluates
the candidates and writes its verdict into the group's `result.json` and report:

```bash
# compare: rank the candidates and recommend one
portico delegate --to codex --compare-to claude --mode compare \
  --task "Refactor the cache layer" --judge-to gemini

# split: vet the merged result as a whole
portico delegate --to claude --mode split \
  --child '{"to":"claude","task":"...","allowedPaths":["src/a/**"]}' \
  --child '{"to":"codex","task":"...","allowedPaths":["src/b/**"]}' \
  --judge-to gemini
```

The judge is agent-agnostic (any agent that supports `review`), always read-only, and never
changes apply semantics — for compare it highlights a `recommendedChildId`, for split it
records an `approve` / `needs_attention` verdict. **You still make the final decision.**

## Artifacts

Each run writes artifacts under `.portico/runs/<run_id>/`:

| Artifact | Meaning |
| --- | --- |
| `task.json` | Original request plus normalized execution settings |
| `events.ndjson` | Portico delegation event stream |
| `agent.ndjson` | Target agent runtime events |
| `diff.patch` | Patch for implementation runs; empty for read-only review runs |
| `test.log` | Output from configured test commands |
| `report.md` | Human-readable summary, Portico observations, warnings, telemetry, and next actions |
| `result.json` | Stable machine-readable result with changed files, `reviewDecision`, `coverage`, warnings, and telemetry |
| `conflicts.json` | Split groups only, on a merge conflict: the conflict `kind` (`overlap`/`apply_failure`), `failingChild`, `git apply` `reason`, base refs, and the conflicting files |

For split groups, `diff.patch` holds the **merged** patch (present only when the merge is
clean), and `result.json` additionally carries `merge` (strategy + status, plus
`conflictKind`/`conflictReason` on a conflict), `conflicts`, and `judge`. The final
`run_done` event includes the `reportPath` and `resultPath`.

## Portico Observations and the Review Decision

`report.md` opens (after the summary) with a **`## Portico Observations`** section: the facts
Portico itself measured — changed-file count, diff check (whitespace / conflict markers),
test and verify tallies, path-policy status, sandbox-escape status, and the **Review
Decision**. Trust this block over the agent's narration. The streamed agent log
(`agent.ndjson`) can show mojibake, internal sub-agent chatter, permission prompts, or
timeouts that do not reflect the files actually on disk; it is a log, not a status source.

`result.json` carries a structured `reviewDecision` (`approve` | `needs_attention`) that is
Portico's own verdict, derived from those observed facts rather than the agent's self-report.
A run is `needs_attention` when it is not `ready`, or when it is `ready` but suspect — most
commonly an **implement-mode run that produced no file changes**, which usually means the
agent didn't make progress. The report's `## Review` `Decision` line and Next Actions reflect
this: a flagged no-change run does not lead with `apply`.

If producing no edits is a legitimate outcome (a check or audit task run in implement mode),
pass `--expect-no-changes`: it suppresses the no-change warning and keeps the decision
`approve`. The no-change check keys off the structured `mode`, never off sniffing task verbs.

## Gate Warnings and Telemetry

`result.json` records gate warnings when Portico sees a mismatch between the agent's
terminal claim and Portico's own gates, when a worktree run changes files outside the
isolated worktree, or when an implement-mode run produced no file changes (unless
`--expect-no-changes` was set).

`result.telemetry` buckets the run's wall time by phase so a reviewer can see where time
went — agent work, checks, or fan-in — without scraping the event log:

- `totalDurationMs` — total run wall time.
- `worktreeSetupMs` — creating the isolated worktree (single/child runs; absent on resume / shared workspace).
- `agentDurationMs` — the target agent's execution. For a group, the sum across children.
- `diffMs` — generating the diff after the agent finished (single/child runs).
- `testDurationMs` — `--test` commands only.
- `verifyMs` — `--verify` commands, tracked separately from tests.
- `fanInMs` — group runs only: wall time in the fan-in phase (merge + judge).

The report's `## Telemetry` section renders whichever buckets were measured, and a group's
`## Compare Candidates` / `## Split Contributions` list shows each child's agent duration
plus a `no-change` count in the children summary, so retry cost is visible at a glance.

Provider usage is recorded when the agent reports it. Usage data preserves the provider's raw
payload and extracts common token and cost fields such as `inputTokens`, `outputTokens`,
`totalTokens`, and `costUsd`.

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

## Coverage

Path policy guards the *boundary* (no out-of-scope edits); coverage guards *completeness*.
Declare the paths you expect a run to change with repeatable `--expected-change`:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Sync the Chinese docs with their English originals" \
  --expected-change "docs/*.zh-CN.md" \
  --expected-change "README.zh-CN.md"
```

The report's `## Coverage` section then lists `expected`, `touched` (expected patterns that
matched a changed file), `untouched` (the gaps), and `unexpected` (changed files matching no
expected pattern). An untouched expected path on a ready implement run is a coverage gap: it
raises a gate warning and sets the review decision to `needs_attention`, so a run that silently
skipped part of the task is not mistaken for done. Coverage is opt-in — without
`--expected-change` the section is omitted. (Portico can only observe the diff, so there is no
"expected-touch"/read tracking and no built-in docs manifest; enumerate the patterns yourself.)

## Readiness and the no-change reason

The `## Review` section states a `Readiness` line that separates *review* from *apply*:
`Ready to apply` (implement run, changes present, no flags), `Ready to review (read-only run)`
for review mode, or `Ready to review only — needs attention before apply` when Portico flagged
the run (no-change or coverage gap). For a no-change implement run the report also includes an
`## Agent's Stated Reason (unverified)` section echoing the agent's final message, so a reviewer
can judge *why* nothing changed without opening the agent log — clearly labeled unverified.

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

Single `implement` runs apply directly; group runs require an explicit selection:

```bash
portico apply <run_id>                 # single implement run
portico apply <group_id> --child <id>  # compare group: pick one candidate
portico apply <group_id> --all         # split group: apply the merged patch
```

`apply` refuses when:

- the run is not `ready` (a split group in `conflict` is refused for `--all`);
- a single run's mode is not `implement`;
- the run has no `diff.patch` (or a split group has no merged patch);
- a compare group is applied without `--child`, or `--all` targets a non-split group;
- the main worktree has tracked changes;
- `git apply` fails.

Applied changes land in the main worktree as ordinary unstaged file changes. Portico does
not commit them. `apply --all` marks every contributing child `applied` alongside the group.

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
