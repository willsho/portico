// Antigravity CLI adapter. Print mode is the supported non-interactive surface.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  displayName: "Antigravity CLI",
  commandNames: ["agy", "antigravity"],
  envPathNames: ["PORTICO_ANTIGRAVITY_PATH"],
  protocols: ["generic-cli"],
  defaultArgs: ["-p", "-"],
  promptMode: "stdin",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  autoEditArgs: ["--dangerously-skip-permissions"],
};

export const antigravityAdapter: AgentAdapter = createGenericCliAdapter(antigravityProvider);
