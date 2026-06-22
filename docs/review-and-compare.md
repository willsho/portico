# Review, Compare, and Split

Portico supports non-default delegation modes for getting another agent's judgment without
immediately applying a patch: `review`, `compare`, and `split`. `compare` and `split` are
the two fan-out shapes — compare produces competing implementations of one task, split
divides one task into complementary sub-tasks and merges them. Both accept an optional
read-only **judge** to help you decide.

## Review Mode

Review mode asks a target agent to inspect the repository and report findings.

```bash
portico delegate \
  --mode review \
  --to claude \
  --repo . \
  --task "Review the parser changes for regressions and missing tests"
```

Defaults:

| Setting | Value |
| --- | --- |
| `isolation` | `shared` |
| `permissionProfile` | `read-only` |
| `diff.patch` | empty |
| `apply` | rejected |

Review mode is useful when:

- you want a second opinion on a diff or code path;
- the task should not create a patch;
- the current checkout already contains the work to inspect;
- you want to keep review output in Portico artifacts.

The run is marked `ready` when the agent completes without modifying the shared worktree.
If a read-only review changes files, Portico fails the run with `read_only_modified`.

## Writing Review Tasks

Be explicit about what the reviewer should look for:

```text
Review the changes around packages/orchestrator/src/orchestrator.ts.
Focus on workspace isolation, apply/discard lifecycle, and test coverage.
Return findings ordered by severity with file references. Do not edit files.
```

Good review tasks name:

- files or directories to inspect;
- the risk category;
- expected output format;
- whether tests or docs should be considered.

Review mode does not run configured test commands. It is for agent analysis, not
verification.

## Compare Mode

Compare mode asks multiple agents to produce independent candidate implementations.

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Add project-level isolation settings to delegation runs" \
  --test "npm test"
```

The first candidate comes from `--to`. Additional candidates come from repeated
`--compare-to` flags:

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --compare-to gemini \
  --repo . \
  --task "Try three approaches to X"
```

Compare mode runs candidates in parallel, each an ordinary `implement` run in its own
isolated worktree with `auto-edit` enabled. The number running at once is bounded by the
orchestrator's `maxConcurrentAgentProcesses` (default 4); `git worktree` bookkeeping is
serialized so concurrent runs don't contend. Candidate events stream interleaved, each
tagged with its own `runId`, and the parent compare run only completes once every
candidate has finished.

## Compare Artifacts

Compare mode creates:

1. a parent compare run;
2. one child implement run per candidate.

The parent run records `compareResults` in `result.json` and includes a "Compare
Candidates" section in `report.md`.

The parent compare run is not applyable:

```bash
portico apply <compare_parent_run_id>
# rejected: only implement runs can be applied
```

To apply a candidate:

1. open the parent report;
2. inspect each candidate report and patch;
3. choose one candidate implement run;
4. apply that candidate's run id.

```bash
portico status <candidate_run_id>
portico apply <candidate_run_id>
```

## Compare With Base Refs and Cleanup

Compare candidates inherit the parent request's base ref and cleanup policy:

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement X from main" \
  --base-ref main \
  --cleanup onNoChanges
```

Each candidate gets its own isolated worktree and branch.

## Choosing Between Candidates

When comparing candidates, inspect:

- changed files;
- size and clarity of the diff;
- test results;
- whether the implementation follows existing patterns;
- whether one candidate solved less or more than requested;
- any new risks introduced by dependencies, config, or generated files.

The best candidate is not always the largest patch or the one with the most explanation.
Prefer the smallest implementation that satisfies the task and fits the codebase.

## Judge (Optional)

A judge automates the first pass of that choice. Add `--judge-to <agent>` to a compare run
and Portico runs a read-only `review` over the candidate diffs after they finish, then
records a ranking and a `recommendedChildId` in the group's `result.json` and report:

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Refactor the cache layer" \
  --judge-to gemini
```

The judge is agent-agnostic and always read-only. It does **not** change apply semantics —
`apply --child <id>` is still required and you still make the final call. The recommendation
is surfaced in `portico status` and the report's "Next Actions" (marked `(recommended)`).

## Split Mode

Split mode divides one task into complementary sub-tasks, runs them in parallel like a
compare group, and then **merges** the resulting patches into one reviewable patch.

```bash
portico delegate \
  --mode split \
  --to claude \
  --repo . \
  --task "Add OAuth login end-to-end" \
  --child '{"to":"claude","task":"Backend OAuth routes","allowedPaths":["src/server/**"]}' \
  --child '{"to":"codex","task":"Login UI","allowedPaths":["src/web/**"]}' \
  --judge-to gemini
```

In split mode every child must declare its own `task`, and `allowedPaths` keeps each child
in its lane so the merge stays clean. After the children finish, Portico merges them in an
integration worktree branched from the shared base ref:

- Clean merge → the group becomes `ready` and `apply --all` lands the merged patch.
- Conflict → Portico records `conflicts.json`, moves the group to `conflict`, and refuses
  `apply --all`. The report's `Conflict Kind` distinguishes `overlap` (two children edited the
  same region — narrow one with `--resume` when session resume is available, or `--continue`
  when only the worktree remains; Portico re-merges automatically) from
  `apply_failure` (a single child's patch did not apply to the group base — re-run that child).

To catch an `apply_failure` *before* the merge, `portico review <group_id>` runs a per-child
**apply check** (`git apply --check` of each child's patch against the group base) and reports
`apply ok` / `apply FAILS` per child. Unlike file-name overlap, this catches a child whose own
patch drifted from the base even when it touches files no other child changed.

With `--judge-to`, the judge reviews the **merged** result and records an `approve` /
`needs_attention` verdict. See [Delegation → Task Split and Fan-in](delegation.md) for the
full lifecycle.

## Common Patterns

Ask two agents for independent implementations:

```bash
portico delegate \
  --mode compare \
  --to codex \
  --compare-to claude \
  --repo . \
  --task "Implement the new CLI flag and tests" \
  --test "npm run typecheck" \
  --test "npm test"
```

Review a candidate after compare:

```bash
portico delegate \
  --mode review \
  --to claude \
  --repo . \
  --task "Review candidate run <run_id>; focus on correctness and missing tests"
```

Iterate on a failing candidate in place (re-runs it in its existing worktree and recomputes
the group status, so a mixed group can converge to all-ready):

```bash
portico delegate --resume <candidate_run_id> --task "the typecheck fails at line 42; fix it"
```

Use `portico delegate --continue <candidate_run_id> --task "..."` for the same existing-worktree
rerun when the candidate has no stored native session id.

Discard losing candidates:

```bash
portico discard <candidate_run_id>
```

Keep the parent compare run artifacts. They are useful historical context even after
candidate worktrees are discarded.
