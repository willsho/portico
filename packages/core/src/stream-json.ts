// The stream-json engine: drive an Agent that speaks Claude Code's `--output-format
// stream-json` protocol and translate its NDJSON messages into unified RuntimeEvents.
// Where the generic-cli engine dumps all stdout as `content`, this one surfaces the
// Agent's reasoning (`thinking` blocks), tool calls (`tool_use`), and tool results
// (`tool_result`) as their own event types. The line-level translation is a pure
// function so it can be unit-tested without spawning a process.

import { randomUUID } from "node:crypto";
import { spawnStream } from "./runner.ts";
import { renderPrompt } from "./context.ts";
import { classifyExit } from "./generic.ts";
import type {
  AgentAdapter,
  AgentEntry,
  AgentProvider,
  ChatRequest,
  RunContext,
  RuntimeEvent,
} from "./types.ts";

// Minimal shapes we read off Claude Code's stream-json messages. Everything is
// optional because we never trust the wire — unknown shapes degrade gracefully.
interface StreamContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

// A raw Anthropic streaming event, wrapped under stream-json's `event` field when
// `--include-partial-messages` is on (e.g. content_block_delta / text_delta).
interface StreamDelta {
  type?: string;
  text?: string;
  thinking?: string;
}

interface StreamEventBody {
  type?: string;
  delta?: StreamDelta;
}

interface StreamJsonMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  usage?: unknown;
  message?: { content?: StreamContentBlock[] };
  event?: StreamEventBody;
}

/**
 * Translate one stream-json line into zero or more RuntimeEvents.
 *
 * `toolNames` carries tool_use ids → tool name across calls so that a later
 * `tool_result` (which only references the id) can be labelled with its tool.
 *
 * When `partial` is true (`--include-partial-messages`), text and reasoning are
 * streamed token-by-token from `stream_event` deltas; the duplicate complete
 * `assistant` message is then mined only for `tool_use` (its fully-assembled input
 * isn't available in the partial `input_json_delta` fragments).
 */
export function translateStreamJsonLine(
  line: string,
  toolNames: Map<string, string>,
  partial = false,
): RuntimeEvent[] {
  let msg: StreamJsonMessage;
  try {
    msg = JSON.parse(line) as StreamJsonMessage;
  } catch {
    // Not valid JSON — surface the raw text rather than silently dropping it.
    return [{ type: "content", delta: line }];
  }

  const events: RuntimeEvent[] = [];

  switch (msg.type) {
    case "stream_event": {
      // Fine-grained deltas. We only forward text / thinking; signature_delta and
      // input_json_delta (partial tool input) are reassembled elsewhere or ignored.
      if (msg.event?.type === "content_block_delta") {
        const delta = msg.event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          events.push({ type: "content", delta: delta.text });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          events.push({ type: "reasoning", delta: delta.thinking });
        }
      }
      break;
    }
    case "assistant": {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use" && block.name) {
          if (block.id) toolNames.set(block.id, block.name);
          events.push({ type: "tool_call", name: block.name, input: block.input });
        } else if (partial) {
          // text / thinking already streamed via stream_event deltas — skip the dup.
          continue;
        } else if (block.type === "text" && block.text) {
          events.push({ type: "content", delta: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ type: "reasoning", delta: block.thinking });
        }
      }
      break;
    }
    case "user": {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_result") {
          const name =
            (block.tool_use_id && toolNames.get(block.tool_use_id)) || block.tool_use_id || "tool";
          events.push({ type: "tool_result", name, output: block.content });
        }
      }
      break;
    }
    case "result": {
      const text = typeof msg.result === "string" ? msg.result : "";
      if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
        events.push({
          type: "error",
          error: text || `Agent ended with "${msg.subtype ?? "error"}".`,
          code: "agent_error",
        });
      } else {
        events.push(
          msg.usage !== undefined
            ? { type: "done", message: text, usage: msg.usage }
            : { type: "done", message: text },
        );
      }
      break;
    }
    // `system` (init), `rate_limit_event`, partial `stream_event`, etc. carry no
    // user-facing payload in this engine — ignore them.
    default:
      break;
  }

  return events;
}

/** Run an Agent in stream-json mode and stream unified events. */
export async function* runStreamJson(
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
  const baseArgs = [...(provider.defaultArgs ?? [])];
  const editArgs = request.options?.autoEdit ? (provider.autoEditArgs ?? []) : [];
  const resumeArgs =
    context.resumeSessionId && provider.resumeArgs ? provider.resumeArgs(context.resumeSessionId) : [];
  const args = [...baseArgs, ...editArgs, ...resumeArgs];
  if (entry.capabilities?.partialMessages) {
    args.push("--include-partial-messages");
  }
  const partial = args.includes("--include-partial-messages");

  const toolNames = new Map<string, string>();
  let buffer = "";
  let stderr = "";
  let lastText = "";
  let failed = false;
  let sawTerminal = false;

  // Capture → pin: surface the agent's native session id the first time it appears
  // (it rides on every message; the `system`/`init` line is first). Reported once.
  let agentSessionCaptured = false;
  function captureAgentSession(line: string): void {
    if (agentSessionCaptured || !context.onAgentSession || !line.includes('"session_id"')) return;
    try {
      const parsed = JSON.parse(line) as { session_id?: unknown };
      if (typeof parsed.session_id === "string") {
        agentSessionCaptured = true;
        context.onAgentSession(parsed.session_id);
      }
    } catch {
      // partial / non-JSON line — try again on the next one
    }
  }

  function* handleLine(line: string): Generator<RuntimeEvent> {
    if (!line.trim()) return;
    captureAgentSession(line);
    for (const event of translateStreamJsonLine(line, toolNames, partial)) {
      if (event.type === "content") lastText += event.delta;
      if (event.type === "done" || event.type === "error") sawTerminal = true;
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

  // Process ended cleanly but never emitted a terminal `result` — synthesize a
  // `done` from whatever assistant text streamed so consumers always terminate.
  if (!failed && !sawTerminal) {
    yield { type: "done", message: lastText };
  }
}

/** Wrap a provider into an AgentAdapter driven by the stream-json engine. */
export function createStreamJsonAdapter(provider: AgentProvider): AgentAdapter {
  return {
    provider,
    buildPrompt(request: ChatRequest): Promise<string> {
      return Promise.resolve(renderPrompt(request));
    },
    run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent> {
      return runStreamJson(provider, request, entry, context);
    },
  };
}
