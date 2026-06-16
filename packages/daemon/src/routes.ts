// Request handlers. CORS/auth are applied by the server before dispatch, so these
// handlers focus on protocol: JSON for health/agents/reload, NDJSON stream for chat.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runAgent, encodeEvent } from "@portico/core";
import type { AgentEntry, ChatRequest, RuntimeEvent } from "@portico/core";
import type { DaemonConfig } from "./config.ts";

export interface DaemonContext {
  name: string;
  version: string;
  config: DaemonConfig;
  getAgents(): AgentEntry[];
  reload(): Promise<AgentEntry[]>;
  findEntry(provider: string): AgentEntry | undefined;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function handleHealth(_req: IncomingMessage, res: ServerResponse, ctx: DaemonContext): void {
  writeJson(res, 200, { ok: true, name: ctx.name, version: ctx.version });
}

export function handleAgents(_req: IncomingMessage, res: ServerResponse, ctx: DaemonContext): void {
  writeJson(res, 200, { agents: ctx.getAgents() });
}

export async function handleReload(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
): Promise<void> {
  const agents = await ctx.reload();
  writeJson(res, 200, { agents });
}

export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
): Promise<void> {
  let request: ChatRequest;
  try {
    request = await readJsonBody<ChatRequest>(req);
  } catch (err) {
    writeJson(res, 400, { error: (err as Error).message, code: "bad_request" });
    return;
  }

  if (!request || typeof request.provider !== "string" || !Array.isArray(request.messages)) {
    writeJson(res, 400, {
      error: "Body must include a string `provider` and an array `messages`.",
      code: "bad_request",
    });
    return;
  }

  const { limits } = ctx.config;
  const merged: ChatRequest = {
    ...request,
    options: {
      ...request.options,
      timeoutMs: request.options?.timeoutMs ?? limits.defaultTimeoutMs,
      maxContextChars: request.options?.maxContextChars ?? limits.maxContextChars,
      maxOutputChars: request.options?.maxOutputChars ?? limits.maxOutputChars,
    },
  };

  const controller = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const entry = ctx.findEntry(request.provider);

  try {
    for await (const event of runAgent(merged, { signal: controller.signal, entry })) {
      res.write(encodeEvent(event));
    }
  } catch (err) {
    const event: RuntimeEvent = {
      type: "error",
      error: (err as Error).message,
      code: "spawn_failed",
    };
    res.write(encodeEvent(event));
  } finally {
    finished = true;
    res.end();
  }
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Empty request body.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}
