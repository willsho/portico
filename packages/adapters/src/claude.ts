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
  defaultArgs: ["-p", "--output-format", "stream-json", "--verbose"],
  // Stable, controllable model ids. Injected via `--model` (full name or alias); the
  // CLI also accepts the bare aliases. `default` is informational — we never inject it,
  // so omitting --model leaves the CLI on whatever default it ships with.
  models: {
    static: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", default: true, aliases: ["sonnet"] },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", aliases: ["opus"] },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", aliases: ["haiku"] },
      { id: "claude-fable-5", label: "Claude Fable 5", aliases: ["fable"] },
    ],
  },
  // `claude --model <model>` and `claude --effort <low|medium|high|xhigh|max>` (verified
  // against `claude -p --help`). Empty when unset → CLI default.
  modelArgs: (model) => ["--model", model],
  effortArgs: (effort) => ["--effort", effort],
  capabilityProbe: {
    args: ["-p", "--help"],
    flags: {
      "--include-partial-messages": "partialMessages",
    },
  },
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree). `acceptEdits`
  // auto-approves file edits non-interactively; widen to `bypassPermissions` if the agent
  // also needs Bash. Version-sensitive — overridable per setup.
  autoEditArgs: ["--permission-mode", "acceptEdits"],
  // Resume a prior conversation. Must run in the same cwd — Claude stores each session's
  // transcript per project directory, so the daemon pins cwd alongside the session id.
  resumeArgs: (agentSessionId) => ["--resume", agentSessionId],
};

export const claudeAdapter: AgentAdapter = createStreamJsonAdapter(claudeProvider);
