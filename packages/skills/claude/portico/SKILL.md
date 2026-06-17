---
name: portico
description: Use Portico when a local coding agent should delegate work to another local agent, run it in an isolated worktree, test it, and return a reviewable patch.
allowed-tools: Bash(portico *)
---

# Portico

Use Portico for coding tasks that should be delegated to another local coding agent.

When invoked:

1. Convert the user request into a concise task.
2. Choose the target agent explicitly with `--to`.
3. If the user names a target agent, use that target.
4. If no target is named, delegate to a different capable local agent than the one currently handling the request.
5. Prefer `portico delegate --to <agent> --repo . --task "<task>"`.
6. Include test commands when known, using repeated `--test "<command>"`.
7. Do not manually modify the main working tree for delegated work.
8. Read the generated report path from Portico output.
9. Summarize changed files, test result, risks, and next actions.
10. Ask the user before running `portico apply`.

Common targets:

- From Claude Code to Codex: `portico delegate --to codex --repo . --task "<task>"`
- From Codex to Claude Code: `portico delegate --to claude --repo . --task "<task>"`
- To any configured agent: `portico delegate --to <agent-id> --repo . --task "<task>"`
