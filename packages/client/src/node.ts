// Node-only client. Two ways to call local Agents from Node:
//   1. createInProcessClient() — drive @portico/core directly, no daemon.
//   2. createPorticoClient() (re-exported from ./browser) — talk to a running daemon.

import { runAgent, discoverAgents } from "@portico/core";
import type {
  AgentEntry,
  ChatRequest,
  DiscoverOptions,
  RunAgentContext,
  RuntimeEvent,
} from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";
import { DAEMON_NAME, DAEMON_VERSION } from "@portico/daemon";
import type { HealthResponse, PorticoClient } from "./browser.ts";

export interface InProcessClientOptions {
  discover?: DiscoverOptions;
}

/** A PorticoClient-shaped object that runs Agents in this process (no HTTP). */
export function createInProcessClient(options: InProcessClientOptions = {}): PorticoClient {
  installBuiltinAdapters();
  return {
    endpoint: "in-process",
    health(): Promise<HealthResponse> {
      return Promise.resolve({ ok: true, name: DAEMON_NAME, version: DAEMON_VERSION });
    },
    listAgents(): Promise<AgentEntry[]> {
      return discoverAgents(options.discover);
    },
    chat(request: ChatRequest, chatOptions?: { signal?: AbortSignal }): AsyncIterable<RuntimeEvent> {
      const context: RunAgentContext = chatOptions?.signal ? { signal: chatOptions.signal } : {};
      return runAgent(request, context);
    },
  };
}

export { runAgent, discoverAgents } from "@portico/core";
export {
  createPorticoClient,
  PorticoClientError,
} from "./browser.ts";
export type {
  PorticoClient,
  PorticoClientOptions,
  HealthResponse,
  ChatOptions,
} from "./browser.ts";
