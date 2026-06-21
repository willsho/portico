---
name: portico
description: Delegate a coding task to a separate local coding agent (e.g. Claude Code or Codex) through the Portico daemon — it runs in an isolated git worktree, gets tested, and comes back as a reviewable patch to apply or discard. Use when work should be done by another agent in isolation rather than by editing the current working tree directly, when the user names an agent to hand work to, or when you want a second agent's independent implementation to compare or review.
allowed-tools: Bash(portico *), Read
---

# Portico — delegate coding work to another local agent

Portico lets you (the current agent) hand a coding task to a **separate local coding
agent** that runs in its own throwaway git worktree. Portico owns the deterministic
part — creating the worktree, running the tests you specify, capturing the diff, and
gating apply — while the delegate does the actual coding. You orchestrate; you never
touch the user's main working tree to do delegated work.

## When to use it

- The user asks to hand work to another agent ("have Codex do X", "ask Claude to implement Y").
- A self-contained chunk of coding work is worth running in isolation and getting back as a tested, reviewable patch.
- You want a second agent's independent implementation to compare against your own.

Do **not** use it for questions you can answer directly, trivial edits you can make
yourself, or anything where spinning up a separate agent adds no value.

## Mental model (read this first)

- Implement delegates run in an **isolated worktree** at `.portico/worktrees/<run_id>` by
  default, branched from the repo's current HEAD unless `--base-ref` is provided. Review
  runs default to the shared workspace with a read-only permission profile.
- The delegate is a **fresh process with no memory of this conversation**. It receives only
  the task prompt you write — so the task must be **fully self-contained**.
- **Portico controls testing and apply, not the delegate.** Test commands come from your
  `--test` flags or `.portico/config.json`; the delegate cannot choose them. Applying the
  patch is always a separate, explicit, user-approved step.
- Every run leaves durable artifacts in `.portico/runs/<run_id>/`: `report.md`,
  `result.json`, `diff.patch`, `test.log`, `events.ndjson`.

## Workflow

1. **Ensure the daemon is running.** If `portico` commands can't connect, tell the user to
   run `portico start` (or `portico daemon start`) first.

2. **Pick the target agent** with `--to <agent>`. If the user named one, use it. Otherwise
   pick a *different* capable local agent than the one you are — run `portico agents` to see
   what's available. Never delegate to yourself, and never bypass Portico to call another
   agent directly.

3. **Write a self-contained task.** The delegate sees only this text. A good task states:
   - the goal, in a sentence or two;
   - concrete acceptance criteria (what "done" looks like);
   - the files / directories / symbols to start from;
   - constraints (what not to touch, conventions to follow);
   - how to verify (the test command, if any).

   Good: `--task "In src/settings.tsx add a dark-mode toggle wired to the existing
   useTheme() hook, persisting the choice in localStorage under 'theme'. Match the existing
   toggle styling. Done when the toggle flips the theme and the choice survives a reload."`

   Weak: `--task "add dark mode"` — no files, no acceptance criteria, so the delegate guesses.

4. **Run the delegation** and watch the streamed events (worktree creation → agent work →
   diff → test results):
   ```bash
   portico delegate --to codex --repo . \
     --task "<self-contained task>" \
     --test "npm test" \
     --allowed "src/**" --allowed "tests/**"
   ```
   Useful flags: `--name <slug>` (a human-readable run name shown in `runs`/`watch`; defaults
   to a slug of the task); repeatable `--test`; repeatable `--verify` (checks reported
   separately from tests — use for doc/policy tasks that have no test command); repeatable
   `--allowed`/`--forbidden` (path policy); `--base-ref <ref>`;
   `--cleanup manual|onNoChanges|onSuccess|always`; `--timeout <ms>`;
   `--review-summary` (after the run, print a one-click apply command + risk summary);
   `--auto-start` (start a loopback daemon and retry once if it isn't running);
   `--detach` (exit as soon as the run registers, printing its id; the run keeps going on the
   daemon — re-attach later with `portico delegate --follow <run_id>` or `portico logs <run_id> --follow`);
   `--notify` (fire an OS notification when the run reaches a terminal state — pairs with
   `--detach`; macOS only for now); `--json` for machine-readable events;
   `-y`/`--yes` (skip the fan-out confirmation prompt — confirmation is interactive-only, so
   agent-driven runs never block).

   Before launching, `delegate` prints a **preflight** to stderr: the resolved daemon URL, the
   **absolute** repo path (a relative `--repo .` is resolved CLI-side, so it can't retarget the
   daemon's cwd), the base ref, the worktree root, and the agents about to run. Read it back to
   confirm the run is pointed at the repo you intended before agents start working.

   `--apply-on-ready` is an explicit opt-in that auto-applies a **single** ready run only when
   every safety guard holds — you passed `--allowed` (a path boundary), the tracked tree is
   clean, path policy passed, no sandbox escape, and all tests + verify checks are green. If
   any guard is unmet it does **not** apply; it prints the unmet items and the review summary.
   Still requires the user's go-ahead to use; never add it on your own initiative.

   For a read-only review:
   ```bash
   portico delegate --mode review --to claude --repo . --task "<review task>"
   ```

   To compare two independent implementations (optionally with a read-only judge that
   ranks them):
   ```bash
   portico delegate --mode compare --to codex --compare-to claude --repo . --task "<task>" --judge-to gemini
   ```

   To split one large task into complementary sub-tasks and merge the results (each child
   needs its own `task`; scope with `allowedPaths` to keep the merge clean):
   ```bash
   portico delegate --mode split --to claude --repo . --task "<overall task>" \
     --child '{"to":"claude","task":"backend part","allowedPaths":["src/server/**"]}' \
     --child '{"to":"codex","task":"frontend part","allowedPaths":["src/web/**"]}'
   ```

5. **Read the result, don't trust the stream alone.** The final `run_done` event carries the
   report path. Read `report.md`, and `result.json` for the structured `changedFiles` and
   `tests`. `portico status <run_id>` re-prints a summary (`--json` for structured fields).
   For a group (compare/split), `portico review <group_id>` aggregates every child
   (status, changed files, checks, report/diff paths, per-child next action) and highlights
   files changed by more than one child — the spots that need careful manual merging.

6. **Summarize for the user:** run id and status, changed files, per-command test result, and
   any risks you see in the diff. A run is `ready` when it produced a diff and tests passed;
   `failed` when a test failed or the agent errored.

7. **Decide apply vs discard — always with the user.**
   - `ready` and the diff looks right → present a summary and **ask before** running
     `portico apply <run_id>`. Apply refuses unless the main tree's tracked files are clean,
     then lands the patch in the main working tree (unstaged) for the user to review and commit.
   - `failed` → read `.portico/runs/<run_id>/test.log` to diagnose, then either start a
     **new** run with a sharper task or `portico discard <run_id>`.
   - `portico discard <run_id>` removes the worktree but keeps artifacts for inspection.

## Iterating and orchestrating

- The delegate has no memory between runs. To iterate, launch a **new** `portico delegate`
  with a refined task that folds in what the previous run got wrong — quote lines from its
  `report.md` / `test.log` directly into the new task.
- To iterate on a **child of a group** without re-running the whole group, use
  `portico delegate --resume <child_id> --task "<refinement>"`. It re-runs that child in its
  existing worktree, regenerates the diff, re-runs tests, and recomputes the group (for a
  split group it also re-runs the fan-in merge). Needs an adapter that supports session
  resume (Claude does) and the worktree still present.
- To compare approaches, prefer `--mode compare --to <agent-a> --compare-to <agent-b>`.
  Portico records a parent compare report plus separate candidate runs; apply only the
  chosen implement candidate via `portico apply <group_id> --child <child_id>`, never the
  compare parent.
- To divide a large task, prefer `--mode split` with a `--child` per sub-task. Portico
  merges the children's patches; apply the merged result with `portico apply <group_id> --all`.
  A `conflict` group (never force-merged) reports a `Conflict Kind`: `overlap` means two
  children edited the same region — narrow one with `--resume` and Portico re-merges
  automatically; `apply_failure` means a single child's own patch did not apply to the group
  base (drifted context / malformed diff), so re-run *that* child rather than narrowing.
  The report's `Git Reason` line and `conflicts.json` (`reason`, `failingChild`, first failing
  `file:line`) tell you which case you're in.
- For a `partial` split group (some children ready, some failed), `portico integrate <group_id>`
  merges just the **ready** children on demand into one patch you can `apply --all`. On a
  conflict it lists the conflicting files, their source child, the conflict kind, the underlying
  `git apply` reason, and a suggested review order; narrow or re-run the child and run
  `integrate` again. Compare groups are not integrated — their children are competing
  implementations, so you pick one with `apply --child`.
- An optional `--judge-to <agent>` adds a read-only judge: it ranks compare candidates or
  vets a split merge, but never changes apply semantics — you and the user still decide.
- Don't chain delegations: if you are yourself a delegate running inside a Portico worktree,
  do not call `portico delegate` again — nested delegation is rejected by the daemon's depth guard.

## Hard rules

- Never edit the user's main working tree to do delegated work yourself.
- Never reach another agent except through `portico delegate`.
- Never run `portico apply` without the user's explicit go-ahead.
- Do not use `--isolation shared --permission-profile auto-edit` unless the user explicitly
  asked for direct edits in the current checkout; Portico requires a clean tree for that mode.
- Test commands come only from the user or `.portico/config.json`, never from the delegate.

## Command reference

- `portico init` — create Portico repo metadata and refresh the generated Portico Skill files
  under `.claude/skills/portico/` and `.agents/skills/portico/`.
- `portico agents [--json]` — list local agents you can delegate to.
- `portico delegate --to <agent> --repo . --task "<task>" [--test "<cmd>"]…` — run a delegation.
- `portico delegate --mode review --to <agent> --repo . --task "<task>"` — run a read-only review.
- `portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" [--judge-to <agent>]` — run candidate implementations for comparison.
- `portico delegate --mode split --to <agent> --repo . --task "<task>" --child '{…,"task":"…"}' --child '{…}'` — split into complementary sub-tasks and merge.
- `portico delegate --resume <child_id> --task "<refinement>"` — iterate on one child in place.
- `portico delegate --follow <run_id>` — re-attach to a run's event log (e.g. after `--detach`).
- `portico runs [--repo .]` — list runs (folded; `--flat` for the legacy flat list). Filter with
  `--status <s1,s2>` and `--since <dur>` (e.g. `30m`, `2h`, `1d`); active runs are tagged `[active]`.
  Group rows show `children <ready>/<total> ready`. `--watch` opens the live board.
- `portico watch [--repo .]` — live status board: runs grouped by state (decision-needed on top,
  then working, then done), refreshed on an interval, with inline keys to apply/discard/cancel/
  follow/review/integrate the selected run. Filter with `--status` / `--needs-review` / `--to <agent>`
  / `--since`. Non-TTY (or `--once` / `--json`) prints a one-shot snapshot instead, so it stays
  scriptable. Useful when several delegations are running in parallel.
- `portico status <run_id>` — show a run's artifacts, changed files, tests, and live progress
  (current phase, whether an agent is still running, last event).
- `portico review <group_id>` — aggregate a group's children for review (`--ready-only` / `--json` / `--open-diff`).
- `portico integrate <group_id>` — merge an implement/split group's ready children into one patch (not for compare groups).
- `portico apply <run_id>` — apply a ready single run's patch (only with user approval).
- `portico apply <group_id> --child <child_id>` — apply one compare candidate.
- `portico apply <group_id> --all` — apply a split/integrated group's merged patch.
- `portico discard <run_id>` — remove a run's worktree (artifacts kept).
- `portico cancel <run_id>` — cancel an in-flight run.
- `portico cleanup [--failed] [--older-than <dur>] [--purge]` — reclaim finished run worktrees
  (default keeps artifacts; `--purge` removes them too). Never touches ready/applied or in-flight runs.

## Troubleshooting

- `daemon not running` → start it: `portico start`, or pass `--auto-start` to `portico delegate`
  to have it start a loopback daemon and retry once. A `permission denied` / sandbox variant
  means loopback access is blocked, not that the daemon is down. If `portico start` warns that
  the pidfile or `.portico`/`.git` dirs aren't writable, a sandbox is blocking writes — grant
  write access or run outside the sandbox (the daemon may still be usable, but `stop`/discovery
  and delegations will be limited).
- `agent_unavailable` → the target isn't found: check `portico agents`; it may not be installed.
- Stale generated Skill → rerun `portico init` in the repo. It refreshes Portico's generated
  Skill files without touching other project-level skills.
- Test failed → read `.portico/runs/<run_id>/test.log`, refine the task, re-delegate.
- `path_not_allowed` → the run changed a file outside `--allowed`; the error and report carry a
  copy-paste retry that pre-fills the missing `--allowed` flags.
- `working_tree_dirty` on apply → commit or stash the main tree first, then apply.
