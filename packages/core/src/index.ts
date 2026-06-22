// @portico/core — in-process Agent discovery and execution.

export type {
  AgentAdapter,
  AgentEntry,
  AgentModelCatalog,
  AgentProtocol,
  AgentProvider,
  ChatMessage,
  ChatRequest,
  ChatRequestOptions,
  ContextAttachment,
  ContextBundle,
  ModelDescriptor,
  RunContext,
  RuntimeEvent,
} from "./types.ts";

export {
  PorticoError,
  AgentNotFoundError,
  AgentUnavailableError,
  AdapterUnsupportedError,
  AgentTimeoutError,
  isPorticoError,
} from "./errors.ts";
export type { PorticoErrorCode } from "./errors.ts";

export {
  parseSemver,
  compareVersions,
  satisfiesMinVersion,
  versionStatus,
} from "./version.ts";
export type { ParsedVersion, VersionStatus } from "./version.ts";

export { renderPrompt, DEFAULT_MAX_CONTEXT_CHARS } from "./context.ts";
export type { RenderOptions } from "./context.ts";

export { encodeEvent, NdjsonParser, isTerminalEvent } from "./events.ts";

export {
  spawnStream,
  capture,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./runner.ts";
export type { ProcessEvent, SpawnStreamOptions, CaptureResult } from "./runner.ts";

export {
  resolveViaLoginShell,
  loginShellPath,
  candidateShells,
} from "./shell.ts";

export {
  DEFAULT_PROVIDERS,
  registerProvider,
  getProvider,
  listProviders,
  registerAdapter,
  getAdapter,
  listAdapters,
  clearAdapters,
} from "./registry.ts";

export { discoverAgents, discoverAgent } from "./discovery.ts";
export type { DiscoverOptions } from "./discovery.ts";

export { createGenericCliAdapter, runGenericCli, classifyExit, modelInjectionArgs } from "./generic.ts";

export {
  createStreamJsonAdapter,
  runStreamJson,
  translateStreamJsonLine,
} from "./stream-json.ts";

export { runAgent } from "./run.ts";
export type { RunAgentContext } from "./run.ts";

export { createInMemorySessionStore } from "./session.ts";
export type {
  SessionRecord,
  SessionStatus,
  SessionStore,
  CreateSessionInput,
} from "./session.ts";

export {
  discoverModels,
  resolveModel,
  modelSelectionSupported,
  modelKnownIncompatible,
} from "./models.ts";
