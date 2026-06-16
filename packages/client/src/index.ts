// @portico/client — browser-safe entry point. Talks to a Portico daemon over HTTP.
// For in-process Node usage (no daemon), import from "@portico/client/node".

export {
  createPorticoClient,
  PorticoClientError,
} from "./browser.ts";
export type {
  PorticoClient,
  PorticoClientOptions,
  ChatOptions,
  HealthResponse,
  ClientErrorCode,
} from "./browser.ts";

export { readNdjsonStream } from "./stream.ts";

// Re-exported wire types for convenience (erased at runtime).
export type {
  AgentEntry,
  ChatMessage,
  ChatRequest,
  ContextBundle,
  ContextAttachment,
  RuntimeEvent,
} from "@portico/core";
