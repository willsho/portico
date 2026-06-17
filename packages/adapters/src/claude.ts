// Claude Code adapter. Driven in non-interactive print mode with stream-json output
// (`claude -p --output-format stream-json --verbose`, prompt read from stdin), so the
// stream-json engine can surface reasoning / tool_call / tool_result as their own events.
// `--verbose` is required by the CLI whenever stream-json is paired with `--print`.
// `--include-partial-messages` adds token-level deltas so text and reasoning stream live.

import { createStreamJsonAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const claudeProvider: AgentProvider = {
  id: "claude",
  displayName: "Claude Code",
  commandNames: ["claude"],
  envPathNames: ["PORTICO_CLAUDE_PATH"],
  protocols: ["stream-json", "generic-cli"],
  defaultArgs: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree). `acceptEdits`
  // auto-approves file edits non-interactively; widen to `bypassPermissions` if the agent
  // also needs Bash. Version-sensitive — overridable per setup.
  autoEditArgs: ["--permission-mode", "acceptEdits"],
  // Resume a prior conversation. Must run in the same cwd — Claude stores each session's
  // transcript per project directory, so the daemon pins cwd alongside the session id.
  resumeArgs: (agentSessionId) => ["--resume", agentSessionId],
};

export const claudeAdapter: AgentAdapter = createStreamJsonAdapter(claudeProvider);
