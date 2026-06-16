// Helper for providers we can discover but not yet drive non-interactively.
// It still surfaces version/capability info, but a run ends with a clear,
// actionable adapter_unsupported error instead of hanging on an interactive CLI.

import { randomUUID } from "node:crypto";
import { renderPrompt } from "@portico/core";
import type { AgentAdapter, AgentEntry, AgentProvider, ChatRequest, RuntimeEvent } from "@portico/core";

export function createDetectOnlyAdapter(provider: AgentProvider, reason: string): AgentAdapter {
  return {
    provider,
    buildPrompt(request: ChatRequest): Promise<string> {
      return Promise.resolve(renderPrompt(request));
    },
    async *run(request: ChatRequest, entry: AgentEntry): AsyncIterable<RuntimeEvent> {
      yield { type: "start", sessionId: randomUUID(), provider: provider.id };
      if (!entry.available) {
        yield {
          type: "error",
          error: entry.reason ?? `${provider.displayName} is not available on this machine.`,
          code: "agent_unavailable",
        };
        return;
      }
      yield { type: "error", error: reason, code: "adapter_unsupported" };
    },
  };
}
