# Skills

Portico ships a canonical Skill that teaches local coding agents how to delegate work
through Portico instead of directly invoking another agent.

The skill is for agent-to-agent orchestration. It does not replace the daemon, CLI, path
policy, tests, or apply gate.

## Generated Skill Files

Run:

```bash
portico init
```

Inside the current git repository, Portico writes:

```text
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

The Portico-managed skill files at those exact paths are refreshed from the canonical
bundled Skill on every `init` run. Other project-level skills are not touched.

## Canonical Source

The source of truth is:

```text
packages/skills/portico/SKILL.md
```

The CLI renders two variants:

| Target | Output | Difference |
| --- | --- | --- |
| Claude Code | `.claude/skills/portico/SKILL.md` | Keeps `allowed-tools` frontmatter |
| Codex-style loaders | `.agents/skills/portico/SKILL.md` | Removes the `allowed-tools` line |

The body is otherwise the same.

## What the Skill Teaches

The Skill tells the current agent to:

- use Portico when work should be handed to another local agent;
- pick a target with `--to <agent>`;
- write a self-contained task prompt;
- run `portico delegate`;
- read `report.md` and `result.json`;
- summarize changed files, tests, and risks;
- ask before applying;
- never call another agent directly;
- avoid nested delegation.

The skill also documents review and compare flows:

```bash
portico delegate --mode review --to claude --repo . --task "<review task>"
```

```bash
portico delegate --mode compare --to codex --compare-to claude --repo . --task "<task>"
```

## Tool Access

The Claude variant includes:

```yaml
allowed-tools: Bash(portico *), Read
```

That means the skill is designed around the Portico CLI and read access to artifacts. It
does not grant broad shell access by itself.

The Codex-style variant removes this frontmatter line because not every loader understands
Claude's `allowed-tools` field.

## Agent Responsibilities

When using the skill, the current agent remains the orchestrator. It should:

- make the delegation task specific enough for a fresh worker process;
- include acceptance criteria;
- specify test commands when the user gave them;
- use `--allowed` and `--forbidden` when path boundaries matter;
- inspect artifacts after the run;
- present the result to the user;
- ask before `portico apply`.

The target agent is a worker. It should complete the task in the execution workspace and
leave changes on disk.

## Self-Contained Tasks

The delegated agent does not inherit the current conversation. A good skill-mediated task
includes:

- goal;
- files or directories to inspect first;
- constraints;
- expected behavior;
- verification steps;
- what not to touch.

Example:

```bash
portico delegate --to codex --repo . \
  --task "In packages/cli/src/commands/delegate.ts add a --dry-run flag that validates input but does not call /delegate. Add tests near packages/cli/tests. Done when npm test passes." \
  --test "npm test"
```

## Apply Discipline

The skill is strict about apply:

- never run `portico apply` without explicit user approval;
- apply only ready implementation runs;
- apply the selected candidate run after compare, not the compare parent;
- discard worktrees when they are no longer needed.

## Updating the Skill

Edit the canonical file:

```text
packages/skills/portico/SKILL.md
```

Then rerun `portico init` in each repository that should receive the updated generated
Skill files.

Because `init` refreshes Portico's managed output files, put project-specific guidance in
separate project-level skills instead of editing `.claude/skills/portico/SKILL.md` or
`.agents/skills/portico/SKILL.md` directly.

## When Not to Use the Skill

Do not use the Portico skill for:

- questions the current agent can answer directly;
- tiny edits the current agent should make itself;
- workflows where another agent adds no value;
- chaining delegation from inside a Portico worktree.
