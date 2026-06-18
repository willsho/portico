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
