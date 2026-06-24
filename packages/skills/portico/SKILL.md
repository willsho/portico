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
   agent directly. A saved `--profile <name>` can supply the target (and more) — see
   [Delegate profiles](#delegate-profiles).

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
   Reuse a preset with `--profile <name>`: it fills any flag you didn't pass from
   `.portico/agents/<name>.md` (target, model, permission profile, path policy, test commands,
   idle timeout) and prepends the profile's body to your task as standing instructions. An
   explicit flag always overrides the profile. See [Delegate profiles](#delegate-profiles).

   Useful flags: `--name <slug>` (a human-readable run name shown in `runs`/`watch`; defaults
   to a slug of the task); repeatable `--test`; repeatable `--verify` (checks reported
   separately from tests — use for doc/policy tasks that have no test command); repeatable
   `--allowed`/`--forbidden` (path policy); `--base-ref <ref>`;
   `--model <id>` (pick the target agent's model, e.g. `opus` / `claude-opus-4-8`; omitted →
   the agent's own default) and `--effort <level>` (reasoning effort where the agent supports
   it, e.g. `low|medium|high`); both are translated to the agent's native flags, and a child's
   `model`/`effort` in `--child` overrides these per child. An unknown `--model` for an agent
   with a known catalog (e.g. claude) is rejected before launch; `--model-force` sends a custom
   id as-is (use `portico models --to <agent>` to see valid ids);
   `--cleanup manual|onNoChanges|onSuccess|always`; `--timeout <ms>` (total task duration, independent of the idle watchdog that stops stalled agents);
   `--idle-timeout <ms>` (how long the agent may go with **no sign of life** before it's treated as
   stalled — distinct from `--timeout`'s total wall-clock; `0` or `off` disables the watchdog,
   leaving only `--timeout` as the backstop; omitted → the daemon's per-agent or `idleTimeoutMs`
   default. The watchdog resets on any stdout/stderr output, any streamed event, and — for worktree
   runs — any worktree file change, so a quiet edit-agent that writes files while logging only to
   stderr (or nothing) is no longer falsely killed; it also widens the window during cold start and
   while a tool call is in flight, and is **two-stage** — it first emits a visible `idle_warning`
   event, then only kills at a larger hard ceiling. A known-quiet agent can be given a longer
   default leash via `agents.<id>.idleTimeoutMs` or `PORTICO_IDLE_TIMEOUT_MS` in the daemon config,
   which needs a daemon restart to take effect);
   `--expect-no-changes` (declare that producing no edits is an acceptable outcome — suppresses
   the implement-mode no-change warning and keeps the review decision `approve`; use for
   check/audit tasks run in implement mode);
   `--expected-change <pattern>` (repeatable; declare paths you expect to change — the report
   adds a Coverage section and an untouched expected path becomes a coverage gap → the run is
   `needs_attention`, catching a task that silently skipped part of its scope);
   `--coverage-manifest <path>` (supply expected-change paths from a JSON file);
   `--review-summary` (after the run, print a one-click apply command + risk summary —
   the same data the terminal `run_done`/`run_error` event already carries under `verdict`,
   useful for re-printing it later from a fetched run);
   `--no-auto-start` (by default `delegate` auto-starts a loopback daemon and retries once if
   none is reachable; pass this to fail fast instead, e.g. in CI expecting a pre-existing daemon);
   `--detach` (exit as soon as the run registers, printing its id; the run keeps going on the
   daemon — re-attach later with `portico delegate --follow <run_id>` or `portico logs <run_id> --follow`);
   `--notify` (fire an OS notification when the run reaches a terminal state — pairs with
   `--detach`; macOS only for now); `--json` for machine-readable events;
   `-y`/`--yes` (skip the fan-out confirmation prompt — confirmation is interactive-only, so
   agent-driven runs never block);
   `--dry-run` (lint the task text for a named file, acceptance criteria, and a test command,
   then exit — code 0 if all three pass, 1 otherwise; no network call, no worktree created; use
   this before launching a task you're unsure is self-contained enough);
   repeatable `--context <path-or-glob>` / `--context-diff <ref>` (deterministically splice file
   contents or a `git diff` into the task before sending, instead of hand-copying excerpts —
   capped at 40,000 combined characters; a glob with no matches or a failing diff ref warns to
   stderr and is skipped, not a hard failure; no retrieval/ranking, just explicit enumeration);
   `--iterate-from <run_id>` (new run with previous failure context); `--resume <child_id>`
   (same worktree plus native session resume); `--continue <run_id>` (same worktree, fresh
   agent session, no `agentSessionId` required).

   Before launching, `delegate` also runs a fast local agent-availability check (no `--version`
   probes) against every target the request would launch — `--to`, each `--compare-to`, each
   child's `to` — and fails with no worktree created if one is missing, instead of surfacing as
   `agent_unavailable` after a cold start is already burned. (Skipped for `--dry-run`.)

   Then `delegate` prints a **preflight** to stderr: the resolved daemon URL, the
   **absolute** repo path (a relative `--repo .` is resolved CLI-side, so it can't retarget the
   daemon's cwd), the base ref, the worktree root, the effective timeout, and the agents about to
   run — plus, when set (e.g. from a `--profile`), the resolved mode, permission profile,
   model/effort, path policy, test commands, and idle timeout, so you can confirm what a profile
   actually resolved to. Read it back to confirm the run is pointed at the repo you intended
   before agents start working.

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

5. **Read the result, don't trust the stream alone.** The terminal `run_done` / `run_error`
   event carries a `verdict` block — `status`, `reviewDecision`, `readiness`
   (`ready` / `needs_attention` / `not_ready`), `changedFiles`, `diffSummary`, `tests`/`verify`
   tallies, `pathPolicy`, `sandboxEscaped`, and `topRisks` — Portico's own measurements, not the
   agent's self-report. With `--json` this is one read, no need to open `report.md` /
   `result.json` or shell out to `git diff`. `portico status <run_id> --json` (or `--summary`)
   embeds the same `verdict` for a run you didn't stream yourself. For the human-readable form,
   read `report.md`'s `## Portico Observations` section, or `result.json` directly. Trust these
   over the agent's narration — the streamed agent log can show mojibake, internal sub-agent
   chatter, or timeouts that don't reflect the files on disk. The agent log (`agent.ndjson`) is
   a log, not a status source. While a single (non-group) run is still in progress, a
   `verdict_update` event (same `RunVerdict` shape, but necessarily `readiness: "not_ready"`) is
   emitted once, right after the diff is ready and before tests run — an honest mid-flight
   Portico signal, not the agent's self-report. In the default (non-`--json`) terminal rendering
   it prints as a clearly Portico-labeled line, and raw agent narration (the `content`/`reasoning`
   deltas) is preceded by an "agent narration (unverified, not Portico's verdict)" banner once per
   run, so the two are never visually confused while watching a stream live.
   The report's `## Telemetry` section buckets wall time by phase (worktree setup, agent, diff,
   tests, verify, and — for groups — fan-in), and a group's candidate list shows each child's
   agent duration; use these to see whether time went to the agent, the checks, or fan-in
   before blaming a slow run on Portico.
   For a group (compare/split), `portico review <group_id>` aggregates every child
   (status, changed files, checks, report/diff paths, per-child next action), highlights
   files changed by more than one child — the spots that need careful manual merging — and
   shows a per-child **apply check** (`apply ok` / `apply FAILS`): whether that child's own
   patch still applies to the group base. A child can be `ready` with no file overlap yet still
   `apply FAILS` (its patch drifted from the base); the apply check flags that up front instead
   of letting it surface as a fan-in conflict.

   The `## Review` section's `Readiness` line separates *review* from *apply*: `Ready to apply`
   vs `Ready to review only — needs attention` (a flagged no-change or coverage-gap run). When
   `--expected-change` was given, the `## Coverage` section shows touched / untouched (gaps) /
   unexpected paths. For a no-change run, `## Agent's Stated Reason (unverified)` echoes the
   agent's own explanation — read it, but treat it as a claim, not a verified fact.

6. **Summarize for the user:** run id and status, changed files, per-command test result, and
   any risks you see in the diff. A run is `ready` when it produced a diff and tests passed;
   `failed` when a test failed or the agent errored. Read the report's `Review Decision`
   (under `## Portico Observations` / `## Review`): even a `ready` run can be `needs_attention`
   — most often an implement-mode run that produced **no file changes**, which usually means it
   didn't make progress. Don't lead the user to apply a `needs_attention` run; inspect why, then
   re-delegate with a sharper task (or pass `--expect-no-changes` if no edits was genuinely the
   expected outcome).

7. **Decide apply vs discard — always with the user.**
   - `ready` and the diff looks right → present a summary and **ask before** running
     `portico apply <run_id>`. Apply refuses unless the main tree's tracked files are clean,
     then lands the patch in the main working tree (unstaged) for the user to review and commit.
   - `failed` → read `.portico/runs/<run_id>/test.log` to diagnose, then either start a
     **new** run with a sharper task or `portico discard <run_id>`.
   - `failed` **solely** because of `path_not_allowed` (check `## Portico Observations` /
     `result.pathPolicy` — `status: failed` with `notAllowed` paths and no `forbidden` ones) and
     the rest of the diff is otherwise good → no need to re-run the agent. With the user's
     explicit confirmation of the out-of-scope path(s), land it as-is:
     `portico apply <run_id> --allow <path>…` (one `--allow` per offending path, or a pattern that
     covers them). This still requires a clean main tree and is recorded in `result.json` as
     `pathPolicyOverride` for provenance. A `forbidden` hit is a hard boundary — `--allow` never
     overrides it; that always needs a fresh run.
   - `portico discard <run_id>` removes the worktree but keeps artifacts for inspection.

## Iterating and orchestrating

- The delegate has no memory between runs. To iterate, launch a **new** `portico delegate`
  with a refined task that folds in what the previous run got wrong. `--iterate-from <run_id>`
  automates the "quote lines from its `report.md` / `test.log`" part — it deterministically
  splices that run's top risks, failing test/verify output, and changed files into the new
  task's `## Context` section (composes with `--context`/`--context-diff`), then launches an
  ordinary new run. It is **not** a continuation — no shared worktree or session — so it's
  orthogonal to `--resume` and `--continue` below; still write your own refinement in `--task`.
- To iterate on a **child of a group** without re-running the whole group, use
  `portico delegate --resume <child_id> --task "<refinement>"`. It re-runs that child in its
  existing worktree, regenerates the diff, re-runs tests, and recomputes the group (for a
  split group it also re-runs the fan-in merge). Needs an adapter that supports session
  resume (Claude does) and the worktree still present.
- To continue partial work when the adapter has no native session to resume, use
  `portico delegate --continue <run_id> --task "<refinement>"`. It re-runs the target agent in
  the same existing worktree, appends the new task with a `[continue]` marker, regenerates the
  diff, re-runs the stored tests/verify checks, and refreshes the report. It starts a fresh
  agent session and never passes `resumeSessionId`, so it works for no-session adapters as
  long as the worktree still exists.
- To compare approaches, prefer `--mode compare --to <agent-a> --compare-to <agent-b>`.
  Portico records a parent compare report plus separate candidate runs; apply only the
  chosen implement candidate via `portico apply <group_id> --child <child_id>`, never the
  compare parent.
- To divide a large task, prefer `--mode split` with a `--child` per sub-task. Portico
  merges the children's patches; apply the merged result with `portico apply <group_id> --all`.
  A `conflict` group (never force-merged) reports a `Conflict Kind`: `overlap` means two
  children edited the same region — narrow one with `--resume` when session resume is available,
  or `--continue` when only the worktree remains, and Portico re-merges
  automatically; `apply_failure` means a single child's own patch did not apply to the group
  base (drifted context / malformed diff), so re-run *that* child rather than narrowing.
  The report's `Git Reason` line and `conflicts.json` (`reason`, `failingChild`, first failing
  `file:line`) tell you which case you're in.
- For multiple ready/independent runs you want to apply in order, use `portico patch-stack <run_id> <run_id>...`.
  It computes file overlap (manual-merge hot spots) and suggests an apply-order without applying anything.
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

## Delegate profiles

A **profile** is a named, reusable preset for a delegation, stored as a Markdown file with
frontmatter at `.portico/agents/<name>.md` (project scope — shareable via version control) or
`~/.portico/agents/<name>.md` (user scope — personal, all repos). The project scope overrides
the user scope field-by-field. Resolution is CLI-side: a profile only fills fields you didn't
pass, so any explicit flag (or `--child` key) always wins.

- Frontmatter fields: `to`, `mode`, `model`, `effort`, `permissionProfile`, `allowed`,
  `forbidden`, `testCommands`, `idleTimeoutMs`, `description`.
- The Markdown **body** is a standing task preamble — prepended to your task, the way a
  subagent's system prompt frames every run.
- Apply one with `portico delegate --profile <name> …`. A `--child` can pull a profile too:
  `--child '{"profile":"backend","task":"…"}'` (the child's own keys win over the profile's).
- Inspect with `portico profiles list` and `portico profiles show <name>` (`--json` for both).
  `portico doctor` also lists profiles and flags authoring mistakes (unknown frontmatter keys,
  invalid `mode` / `permissionProfile` values).
- `portico init` scaffolds two examples — `reviewer` (read-only review) and `implementer`
  (auto-edit + tests). Editing or deleting them is fine; re-running `init` never overwrites
  an existing profile.

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
- `portico agents [--url <url>] [--token <token>] [--json]` — list local agents you can delegate to (does not require a running daemon).
- `portico models [--to <agent>] [--json]` — list the models each agent can run (id, default, aliases). claude has a fixed catalog; cursor and opencode are probed live from the CLI on demand (so this is slower than `portico agents`); agents that self-manage model choice show "model selection managed by runtime". The model/effort a run actually used is recorded in its `report.md` (and per child in a group's candidate list).
- `portico delegate --to <agent> --repo . --task "<task>" [--test "<cmd>"]…` — run a delegation (exit 0 success, 1 fail, 3 client disconnected).
- `portico delegate --profile <name> --task "<task>"` — apply a saved delegate profile; explicit flags override it.
- `portico profiles list [--repo .] [--json]` — list delegate profiles from `.portico/agents/` and `~/.portico/agents/`.
- `portico profiles show <name> [--repo .] [--json]` — show one resolved profile (project merged over user).
- `portico delegate --mode review --to <agent> --repo . --task "<task>"` — run a read-only review.
- `portico delegate --mode compare --to <agent-a> --compare-to <agent-b> --repo . --task "<task>" [--judge-to <agent>]` — run candidate implementations for comparison.
- `portico delegate --mode split --to <agent> --repo . --task "<task>" --child '{…,"task":"…"}' --child '{…}'` — split into complementary sub-tasks and merge.
- `portico delegate --resume <child_id> --task "<refinement>"` — iterate on one child in place with native session resume.
- `portico delegate --continue <run_id> --task "<refinement>"` — iterate in an existing worktree with a fresh agent session.
- `portico delegate --follow <run_id>` — re-attach to a run's event log (e.g. after `--detach`).
- `portico runs [--repo .]` — list runs (folded; `--flat` for the legacy flat list). Filter with
  `--status <s1,s2>` and `--since <dur>` (e.g. `30m`, `2h`, `1d`); active runs are tagged `[active]`.
  Group rows show `children <ready>/<total> ready`. `--watch` opens the live board.
- `portico watch [--repo .]` — live status board: runs grouped by state (decision-needed on top,
  then working, then done), refreshed on an interval, with inline keys to apply/discard/cancel/
  follow/review/integrate the selected run. Active rows show `idle <ago>` (time since the run's
  last event) so a stalled or silent run is obvious at a glance; the rightmost column is the run's
  duration — elapsed so far while in flight, the final `startedAt → completedAt` span once done
  (preserved across apply/discard, so a slow decision never inflates it). Filter with `--status` /
  `--needs-review` / `--to <agent>` / `--since`. Non-TTY (or `--once` / `--json`) prints a
  one-shot snapshot instead, so it stays scriptable. Interactive terminals use the alternate screen
  and skip unchanged redraws, so live refreshes do not fill scrollback. Useful when several
  delegations run in parallel.
- `portico status <run_id>` — show a run's artifacts, changed files, tests, and live progress
  (current phase, whether an agent is still running, last event).
- `portico review <group_id>` — aggregate a group's children for review, with cross-child file overlap and a per-child apply check against the group base (`--ready-only` / `--json` / `--open-diff`).
- `portico patch-stack <run_id> <run_id>...` — read-only summary of file overlap and apply-order across runs.
- `portico integrate <group_id>` — merge an implement/split group's ready children into one patch (not for compare groups).
- `portico apply <run_id>` — apply a ready single run's patch (only with user approval).
- `portico apply <run_id> --allow <path>…` — land a `failed` run whose only problem was
  `path_not_allowed`, after the user confirms the out-of-scope path(s) (also works with
  `--child <child_id>` for a group child). Does not override a `forbidden` violation.
- `portico apply <group_id> --child <child_id>` — apply one compare candidate.
- `portico apply <group_id> --all` — apply a split/integrated group's merged patch. Tip: apply the group's merged patch first, then run/apply any small follow-up fixes as separate patches.
- `portico discard <run_id>` — remove a run's worktree (artifacts kept).
- `portico cancel <run_id>` — cancel an in-flight run. Salvages whatever diff is already
  sitting in the worktree (same artifacts an error/timeout leaves) instead of discarding it —
  inspect the partial work or resume it, it isn't a total loss.
- `portico cleanup [--failed] [--older-than <dur>] [--purge]` — reclaim finished run worktrees
  (default keeps artifacts; `--purge` removes them too). Never touches ready/applied or in-flight runs.

## Troubleshooting

- `daemon not running` → `portico delegate` auto-starts a loopback daemon and retries once by
  default; pass `--no-auto-start` to fail fast instead, or start it yourself with `portico start`.
  If a daemon is running elsewhere, Portico will suggest its URL. A `permission denied` / sandbox variant
  means loopback access is blocked, not that the daemon is down. If `portico start` warns that
  the pidfile or `.portico`/`.git` dirs aren't writable, a sandbox is blocking writes — grant
  write access or run outside the sandbox (the daemon may still be usable, but `stop`/discovery
  and delegations will be limited).
- `agent_unavailable` → the target isn't found: check `portico agents`; it may not be installed.
- Stale generated Skill → rerun `portico init` in the repo. It refreshes Portico's generated
  Skill files without touching other project-level skills.
- Agent stalled, timed out, or test failed → read the report and `.portico/runs/<run_id>/test.log`. A stalled or erroring agent may still leave partial edits in the worktree (captured in the diff); you can review the partial work, resume the run when it has a native agent session, continue it from the existing worktree, refine the task, or re-delegate.
- `path_not_allowed` → the run changed a file outside `--allowed`; the error and report carry a
  copy-paste retry that pre-fills the missing `--allowed` flags. If the diff is otherwise good,
  you can skip the retry and land it directly with user approval:
  `portico apply <run_id> --allow <path>…` (see "Decide apply vs discard" above).
- `working_tree_dirty` on apply → commit or stash the main tree first, then apply.
