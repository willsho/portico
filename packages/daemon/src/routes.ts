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
import type { DelegateRequest, DelegationOrchestrator, RunStatus } from "@portico/orchestrator";
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
      timeoutMs: request.options?.timeoutMs ?? limits.defaultAgentTimeoutMs,
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

  const { limits } = ctx.config;
  request.timeoutMs = request.timeoutMs ?? limits.defaultAgentTimeoutMs;
  request.testTimeoutMs = request.testTimeoutMs ?? limits.defaultTimeoutMs;
  request.idleTimeoutMs = request.idleTimeoutMs ?? limits.idleTimeoutMs;

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
  const url = new URL(req.url ?? "/", "http://localhost");
  const repo = url.searchParams.get("repo") ?? process.cwd();
  const flat = url.searchParams.get("flat") === "true";
  const statusParam = url.searchParams.get("status");
  const sinceParam = url.searchParams.get("since");
  const status = statusParam
    ? (statusParam.split(",").map((s) => s.trim()).filter(Boolean) as RunStatus[])
    : undefined;
  const sinceMs = sinceParam ? Number(sinceParam) : undefined;
  try {
    writeJson(res, 200, {
      runs: await ctx.delegation.listRuns(repo, {
        flat,
        ...(status?.length ? { status } : {}),
        ...(sinceMs !== undefined && Number.isFinite(sinceMs) ? { sinceMs } : {}),
      }),
    });
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleCleanup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
): Promise<void> {
  let body: { failed?: boolean; status?: RunStatus[]; olderThanMs?: number; purge?: boolean } = {};
  if (req.method === "POST") {
    try {
      body = await readJsonBody<typeof body>(req);
    } catch {
      // No body — fall back to defaults (failed + cancelled).
    }
  }
  try {
    writeJson(res, 200, await ctx.delegation.cleanup(repoFromUrl(req), body));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleIntegrateRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  try {
    writeJson(res, 200, await ctx.delegation.integrate(repoFromUrl(req), id));
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
    let opts: { child?: string; all?: boolean; allow?: string[] } | undefined;
    if (req.method === "POST") {
      try {
        const body = await readJsonBody<{ child?: string; all?: boolean; allow?: string[] }>(req);
        if (body.child) opts = { ...opts, child: body.child };
        if (body.all) opts = { ...opts, all: true };
        if (body.allow?.length) opts = { ...opts, allow: body.allow };
      } catch {
        // No body or invalid body — proceed without apply options.
      }
    }
    writeJson(res, 200, await ctx.delegation.apply(repoFromUrl(req), id, opts));
  } catch (err) {
    writeDelegationError(res, err);
  }
}

export async function handleResumeRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  id: string,
): Promise<void> {
  let body: { task: string };
  try {
    body = await readJsonBody<{ task: string }>(req);
  } catch (err) {
    writeJson(res, 400, { error: (err as Error).message, code: "bad_request" });
    return;
  }
  if (!body.task) {
    writeJson(res, 400, { error: "Body must include a string `task`.", code: "bad_request" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  try {
    for await (const event of ctx.delegation.resumeChild(repoFromUrl(req), id, body.task, { findEntry: ctx.findEntry })) {
      res.write(encodeDelegationEvent(event));
    }
  } finally {
    res.end();
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

const BAD_REQUEST_CODES = new Set([
  "bad_request",
  "repo_invalid",
  "mode_unsupported",
  "split_requires_children",
  "split_child_task_required",
  "not_a_group",
  "integrate_unsupported",
]);
const CONFLICT_CODES = new Set([
  "invalid_status",
  "invalid_mode",
  "apply_requires_child",
  "apply_requires_all",
  "merge_conflict",
  "working_tree_dirty",
  "no_ready_children",
  "missing_diff",
]);

function writeDelegationError(res: ServerResponse, err: unknown): void {
  const code = err instanceof DelegationError ? err.code : "internal";
  const status = BAD_REQUEST_CODES.has(code) ? 400 : CONFLICT_CODES.has(code) ? 409 : 500;
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
