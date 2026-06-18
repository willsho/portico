// OpenCode adapter. OpenCode documents `opencode run [message..]` as the
// non-interactive command, so the rendered prompt is appended as an argv value.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const opencodeProvider: AgentProvider = {
  id: "opencode",
  displayName: "OpenCode",
  commandNames: ["opencode"],
  envPathNames: ["PORTICO_OPENCODE_PATH"],
  protocols: ["acp", "generic-cli"],
  defaultArgs: ["run"],
  promptMode: "argument",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  autoEditArgs: ["--dangerously-skip-permissions"],
};

export const opencodeAdapter: AgentAdapter = createGenericCliAdapter(opencodeProvider);
