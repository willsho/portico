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

/** One model a provider can run. `id` is the value handed to the CLI's model flag. */
export interface ModelDescriptor {
  id: string;
  /** Human- / agent-friendly name; defaults to `id` when omitted. */
  label?: string;
  /** The provider's own default. Informational only — Portico never auto-injects it
   *  (omitting the flag lets the CLI pick its default, which survives CLI upgrades). */
  default?: boolean;
  /** Accepted shorthands, e.g. "opus" -> "claude-opus-4-8". */
  aliases?: string[];
  /** Reasoning-effort levels this model supports; falls back to the provider's. */
  effortLevels?: string[];
}

/** How a provider advertises its model catalog: a static list, a live probe, or both. */
export interface AgentModelCatalog {
  /** Hardcoded models with stable, controllable ids (claude / codex / gemini). */
  static?: ModelDescriptor[];
  /** Ask the CLI for its live catalog (cursor / opencode …). Reuses the probe runner. */
  probe?: {
    args: string[];
    timeoutMs?: number;
    parse: (stdout: string, stderr: string) => ModelDescriptor[];
  };
}

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
  /** Model catalog (static list and/or live probe). Absent → unknown, pass through. */
  models?: AgentModelCatalog;
  /**
   * Translate a chosen model into native CLI args, appended only when a request sets
   * `options.model` (claude: `m => ["--model", m]`). Absent → model selection is
   * "managed by runtime": the flag is ignored. Mirrors `resumeArgs` / `autoEditArgs`.
   */
  modelArgs?: (model: string) => string[];
  /** Translate a chosen reasoning effort into native CLI args (claude: `e => ["--effort", e]`). */
  effortArgs?: (effort: string) => string[];
  /**
   * How the generic-cli engine passes the rendered prompt. Defaults to stdin.
   * Use "argument" for CLIs whose non-interactive mode requires the prompt in argv.
   */
  promptMode?: "stdin" | "argument";
  /**
   * Extra arguments that grant the agent autonomous file-editing permission, appended
   * only when a request opts in via `options.autoEdit` (e.g. delegation runs in an
   * isolated worktree). Kept out of `defaultArgs` so plain chat stays read-only.
   */
  autoEditArgs?: string[];
  /**
   * Build CLI args that resume a prior agent session, if the provider supports it.
   * Providers without this can't be resumed (the engine ignores `resumeSessionId`).
   */
  resumeArgs?: (agentSessionId: string) => string[];
  versionArgs?: string[];
  capabilityProbe?: AgentCapabilityProbe;
}

export interface AgentCapabilityProbe {
  args: string[];
  timeoutMs?: number;
  /** flag string -> capability key, considered supported if present. */
  flags: Record<string, string>;
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
  capabilities?: Record<string, boolean>;
  /** Models this provider can run, filled on demand by discoverModels() (not by discoverAgents). */
  models?: ModelDescriptor[];
  /** Whether the runtime accepts a model choice (provider declares modelArgs) or self-manages it. */
  modelSelection?: "supported" | "managed-by-runtime";
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
  /** Reasoning-effort override, injected via `provider.effortArgs` when supported. */
  effort?: string;
  maxContextChars?: number;
  /** Maximum bytes of stdout to buffer before aborting the child. */
  maxOutputChars?: number;
  /**
   * Opt in to the provider's autonomous editing mode (appends `provider.autoEditArgs`).
   * Defaults to off so plain chat never gains write access; delegation runs set it.
   */
  autoEdit?: boolean;
}

export interface ChatRequest {
  provider: string;
  context?: ContextBundle;
  contextUrl?: string;
  messages: ChatMessage[];
  options?: ChatRequestOptions;
  /** Continue a prior Portico session (handle from a previous `start` event). */
  sessionId?: string;
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
  /** Portico session id to stamp on the `start` event (else a per-run UUID). */
  sessionId?: string;
  /** When set (and the provider supports resume), continue this agent session. */
  resumeSessionId?: string;
  /** Called once with the agent's native session id when first seen (capture → pin). */
  onAgentSession?: (agentSessionId: string) => void;
  /** Called whenever the agent process exhibits activity (e.g. stdout or stderr output) to reset the idle watchdog timer. */
  onActivity?: () => void;
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
