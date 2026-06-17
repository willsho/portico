// Request handlers. CORS/auth are applied by the server before dispatch, so these
// handlers focus on protocol: JSON for health/agents/reload, NDJSON stream for chat.

import type { IncomingMessage, ServerResponse } from "node:http";
import { runAgent, encodeEvent } from "@portico/core";
import type {
  AgentEntry,
  ChatRequest,
  RunAgentContext,
  RuntimeEvent,
  SessionRecord,
  SessionStore,
} from "@portico/core";
import { DelegationError, encodeDelegationEvent } from "@portico/orchestrator";
import type { DelegateRequest, DelegationOrchestrator } from "@portico/orchestrator";
import type { DaemonConfig } from "./config.ts";

export interface DaemonContext {
  name: string;
  version: string;
  config: DaemonConfig;
  getAgents(): AgentEntry[];
  reload(): Promise<AgentEntry[]>;
  findEntry(provider: string): AgentEntry | undefined;
  /** Conversation continuity (resume) store. */
  sessions: SessionStore;
  /** Session ids with a run currently streaming — one writer per transcript. */
  inFlight: Set<string>;
  delegation: DelegationOrchestrator;
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
  const cwd = merged.options?.cwd;

  // Resolve or create the session record. An unknown id (e.g. evicted after a daemon
  // restart) is recreated under the same handle so the client's id stays stable.
  const store = ctx.sessions;
  let record: SessionRecord;
  const existing = request.sessionId ? store.get(request.sessionId) : undefined;
  if (existing) {
    record = existing;
  } else if (request.sessionId) {
    record = store.create({ id: request.sessionId, provider: request.provider, cwd });
  } else {
    record = store.create({ provider: request.provider, cwd });
  }

  // One run per session — concurrent writes to a single transcript corrupt it.
  if (ctx.inFlight.has(record.id)) {
    writeJson(res, 409, { error: "This session already has a run in progress.", code: "session_busy" });
    return;
  }

  // Resume only a clean, same-cwd session that has a pinned agent id; otherwise start fresh.
  const sameCwd = record.cwd === cwd;
  const resumable = record.status === "active" && !!record.agentSessionId && sameCwd;
  const resumeSessionId = resumable ? record.agentSessionId : undefined;
  if (!resumable) {
    record.cwd = cwd;
    if (!sameCwd) record.agentSessionId = undefined;
  }

  const controller = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) controller.abort();
  });

  res.setHeader("X-Portico-Session", record.id);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const runContext: RunAgentContext = {
    signal: controller.signal,
    entry: ctx.findEntry(request.provider),
    sessionId: record.id,
    resumeSessionId,
    onAgentSession: (agentSessionId) => store.pinAgentSession(record.id, agentSessionId),
  };

  ctx.inFlight.add(record.id);
  let sawDone = false;
  let sawError = false;
  try {
    for await (const event of runAgent(merged, runContext)) {
      if (event.type === "done") sawDone = true;
      else if (event.type === "error") sawError = true;
      res.write(encodeEvent(event));
    }
  } catch (err) {
    sawError = true;
    const event: RuntimeEvent = {
      type: "error",
      error: (err as Error).message,
      code: "spawn_failed",
    };
    res.write(encodeEvent(event));
  } finally {
    finished = true;
    ctx.inFlight.delete(record.id);
    // Poison detection: never resume a failed/looping transcript — the next turn starts fresh.
    if (sawError) store.setStatus(record.id, "interrupted");
    else if (sawDone) {
      store.setStatus(record.id, "active");
      store.touch(record.id);
    }
    res.end();
  }
}

export async function handleDelegate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
): Promise<void> {
  let request: DelegateRequest;
  try {
    request = await readJsonBody<DelegateRequest>(req);
  } catch (err) {
    writeJson(res, 400, { error: (err as Error).message, code: "bad_request" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  try {
    for await (const event of ctx.delegation.delegate(request, { findEntry: ctx.findEntry })) {
      res.write(encodeDelegationEvent(event));
    }
  } finally {
    res.end();
  }
}

export async function handleListRuns(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
): Promise<void> {
  const repo = repoFromUrl(req);
  try {
    writeJson(res, 200, { runs: await ctx.delegation.listRuns(repo) });
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleGetRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    writeJson(res, 200, await ctx.delegation.getRun(repoFromUrl(req), id));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    const events = await ctx.delegation.readEvents(repoFromUrl(req), id);
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
    });
    for (const event of events) res.write(encodeDelegationEvent(event));
    res.end();
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleApplyRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    writeJson(res, 200, await ctx.delegation.apply(repoFromUrl(req), id));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleCancelRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    writeJson(res, 200, await ctx.delegation.cancel(repoFromUrl(req), id));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleDiscardRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    writeJson(res, 200, await ctx.delegation.discard(repoFromUrl(req), id));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export function handleListSessions(_req: IncomingMessage, res: ServerResponse, ctx: DaemonContext): void {
  writeJson(res, 200, { sessions: ctx.sessions.list() });
}

export function handleDeleteSession(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): void {
  const existed = ctx.sessions.delete(id);
  if (existed) writeJson(res, 200, { ok: true });
  else writeJson(res, 404, { error: `No session "${id}".`, code: "not_found" });
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function repoFromUrl(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("repo") ?? process.cwd();
}

function writeDelegationError(res: ServerResponse, err: unknown): void {
  const code = err instanceof DelegationError ? err.code : "internal";
  const status = code === "bad_request" ? 400 : code === "repo_invalid" ? 400 : code === "invalid_status" ? 409 : 500;
  writeJson(res, status, { error: err instanceof Error ? err.message : String(err), code });
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
