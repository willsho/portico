// @portico/adapters — provider adapters and one-call registration into the core registry.

import { registerAdapter } from "@portico/core";
import type { AgentAdapter } from "@portico/core";

import { codexAdapter, codexProvider } from "./codex.ts";
import { claudeAdapter, claudeProvider } from "./claude.ts";
import { geminiAdapter, geminiProvider } from "./gemini.ts";
import { antigravityAdapter, antigravityProvider } from "./antigravity.ts";
import { opencodeAdapter, opencodeProvider } from "./opencode.ts";
import { cursorAdapter, cursorProvider } from "./cursor.ts";
import { openclawAdapter, openclawProvider } from "./openclaw.ts";
import { hermesAdapter, hermesProvider } from "./hermes.ts";

export * from "./types.ts";
export { createGenericCliAdapter, genericCliAdapter, genericProvider } from "./generic-cli.ts";
export { createDetectOnlyAdapter } from "./detect-only.ts";
export { codexAdapter, codexProvider, translateCodexJsonLine, runCodexJson } from "./codex.ts";
export { claudeAdapter, claudeProvider } from "./claude.ts";
export { geminiAdapter, geminiProvider } from "./gemini.ts";
export { antigravityAdapter, antigravityProvider } from "./antigravity.ts";
export { opencodeAdapter, opencodeProvider } from "./opencode.ts";
export { cursorAdapter, cursorProvider } from "./cursor.ts";
export { openclawAdapter, openclawProvider } from "./openclaw.ts";
export { hermesAdapter, hermesProvider } from "./hermes.ts";

/** All provider adapters Portico ships with. */
export const builtinAdapters: AgentAdapter[] = [
  codexAdapter,
  claudeAdapter,
  geminiAdapter,
  antigravityAdapter,
  opencodeAdapter,
  cursorAdapter,
  openclawAdapter,
  hermesAdapter,
];

export const builtinProviders = [
  codexProvider,
  claudeProvider,
  geminiProvider,
  antigravityProvider,
  opencodeProvider,
  cursorProvider,
  openclawProvider,
  hermesProvider,
];

/** Register every built-in adapter into the core registry. Call once at startup. */
export function installBuiltinAdapters(): void {
  for (const adapter of builtinAdapters) registerAdapter(adapter);
}
