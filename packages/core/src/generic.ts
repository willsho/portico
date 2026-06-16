// The generic-cli engine: spawn the binary, pipe the rendered prompt to stdin,
// stream stdout as `content` deltas. This is the universal fallback every provider
// can fall back to, and the basis for the generic-cli adapter.

import { randomUUID } from "node:crypto";
import { spawnStream } from "./runner.ts";
import type { ProcessEvent } from "./runner.ts";
import { renderPrompt } from "./context.ts";
import type {
  AgentAdapter,
  AgentEntry,
  AgentProvider,
  ChatRequest,
  RunContext,
  RuntimeEvent,
} from "./types.ts";

/** Wrap a provider's static metadata into a generic-cli AgentAdapter. */
export function createGenericCliAdapter(provider: AgentProvider): AgentAdapter {
  return {
    provider,
    buildPrompt(request: ChatRequest): Promise<string> {
      return Promise.resolve(renderPrompt(request));
    },
    run(request: ChatRequest, entry: AgentEntry, context?: RunContext): AsyncIterable<RuntimeEvent> {
      return runGenericCli(provider, request, entry, context);
    },
  };
}

export async function* runGenericCli(
  provider: AgentProvider,
  request: ChatRequest,
  entry: AgentEntry,
  context: RunContext = {},
): AsyncIterable<RuntimeEvent> {
  const sessionId = randomUUID();
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
  const args = [...(provider.defaultArgs ?? [])];

  let full = "";
  let stderr = "";
  let failed = false;

  for await (const event of spawnStream(entry.path, args, {
    input: prompt,
    cwd: request.options?.cwd,
    timeoutMs: request.options?.timeoutMs,
    maxOutputBytes: request.options?.maxOutputChars,
    env: context.env,
    signal: context.signal,
  })) {
    if (event.type === "stdout") {
      full += event.chunk;
      yield { type: "content", delta: event.chunk };
    } else if (event.type === "stderr") {
      stderr += event.chunk;
    } else {
      const failure = classifyExit(event, stderr);
      if (failure) {
        failed = true;
        yield failure;
      }
    }
  }

  if (!failed) {
    yield { type: "done", message: full };
  }
}

type ExitEvent = Extract<ProcessEvent, { type: "exit" }>;

function classifyExit(event: ExitEvent, stderr: string): RuntimeEvent | null {
  if (event.cancelled) return { type: "error", error: "Run cancelled by caller.", code: "cancelled" };
  if (event.timedOut) return { type: "error", error: "Agent process timed out.", code: "timeout" };
  if (event.outputLimited)
    return { type: "error", error: "Agent exceeded the maximum output size.", code: "output_limit" };
  if (event.error) return { type: "error", error: event.error, code: "spawn_failed" };
  if (event.code !== 0 && event.code !== null) {
    const detail = stderr.trim() || `Process exited with code ${event.code}.`;
    return { type: "error", error: detail, code: "spawn_failed" };
  }
  return null;
}
