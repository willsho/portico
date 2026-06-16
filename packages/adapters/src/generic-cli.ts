// The generic-cli adapter is the universal fallback. Its engine lives in @portico/core
// (so core works standalone); here we expose the factory plus a ready-made provider
// for ad-hoc binaries that aren't in the provider catalog.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentProvider } from "@portico/core";

export { createGenericCliAdapter };

export const genericProvider: AgentProvider = {
  id: "generic",
  displayName: "Generic CLI",
  commandNames: [],
  envPathNames: ["PORTICO_GENERIC_PATH"],
  protocols: ["generic-cli"],
};

export const genericCliAdapter = createGenericCliAdapter(genericProvider);
