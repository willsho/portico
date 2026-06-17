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

- The delegate runs in an **isolated worktree** at `.portico/worktrees/<run_id>`, branched
  from the repo's current HEAD. Its edits never reach the main working tree until the user
  applies the patch.
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
   Useful flags: repeatable `--test`; repeatable `--allowed`/`--forbidden` (path policy);
   `--timeout <ms>`; `--json` for machine-readable events.

5. **Read the result, don't trust the stream alone.** The final `run_done` event carries the
   report path. Read `report.md`, and `result.json` for the structured `changedFiles` and
   `tests`. `portico status <run_id>` re-prints a summary (`--json` for structured fields).

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
- To compare approaches, delegate the same task to two different agents, compare their
  `diff.patch` and test results, then apply the better one and discard the other.
- Don't chain delegations: if you are yourself a delegate running inside a Portico worktree,
  do not call `portico delegate` again — nested delegation is rejected by the daemon's depth guard.

## Hard rules

- Never edit the user's main working tree to do delegated work yourself.
- Never reach another agent except through `portico delegate`.
- Never run `portico apply` without the user's explicit go-ahead.
- Test commands come only from the user or `.portico/config.json`, never from the delegate.

## Command reference

- `portico agents [--json]` — list local agents you can delegate to.
- `portico delegate --to <agent> --repo . --task "<task>" [--test "<cmd>"]…` — run a delegation.
- `portico runs [--repo .]` — list runs.
- `portico status <run_id>` — show a run's artifacts, changed files, and tests.
- `portico apply <run_id>` — apply a ready run's patch (only with user approval).
- `portico discard <run_id>` — remove a run's worktree (artifacts kept).
- `portico cancel <run_id>` — cancel an in-flight run.

## Troubleshooting

- Connection refused → the daemon isn't running: `portico start`.
- `agent_unavailable` → the target isn't found: check `portico agents`; it may not be installed.
- Test failed → read `.portico/runs/<run_id>/test.log`, refine the task, re-delegate.
- `working_tree_dirty` on apply → commit or stash the main tree first, then apply.
