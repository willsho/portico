// Codex adapter. MVP strategy (plan §10.2): discover `codex`, drive it through the
// generic-cli engine. A dedicated structured protocol is deferred until Codex's
// non-interactive contract is confirmed stable.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const codexProvider: AgentProvider = {
  id: "codex",
  displayName: "Codex",
  commandNames: ["codex"],
  envPathNames: ["PORTICO_CODEX_PATH"],
  protocols: ["app-server", "json-stream", "generic-cli"],
  // Non-interactive subcommand. Tuned per Codex version; safe to override via config.
  defaultArgs: ["exec"],
};

export const codexAdapter: AgentAdapter = createGenericCliAdapter(codexProvider);
