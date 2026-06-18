# Review and Compare

Portico supports two non-default delegation modes for getting another agent's judgment
without immediately applying a patch: `review` and `compare`.

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

Discard losing candidates:

```bash
portico discard <candidate_run_id>
```

Keep the parent compare run artifacts. They are useful historical context even after
candidate worktrees are discarded.

