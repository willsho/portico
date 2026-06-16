// Stable error codes so callers (and the daemon) can branch without string matching.

export type PorticoErrorCode =
  | "agent_not_found"
  | "agent_unavailable"
  | "adapter_unsupported"
  | "timeout"
  | "output_limit"
  | "spawn_failed"
  | "cancelled"
  | "bad_request"
  | "config_invalid";

export class PorticoError extends Error {
  readonly code: PorticoErrorCode;

  constructor(code: PorticoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PorticoError";
    this.code = code;
  }
}

export class AgentNotFoundError extends PorticoError {
  constructor(provider: string) {
    super("agent_not_found", `No provider registered with id "${provider}".`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentUnavailableError extends PorticoError {
  constructor(provider: string, reason?: string) {
    super(
      "agent_unavailable",
      `Agent "${provider}" is not available on this machine${reason ? `: ${reason}` : "."}`,
    );
    this.name = "AgentUnavailableError";
  }
}

export class AdapterUnsupportedError extends PorticoError {
  constructor(provider: string, reason?: string) {
    super(
      "adapter_unsupported",
      reason ?? `The current adapter cannot drive "${provider}" non-interactively yet.`,
    );
    this.name = "AdapterUnsupportedError";
  }
}

export class AgentTimeoutError extends PorticoError {
  constructor(timeoutMs: number) {
    super("timeout", `Agent process exceeded the ${timeoutMs}ms timeout.`);
    this.name = "AgentTimeoutError";
  }
}

export function isPorticoError(value: unknown): value is PorticoError {
  return value instanceof PorticoError;
}
