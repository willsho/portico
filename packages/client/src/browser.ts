// Isomorphic Portico client (browser + Node 18+, both have global fetch).
// Talks to the daemon over HTTP/NDJSON. Never imports Node-only modules.

import type { AgentEntry, ChatRequest, RuntimeEvent } from "@portico/core";
import { readNdjsonStream } from "./stream.ts";

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
}

export type ClientErrorCode = "unreachable" | "http_error" | "bad_response";

export class PorticoClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;
  constructor(code: ClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "PorticoClientError";
    this.code = code;
    this.status = status;
  }
}

export interface PorticoClientOptions {
  /** Daemon base URL, e.g. http://127.0.0.1:8787 */
  endpoint: string;
  /** Bearer token, required when the daemon runs in LAN mode. */
  token?: string;
  /** Custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface PorticoClient {
  /** Resolve when the daemon is reachable; reject with a PorticoClientError otherwise. */
  health(): Promise<HealthResponse>;
  listAgents(): Promise<AgentEntry[]>;
  /** Stream a chat. Yields a terminal `error` event instead of throwing on transport failure. */
  chat(request: ChatRequest, options?: ChatOptions): AsyncIterable<RuntimeEvent>;
  readonly endpoint: string;
}

export function createPorticoClient(options: PorticoClientOptions): PorticoClient {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  const baseHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    return headers;
  };

  async function getJson<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${endpoint}${path}`, { headers: baseHeaders() });
    } catch (err) {
      throw new PorticoClientError("unreachable", `Cannot reach Portico at ${endpoint}: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      throw new PorticoClientError("http_error", `Portico returned HTTP ${res.status} for ${path}.`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new PorticoClientError("bad_response", `Portico returned a non-JSON response for ${path}.`);
    }
  }

  return {
    endpoint,
    health() {
      return getJson<HealthResponse>("/health");
    },
    async listAgents() {
      const body = await getJson<{ agents: AgentEntry[] }>("/agents");
      return body.agents;
    },
    async *chat(request: ChatRequest, chatOptions: ChatOptions = {}): AsyncIterable<RuntimeEvent> {
      let res: Response;
      try {
        res = await doFetch(`${endpoint}/chat`, {
          method: "POST",
          headers: { ...baseHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: chatOptions.signal,
        });
      } catch (err) {
        if (isAbortError(err)) return;
        yield {
          type: "error",
          error: `Cannot reach Portico at ${endpoint}: ${errorMessage(err)}`,
          code: "unreachable",
        };
        return;
      }

      if (!res.ok) {
        const detail = await safeErrorBody(res);
        yield {
          type: "error",
          error: detail.error ?? `Portico returned HTTP ${res.status}.`,
          code: detail.code ?? "http_error",
        };
        return;
      }
      if (!res.body) {
        yield { type: "error", error: "Portico returned an empty stream.", code: "bad_response" };
        return;
      }

      try {
        for await (const event of readNdjsonStream(res.body)) yield event;
      } catch (err) {
        if (isAbortError(err)) return;
        yield { type: "error", error: errorMessage(err), code: "stream_error" };
      }
    },
  };
}

async function safeErrorBody(res: Response): Promise<{ error?: string; code?: string }> {
  try {
    return (await res.json()) as { error?: string; code?: string };
  } catch {
    return {};
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
