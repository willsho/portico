import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DelegationEvent } from "@portico/orchestrator";
import { readDaemonPid, isProcessAlive } from "../pidfile.ts";
import type { DaemonPidInfo } from "../pidfile.ts";

export interface HttpOptions {
  url?: string;
  token?: string;
}

/**
 * Resolve a `--repo` argument to an absolute path against the *CLI's* cwd before it travels
 * to the daemon. A relative value like `.` must never be sent as-is: the daemon resolves the
 * repo against its *own* cwd (orchestrator `resolveRepo` → `resolve()`), so a relative arg
 * silently retargets the run at whatever directory the daemon was started in — the
 * "ran in the wrong repo" failure. An absolute path is returned unchanged; an unset value
 * defaults to the CLI's cwd (already absolute).
 */
export function resolveRepoArg(repo?: string): string {
  return repo ? resolve(repo) : process.cwd();
}

export function resolveLiveDaemon(env: NodeJS.ProcessEnv = process.env): DaemonPidInfo | null {
  const info = readDaemonPid(env);
  if (info && isProcessAlive(info.pid)) {
    return info;
  }
  return null;
}

export function daemonUrl(url?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (url) return url.replace(/\/$/, "");
  if (env["PORTICO_URL"]) return env["PORTICO_URL"].replace(/\/$/, "");
  
  const live = resolveLiveDaemon(env);
  if (live && live.url) {
    return live.url.replace(/\/$/, "");
  }

  return "http://127.0.0.1:8787";
}

/** Only loopback daemons may be auto-started — LAN/remote daemons must be started explicitly. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Best-effort auto-start of a loopback daemon: spawn `portico start` detached, then poll
 * `/health` until it answers (or a short deadline passes). Returns true when the daemon is
 * reachable afterward. Refuses non-loopback URLs so we never silently launch a process for
 * what should be a remote daemon (plan decision: auto-start is loopback-only).
 */
export async function autoStartDaemon(url: string, token?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | boolean> {
  const live = resolveLiveDaemon(env);
  if (live && live.url) {
    return live.url.replace(/\/$/, "");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isLoopbackHost(parsed.hostname)) return false;

  console.error("[portico] daemon not running — auto-starting it (`portico start`)…");
  const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const startArgs = ["start", "--host", parsed.hostname, "--port", parsed.port || "8787"];
  if (token) startArgs.push("--token", token);
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...startArgs], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const healthUrl = `${url.replace(/\/$/, "")}/health`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { headers: authHeaders(token) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
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
export function classifyFetchError(err: unknown, url: string, env: NodeJS.ProcessEnv = process.env): { message: string; hint: string } {
  const cause = (err as Error & { cause?: NodeJS.ErrnoException })?.cause;
  const code = cause?.code;
  if (code === "ECONNREFUSED") {
    const live = resolveLiveDaemon(env);
    if (live && live.url && live.url.replace(/\/$/, "") !== url.replace(/\/$/, "")) {
      return {
        message: `a daemon is running at ${live.url} — pass \`--url ${live.url}\` or set \`PORTICO_URL\``,
        hint: `you tried to reach ${url} but the running daemon is elsewhere.`,
      };
    }
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
