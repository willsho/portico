// Adapter-facing types. The adapter contract lives in @portico/core; we re-export
// it here so adapter authors can depend on a single, stable surface.

export type {
  AgentAdapter,
  AgentEntry,
  AgentProvider,
  AgentProtocol,
  ChatRequest,
  RunContext,
  RuntimeEvent,
} from "@portico/core";
