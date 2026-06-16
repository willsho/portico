// Hermes adapter. Phase 1 (plan §10.4): discovery and capability display only.

import { createDetectOnlyAdapter } from "./detect-only.ts";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const hermesProvider: AgentProvider = {
  id: "hermes",
  displayName: "Hermes",
  commandNames: ["hermes"],
  envPathNames: ["PORTICO_HERMES_PATH"],
  protocols: ["acp", "generic-cli"],
};

export const hermesAdapter: AgentAdapter = createDetectOnlyAdapter(
  hermesProvider,
  "Hermes is installed, but Portico's Hermes adapter does not support automated calls yet (ACP support is planned).",
);
