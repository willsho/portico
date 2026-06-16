// openclaw adapter. Phase 1 (plan §10.4): discovery and capability display only.
// Automated /chat over ACP is a phase-2 deliverable.

import { createDetectOnlyAdapter } from "./detect-only.ts";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const openclawProvider: AgentProvider = {
  id: "openclaw",
  displayName: "openclaw",
  commandNames: ["openclaw"],
  envPathNames: ["PORTICO_OPENCLAW_PATH"],
  protocols: ["acp", "generic-cli"],
};

export const openclawAdapter: AgentAdapter = createDetectOnlyAdapter(
  openclawProvider,
  "openclaw is installed, but Portico's openclaw adapter does not support automated calls yet (ACP support is planned).",
);
