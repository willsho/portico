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

/**
 * Turn a fetch failure into an actionable diagnosis: a short `message` plus a
 * `hint` with the recommended next command. Crucially distinguishes "daemon not
 * running" (ECONNREFUSED) from "sandbox/permission blocked" (EPERM/EACCES) so the
 * user knows whether to start the daemon or relax their sandbox.
 */
export function classifyFetchError(err: unknown, url: string): { message: string; hint: string } {
  const cause = (err as Error & { cause?: NodeJS.ErrnoException })?.cause;
  const code = cause?.code;
  if (code === "ECONNREFUSED") {
    return {
      message: `daemon not running at ${url}`,
      hint: "start it with `portico start` (or pass `--auto-start`), or set PORTICO_URL to a running daemon.",
    };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      message: `permission denied reaching daemon at ${url}`,
      hint: "a sandbox is likely blocking loopback access — grant network access or run outside the sandbox.",
    };
  }
  if (code === "ETIMEDOUT") {
    return { message: `request timed out talking to daemon at ${url}`, hint: "the daemon may be busy; retry, or check `portico runs`." };
  }
  if (code === "ENOTFOUND") {
    return { message: `daemon host could not be resolved for ${url}`, hint: "check your --url / PORTICO_URL value." };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { message: `request aborted talking to daemon at ${url}`, hint: "retry the command." };
  }
  const base = err instanceof Error ? err.message : String(err);
  return { message: `${base} (${url})`, hint: "check that the daemon is running with `portico start`." };
}

/** Print a classified daemon error as two `[portico]` lines (message + hint). */
export function printDaemonError(err: unknown, url: string): void {
  const { message, hint } = classifyFetchError(err, url);
  console.error(`[portico] ${message}`);
  console.error(`[portico] ${hint}`);
}

/**
 * Fetch + JSON-decode with unified daemon-down diagnostics. On a transport
 * failure it prints the classified message/hint and throws a sentinel the
 * command can turn into exit code 1 without re-printing.
 */
export class DaemonUnreachableError extends Error {}

export async function requestJson<T>(url: string, init: RequestInit, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithRetry(url, { ...init, headers: { ...authHeaders(token), ...(init.headers ?? {}) } });
  } catch (err) {
    printDaemonError(err, url);
    throw new DaemonUnreachableError();
  }
  return readJson<T>(res);
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
