// @portico/adapters — provider adapters and one-call registration into the core registry.

import { registerAdapter } from "@portico/core";
import type { AgentAdapter } from "@portico/core";

import { codexAdapter, codexProvider } from "./codex.ts";
import { claudeAdapter, claudeProvider } from "./claude.ts";
import { openclawAdapter, openclawProvider } from "./openclaw.ts";
import { hermesAdapter, hermesProvider } from "./hermes.ts";

export * from "./types.ts";
export { createGenericCliAdapter, genericCliAdapter, genericProvider } from "./generic-cli.ts";
export { createDetectOnlyAdapter } from "./detect-only.ts";
export { codexAdapter, codexProvider } from "./codex.ts";
export { claudeAdapter, claudeProvider } from "./claude.ts";
export { openclawAdapter, openclawProvider } from "./openclaw.ts";
export { hermesAdapter, hermesProvider } from "./hermes.ts";

/** All provider adapters Portico ships with. */
export const builtinAdapters: AgentAdapter[] = [
  codexAdapter,
  claudeAdapter,
  openclawAdapter,
  hermesAdapter,
];

export const builtinProviders = [codexProvider, claudeProvider, openclawProvider, hermesProvider];

/** Register every built-in adapter into the core registry. Call once at startup. */
export function installBuiltinAdapters(): void {
  for (const adapter of builtinAdapters) registerAdapter(adapter);
}
