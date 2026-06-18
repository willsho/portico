# Isolation and Permissions

Portico treats workspace isolation and agent editing permission as separate decisions.
This mirrors the useful part of Claude Code subagent isolation while keeping Portico's
patch review and apply gate explicit.

## Mental Model

There are two independent questions:

1. Where does the target agent run?
2. Is the target agent allowed to edit autonomously?

Portico answers the first with `isolation` and the second with `permissionProfile`.

## Workspace Isolation

`--isolation` controls the execution workspace:

| Value | Meaning |
| --- | --- |
| `worktree` | Create an isolated git worktree under `.portico/worktrees/<run_id>` |
| `shared` | Run in the caller's repository checkout |

Implementation runs default to `worktree`:

```bash
portico delegate --to codex --repo . --task "Implement X"
```

Review runs default to `shared`:

```bash
portico delegate --mode review --to claude --repo . --task "Review the current code"
```

You can override the workspace explicitly:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --isolation worktree
```

Shared implementation runs are supported, but they are intentionally an advanced path:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Make this direct edit in the current checkout" \
  --isolation shared \
  --permission-profile auto-edit
```

For shared auto-edit runs, Portico requires the working tree to be clean before the run.
That lets Portico attribute the resulting diff to the delegated agent.

## Base Ref

`--base-ref` controls the git ref used when creating an isolated worktree:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Implement X" \
  --base-ref main
```

The default is `HEAD`.

Use `defaultBranch` to ask Portico to branch from the repository's default branch when it
can resolve one:

```bash
portico delegate \
  --to claude \
  --repo . \
  --task "Try this from the default branch" \
  --base-ref defaultBranch
```

Resolution order for `defaultBranch` is:

1. `refs/remotes/origin/HEAD`;
2. the current branch;
3. `HEAD`.

`baseRef` only matters for `worktree` isolation.

## Cleanup Policy

`--cleanup` controls when Portico may remove an isolated worktree automatically:

| Value | Behavior |
| --- | --- |
| `manual` | Keep the worktree until `portico discard <run_id>` |
| `onNoChanges` | Remove the worktree when the run produces no changed files |
| `onSuccess` | Remove the worktree when the run becomes `ready` |
| `always` | Remove the worktree after completion or failure |

Example:

```bash
portico delegate \
  --to codex \
  --repo . \
  --task "Check whether this change is needed" \
  --cleanup onNoChanges
```

Even when a worktree is removed, run artifacts remain under `.portico/runs/<run_id>/`.
Reports record `Worktree Removed At` when cleanup happened.

Be careful with `onSuccess`: the patch artifact remains, so `apply` can still work, but the
live worktree is gone.

## Permission Profiles

`--permission-profile` controls whether Portico asks the provider adapter for autonomous
editing:

| Profile | Meaning |
| --- | --- |
| `default` | Do not request provider-specific auto-edit flags |
| `read-only` | Treat the run as read-only; review mode requires this |
| `auto-edit` | Request provider-specific edit permissions, such as Codex `--full-auto` or Claude `acceptEdits` |

Defaults:

| Mode | Default profile |
| --- | --- |
| `implement` + `worktree` | `auto-edit` |
| `implement` + `shared` | `default` |
| `review` | `read-only` |
| `compare` candidates | `auto-edit` |

Read-only shared runs snapshot `git status --porcelain` before and after the agent runs.
If the agent changes the shared working tree, the run fails with `read_only_modified`.

## Recommended Defaults

Use these unless you have a specific reason not to:

| Task | Recommended settings |
| --- | --- |
| Normal implementation | `--isolation worktree --permission-profile auto-edit` |
| Read-only review | `--mode review` |
| Independent experiments | `--mode compare` |
| Try from main/default branch | `--base-ref main` or `--base-ref defaultBranch` |
| Quick no-op investigation | `--cleanup onNoChanges` |

Avoid shared auto-edit unless the user explicitly wants the target agent to modify the
current checkout directly.

## What Isolation Does Not Do

Workspace isolation protects the caller's checkout from direct file changes. It does not:

- sandbox network access;
- hide environment variables from the child process;
- prevent the provider CLI from using its own local configuration;
- replace path policy, tests, or human review.

Portico's safety model is layered: isolated workspace, permission profile, path policy,
tests, artifacts, and explicit apply.

