import type { DelegationEvent } from "@portico/orchestrator";

export interface HttpOptions {
  url?: string;
  token?: string;
}

export function daemonUrl(url?: string): string {
  return (url ?? process.env["PORTICO_URL"] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
}

export function authHeaders(token?: string): Record<string, string> {
  const value = token ?? process.env["PORTICO_TOKEN"];
  return value ? { Authorization: `Bearer ${value}` } : {};
}

export async function fetchWithRetry(input: string, init?: RequestInit, retries = 1): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt >= retries || !isRetryableFetchError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export function describeFetchError(err: unknown, url: string): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: NodeJS.ErrnoException }).cause;
    if (cause?.code === "ECONNREFUSED") return `connection refused talking to daemon at ${url}`;
    if (cause?.code === "ETIMEDOUT") return `request timed out talking to daemon at ${url}`;
    if (cause?.code === "ENOTFOUND") return `daemon host could not be resolved for ${url}`;
    if (err.name === "AbortError") return `request aborted talking to daemon at ${url}`;
    if (err.message === "fetch failed") return `network error talking to daemon at ${url}`;
    return `${err.message} (${url})`;
  }
  return `${String(err)} (${url})`;
}

function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: NodeJS.ErrnoException }).cause;
  return err.message === "fetch failed" || ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"].includes(cause?.code ?? "");
}

export async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T;
  if (!res.ok) {
    const err = body as { error?: string; code?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function* readDelegationStream(res: Response): AsyncGenerator<DelegationEvent> {
  if (!res.ok) {
    const err = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as DelegationEvent;
        newline = buffer.indexOf("\n");
      }
    }
    const line = buffer.trim();
    if (line) yield JSON.parse(line) as DelegationEvent;
  } finally {
    reader.releaseLock();
  }
}
