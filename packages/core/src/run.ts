// High-level entry point: resolve the right adapter for a request and stream events.
// Falls back to the generic-cli engine when no provider-specific adapter is registered.

import { getAdapter, getProvider } from "./registry.ts";
import { createGenericCliAdapter } from "./generic.ts";
import { discoverAgent } from "./discovery.ts";
import type { AgentEntry, ChatRequest, RunContext, RuntimeEvent } from "./types.ts";

export interface RunAgentContext extends RunContext {
  /** Pre-discovered entry, to avoid re-running discovery per request. */
  entry?: AgentEntry;
}

/**
 * Run a chat request against a provider and stream unified events.
 * Always yields a `start` first (via the adapter) and terminates with `done` or `error`.
 */
export async function* runAgent(
  request: ChatRequest,
  context: RunAgentContext = {},
): AsyncIterable<RuntimeEvent> {
  const provider = getProvider(request.provider);
  if (!provider) {
    yield {
      type: "error",
      error: `No provider registered with id "${request.provider}".`,
      code: "agent_not_found",
    };
    return;
  }

  const adapter = getAdapter(request.provider) ?? createGenericCliAdapter(provider);
  const entry = context.entry ?? (await discoverAgent(provider, { env: context.env }));

  yield* adapter.run(request, entry, { signal: context.signal, env: context.env });
}
