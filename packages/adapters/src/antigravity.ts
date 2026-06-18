// Antigravity CLI adapter. The public CLI surface is treated as generic run mode
// until a structured protocol is available.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  displayName: "Antigravity CLI",
  commandNames: ["agy", "antigravity"],
  envPathNames: ["PORTICO_ANTIGRAVITY_PATH"],
  protocols: ["generic-cli"],
  defaultArgs: ["run"],
  promptMode: "argument",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  autoEditArgs: ["--dangerously-skip-permissions"],
};

export const antigravityAdapter: AgentAdapter = createGenericCliAdapter(antigravityProvider);
