// Codex adapter. Drives `codex exec --json`, whose newline-delimited JSON events
// (calibrated against codex 0.141.0) are translated into unified RuntimeEvents so
// reasoning, shell calls, file edits and usage surface as their own event types.
//
// Real event shapes (one JSON object per stdout line):
//   {"type":"thread.started","thread_id":"…"}                  ← native session id
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id","type",…}}
//   {"type":"item.completed","item":{"id","type",…}}
//   {"type":"turn.completed","usage":{…}}
// item.type ∈ { agent_message, command_execution, file_change, reasoning, … }.
// Unknown shapes are ignored so the parser degrades gracefully and never throws.

import { randomUUID } from "node:crypto";
import { renderPrompt, spawnStream, classifyExit } from "@portico/core";
import type {
  AgentAdapter,
  AgentProvider,
  AgentEntry,
  ChatRequest,
  RunContext,
  RuntimeEvent,
} from "@portico/core";

export const codexProvider: AgentProvider = {
  id: "codex",
  displayName: "Codex",
  commandNames: ["codex"],
  envPathNames: ["PORTICO_CODEX_PATH"],
  protocols: ["app-server", "json-stream", "generic-cli"],
  // Non-interactive JSONL mode. `--skip-git-repo-check` lets it run outside a git repo
  // (e.g. probe/temp dirs). Tuned per Codex version; overridable via config.
  defaultArgs: ["exec", "--json", "--skip-git-repo-check"],
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree). `--full-auto`
  // was deprecated in favor of an explicit sandbox policy; `workspace-write` lets the agent
  // edit files in its cwd without approval prompts. Version-sensitive — overridable per setup.
  autoEditArgs: ["--sandbox", "workspace-write"],
  // `codex exec --model <id>` and reasoning effort via a config override (verified against
  // `codex exec --help`). No static catalog: Codex's model ids aren't authoritatively
  // known here, so we pass any value through rather than risk false-rejecting a valid one.
  modelArgs: (model) => ["--model", model],
  effortArgs: (effort) => ["-c", `model_reasoning_effort=${effort}`],
};

/** Translate one `item.{started,completed}` payload into zero or more RuntimeEvents. */
function translateCodexItem(item: unknown, phase: "started" | "completed"): RuntimeEvent[] {
  if (!item || typeof item !== "object") return [];
  const it = item as Record<string, unknown>;
  switch (it.type) {
    case "agent_message":
      // The full message text arrives once, on completion (no token-level deltas).
      return phase === "completed" && typeof it.text === "string"
        ? [{ type: "content", delta: it.text }]
        : [];
    case "reasoning":
      // Shape inferred (not captured in calibration); guarded so a mismatch just no-ops.
      return phase === "completed" && typeof it.text === "string"
        ? [{ type: "reasoning", delta: it.text }]
        : [];
    case "command_execution":
      return phase === "started"
        ? [{ type: "tool_call", name: "shell", input: { command: it.command } }]
        : [
            {
              type: "tool_result",
              name: "shell",
              output: { output: it.aggregated_output, exitCode: it.exit_code },
            },
          ];
    case "file_change":
      return phase === "started"
        ? [{ type: "tool_call", name: "file_change", input: { changes: it.changes } }]
        : [{ type: "tool_result", name: "file_change", output: { changes: it.changes } }];
    default:
      // mcp_tool_call / web_search / todo_list / unknown — ignore for now.
      return [];
  }
}

/** Translate one line of `codex exec --json` output into RuntimeEvents (pure, testable). */
export function translateCodexJsonLine(line: string): RuntimeEvent[] {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // codex --json emits pure JSONL on stdout; a stray non-JSON line is unexpected, but
    // surface it as content rather than dropping it (mirrors the stream-json engine).
    return line.trim() ? [{ type: "content", delta: line }] : [];
  }
  if (!msg || typeof msg !== "object") return [];

  switch (msg.type) {
    case "item.started":
      return translateCodexItem(msg.item, "started");
    case "item.completed":
      return translateCodexItem(msg.item, "completed");
    case "turn.completed":
      // The terminal event. Carries usage; the run loop fills in the message text.
      return msg.usage !== undefined
        ? [{ type: "done", message: "", usage: msg.usage }]
        : [{ type: "done", message: "" }];
    case "error":
      return [
        {
          type: "error",
          error: typeof msg.message === "string" ? msg.message : "Codex reported an error.",
          code: "agent_error",
        },
      ];
    // thread.started (session capture, handled in the run loop) and turn.started carry no
    // user-facing payload.
    default:
      return [];
  }
}

export async function* runCodexJson(
  provider: AgentProvider,
  request: ChatRequest,
  entry: AgentEntry,
  context: RunContext = {},
): AsyncIterable<RuntimeEvent> {
  const sessionId = context.sessionId ?? randomUUID();
  yield { type: "start", sessionId, provider: provider.id };

  if (!entry.available || !entry.path) {
    yield {
      type: "error",
      error: entry.reason ?? `${provider.displayName} is not available on this machine.`,
      code: "agent_unavailable",
    };
    return;
  }

  const prompt = renderPrompt(request);
  const editArgs = request.options?.autoEdit ? (provider.autoEditArgs ?? []) : [];
  const resumeArgs =
    context.resumeSessionId && provider.resumeArgs ? provider.resumeArgs(context.resumeSessionId) : [];
  const args = [...(provider.defaultArgs ?? []), ...editArgs, ...resumeArgs];

  let buffer = "";
  let stderr = "";
  let lastText = "";
  let failed = false;
  let sawTerminal = false;

  // Capture → pin the native session id (codex's `thread_id`). Only when the provider can
  // actually resume; otherwise leaving it unset keeps resume as a clean resume_unsupported.
  let threadCaptured = false;
  function captureThread(line: string): void {
    if (threadCaptured || !context.onAgentSession || !provider.resumeArgs) return;
    if (!line.includes("thread.started")) return;
    try {
      const parsed = JSON.parse(line) as { type?: string; thread_id?: unknown };
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        threadCaptured = true;
        context.onAgentSession(parsed.thread_id);
      }
    } catch {
      // partial / non-JSON line — try again on the next one
    }
  }

  function* handleLine(line: string): Generator<RuntimeEvent> {
    if (!line.trim()) return;
    captureThread(line);
    for (const event of translateCodexJsonLine(line)) {
      if (event.type === "content") lastText += event.delta;
      if (event.type === "done") {
        sawTerminal = true;
        // turn.completed has no text; the answer is the accumulated agent_message content.
        yield event.usage !== undefined
          ? { type: "done", message: lastText, usage: event.usage }
          : { type: "done", message: lastText };
        continue;
      }
      if (event.type === "error") sawTerminal = true;
      yield event;
    }
  }

  for await (const event of spawnStream(entry.path, args, {
    input: prompt,
    cwd: request.options?.cwd,
    timeoutMs: request.options?.timeoutMs,
    maxOutputBytes: request.options?.maxOutputChars,
    env: context.env,
    signal: context.signal,
  })) {
    if (event.type === "stdout") {
      buffer += event.chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield* handleLine(line);
        nl = buffer.indexOf("\n");
      }
    } else if (event.type === "stderr") {
      stderr += event.chunk;
    } else {
      const failure = classifyExit(event, stderr);
      if (failure && !sawTerminal) {
        failed = true;
        yield failure;
      }
    }
  }

  // Flush a trailing line that wasn't newline-terminated.
  if (buffer.trim()) yield* handleLine(buffer);

  // Process ended cleanly but never emitted turn.completed — synthesize a `done`.
  if (!failed && !sawTerminal) {
    yield { type: "done", message: lastText };
  }
}

export const codexAdapter: AgentAdapter = {
  provider: codexProvider,
  buildPrompt(request: ChatRequest): Promise<string> {
    return Promise.resolve(renderPrompt(request));
  },
  run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent> {
    return runCodexJson(codexProvider, request, entry, context);
  },
};
