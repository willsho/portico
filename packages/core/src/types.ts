// Public data structures shared across all Portico packages.
// These are host-agnostic: no host application business types leak in here.

/** Generic context bundle the host app hands to an Agent. Not tied to any domain. */
export interface ContextBundle {
  schemaVersion: "1.0";
  kind: string;
  id?: string;
  title?: string;
  sourceUrl?: string;
  summary?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  attachments?: ContextAttachment[];
  createdAt?: string;
}

export interface ContextAttachment {
  name: string;
  mediaType: string;
  /** Inline content, suitable for small text attachments. */
  content?: string;
  /** Short-lived URL, preferred for large files. */
  url?: string;
  metadata?: Record<string, unknown>;
}

export type AgentProtocol =
  | "generic-cli"
  | "json-stream"
  | "stream-json"
  | "acp"
  | "app-server";

/** Static metadata describing a provider Portico knows how to look for. */
export interface AgentProvider {
  id: string;
  displayName: string;
  /** Executable names to look for on PATH, in priority order. */
  commandNames: string[];
  /** Environment variables that may carry an explicit binary path. */
  envPathNames: string[];
  minVersion?: string;
  protocols: AgentProtocol[];
  /** Default arguments passed to the binary in generic-cli mode. */
  defaultArgs?: string[];
}

/** Runtime discovery result for one provider on this machine. */
export interface AgentEntry {
  provider: string;
  displayName: string;
  available: boolean;
  path?: string;
  version?: string;
  versionStatus?: "ok" | "too_old" | "unknown";
  protocols: AgentProtocol[];
  /** Human-readable explanation, e.g. why it is unavailable. */
  reason?: string;
  /** How the binary path was resolved. Useful for `portico doctor`. */
  source?: "env" | "path" | "login-shell" | "config";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequestOptions {
  cwd?: string;
  timeoutMs?: number;
  stream?: boolean;
  model?: string;
  maxContextChars?: number;
  /** Maximum bytes of stdout to buffer before aborting the child. */
  maxOutputChars?: number;
}

export interface ChatRequest {
  provider: string;
  context?: ContextBundle;
  contextUrl?: string;
  messages: ChatMessage[];
  options?: ChatRequestOptions;
}

/** Unified streaming output event emitted by every adapter. */
export type RuntimeEvent =
  | { type: "start"; sessionId: string; provider: string }
  | { type: "content"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; name: string; input?: unknown }
  | { type: "tool_result"; name: string; output?: unknown }
  | { type: "error"; error: string; code?: string }
  | { type: "done"; message: string; usage?: unknown };

/** Non-serializable runtime context threaded into an adapter run (cancellation, env). */
export interface RunContext {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * An adapter abstracts how one provider is launched and how its output maps
 * onto the unified `RuntimeEvent` stream.
 */
export interface AgentAdapter {
  provider: AgentProvider;
  /** Optionally enrich an entry (e.g. provider-specific capability probing). */
  detect?(entry: AgentEntry): Promise<AgentEntry>;
  /** Render the final prompt string handed to the Agent. */
  buildPrompt(request: ChatRequest): Promise<string>;
  /** Run the Agent and stream unified events. */
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent>;
}
