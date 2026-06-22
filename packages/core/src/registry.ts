// Two registries: the static provider catalog (what to look for during discovery)
// and the adapter registry (how to drive each provider). Both are process-global
// singletons so any package can register without threading a context object around.

import type { AgentAdapter, AgentProvider } from "./types.ts";

/** Providers Portico knows how to discover out of the box. */
export const DEFAULT_PROVIDERS: AgentProvider[] = [
  {
    id: "codex",
    displayName: "Codex",
    commandNames: ["codex"],
    envPathNames: ["PORTICO_CODEX_PATH"],
    protocols: ["app-server", "json-stream", "generic-cli"],
  },
  {
    id: "claude",
    displayName: "Claude Code",
    commandNames: ["claude"],
    envPathNames: ["PORTICO_CLAUDE_PATH"],
    protocols: ["stream-json", "generic-cli"],
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    commandNames: ["gemini"],
    envPathNames: ["PORTICO_GEMINI_PATH"],
    protocols: ["generic-cli"],
    defaultArgs: ["--prompt"],
    promptMode: "argument",
    autoEditArgs: ["--yolo"],
  },
  {
    id: "antigravity",
    displayName: "Antigravity CLI",
    commandNames: ["agy", "antigravity"],
    envPathNames: ["PORTICO_ANTIGRAVITY_PATH"],
    protocols: ["generic-cli"],
    defaultArgs: ["-p", "-"],
    promptMode: "stdin",
    autoEditArgs: ["--dangerously-skip-permissions"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    commandNames: ["opencode"],
    envPathNames: ["PORTICO_OPENCODE_PATH"],
    protocols: ["acp", "generic-cli"],
    defaultArgs: ["run"],
    promptMode: "argument",
    autoEditArgs: ["--dangerously-skip-permissions"],
  },
  {
    id: "cursor",
    displayName: "Cursor CLI",
    commandNames: ["cursor-agent"],
    envPathNames: ["PORTICO_CURSOR_PATH"],
    protocols: ["generic-cli"],
    defaultArgs: ["-p", "--output-format", "text", "--trust"],
    promptMode: "argument",
    autoEditArgs: ["--force"],
  },
  {
    id: "openclaw",
    displayName: "openclaw",
    commandNames: ["openclaw"],
    envPathNames: ["PORTICO_OPENCLAW_PATH"],
    protocols: ["acp", "generic-cli"],
  },
  {
    id: "hermes",
    displayName: "Hermes",
    commandNames: ["hermes"],
    envPathNames: ["PORTICO_HERMES_PATH"],
    protocols: ["acp", "generic-cli"],
  },
];

const providerRegistry = new Map<string, AgentProvider>(
  DEFAULT_PROVIDERS.map((p) => [p.id, p]),
);
const adapterRegistry = new Map<string, AgentAdapter>();

export function registerProvider(provider: AgentProvider): void {
  providerRegistry.set(provider.id, provider);
}

export function getProvider(id: string): AgentProvider | undefined {
  return providerRegistry.get(id);
}

export function listProviders(): AgentProvider[] {
  return [...providerRegistry.values()];
}

/** Register an adapter (and its provider). Overrides any prior adapter for that id. */
export function registerAdapter(adapter: AgentAdapter): void {
  registerProvider(adapter.provider);
  adapterRegistry.set(adapter.provider.id, adapter);
}

export function getAdapter(id: string): AgentAdapter | undefined {
  return adapterRegistry.get(id);
}

export function listAdapters(): AgentAdapter[] {
  return [...adapterRegistry.values()];
}

/** Test/host helper: forget all registered adapters (providers are kept). */
export function clearAdapters(): void {
  adapterRegistry.clear();
}
