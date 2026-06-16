// Claude Code adapter. MVP strategy (plan §10.3): discover `claude`, drive it in
// non-interactive print mode (`claude -p`, reading the prompt from stdin). Streaming
// stream-json output is a later enhancement.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const claudeProvider: AgentProvider = {
  id: "claude",
  displayName: "Claude Code",
  commandNames: ["claude"],
  envPathNames: ["PORTICO_CLAUDE_PATH"],
  protocols: ["stream-json", "generic-cli"],
  // `-p` / `--print`: run once non-interactively and print the result. Reads stdin.
  defaultArgs: ["-p"],
};

export const claudeAdapter: AgentAdapter = createGenericCliAdapter(claudeProvider);
