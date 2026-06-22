import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAdapter, clearAdapters } from "@portico/core";
import type { AgentEntry, AgentProvider, RuntimeEvent } from "@portico/core";
import {
  installBuiltinAdapters,
  antigravityAdapter,
  codexAdapter,
  codexProvider,
  claudeAdapter,
  claudeProvider,
  createGenericCliAdapter,
  cursorProvider,
  geminiProvider,
  openclawProvider,
  openclawAdapter,
  translateCodexJsonLine,
  runCodexJson,
} from "../src/index.ts";

function contentText(events: RuntimeEvent[]): string {
  return events
    .filter((e) => e.type === "content")
    .map((e) => (e.type === "content" ? e.delta : ""))
    .join("");
}

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

async function collect(gen: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("installBuiltinAdapters registers every provider adapter", () => {
  clearAdapters();
  installBuiltinAdapters();
  for (const id of ["codex", "claude", "gemini", "antigravity", "opencode", "cursor", "openclaw", "hermes"]) {
    assert.ok(getAdapter(id), `expected an adapter for ${id}`);
  }
});

test("Codex translator maps real codex exec --json events", () => {
  // agent_message → content (full text on completion, no token deltas).
  const msg = translateCodexJsonLine(
    JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "hello" } }),
  );
  assert.equal(msg[0]?.type, "content");
  assert.equal(msg[0]?.type === "content" ? msg[0].delta : "", "hello");

  // command_execution: started → tool_call, completed → tool_result.
  const started = translateCodexJsonLine(
    JSON.stringify({
      type: "item.started",
      item: { id: "c", type: "command_execution", command: "echo hi", exit_code: null, status: "in_progress" },
    }),
  );
  assert.equal(started[0]?.type, "tool_call");
  assert.equal(started[0]?.type === "tool_call" ? started[0].name : "", "shell");
  const finished = translateCodexJsonLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "c", type: "command_execution", command: "echo hi", aggregated_output: "hi\n", exit_code: 0, status: "completed" },
    }),
  );
  assert.equal(finished[0]?.type, "tool_result");

  // file_change → tool_result on completion.
  const fc = translateCodexJsonLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "f", type: "file_change", changes: [{ path: "/x", kind: "add" }], status: "completed" },
    }),
  );
  assert.equal(fc[0]?.type, "tool_result");

  // turn.completed → done carrying usage.
  const done = translateCodexJsonLine(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 5 } }));
  assert.equal(done[0]?.type, "done");
  assert.deepEqual(done[0]?.type === "done" ? done[0].usage : null, { output_tokens: 5 });

  // Structural / unknown events are ignored and never throw.
  assert.deepEqual(translateCodexJsonLine(JSON.stringify({ type: "turn.started" })), []);
  assert.deepEqual(
    translateCodexJsonLine(JSON.stringify({ type: "item.completed", item: { type: "web_search" } })),
    [],
  );
  assert.ok(Array.isArray(translateCodexJsonLine("{not json")));
});

test("codex adapter appends edit args only when autoEdit is set", async () => {
  // A codex-shaped provider whose args echo back as a Codex NDJSON `content` event,
  // so we can read exactly which flags the adapter assembled.
  const echoProvider: AgentProvider = {
    ...codexProvider,
    defaultArgs: ["--echo-argv-json"],
    autoEditArgs: ["--sandbox", "workspace-write"],
  };
  const entry: AgentEntry = {
    provider: "codex",
    displayName: "Codex",
    available: true,
    path: FAKE_AGENT,
    protocols: ["json-stream"],
  };

  const argvWith = async (autoEdit: boolean): Promise<string[]> => {
    const events = await collect(
      runCodexJson(
        echoProvider,
        { provider: "codex", messages: [{ role: "user", content: "go" }], options: { autoEdit } },
        entry,
      ),
    );
    return JSON.parse(contentText(events)) as string[];
  };

  assert.deepEqual(await argvWith(false), ["--echo-argv-json"]);
  assert.deepEqual(await argvWith(true), ["--echo-argv-json", "--sandbox", "workspace-write"]);
});

test("antigravity adapter uses print mode and passes the prompt through stdin", async () => {
  const entry: AgentEntry = {
    provider: "antigravity",
    displayName: "Antigravity CLI",
    available: true,
    path: FAKE_AGENT,
    protocols: ["generic-cli"],
  };
  const events = await collect(
    antigravityAdapter.run(
      {
        provider: "antigravity",
        messages: [{ role: "user", content: "design a button" }],
        options: { autoEdit: true },
      },
      entry,
      { env: { ...process.env, FAKE_AGENT_ECHO_AGY: "1" } },
    ),
  );
  const text = events
    .filter((event) => event.type === "content")
    .map((event) => (event.type === "content" ? event.delta : ""))
    .join("");
  const payload = JSON.parse(text.trim()) as { args: string[]; stdin: string };
  assert.deepEqual(payload.args, ["-p", "-", "--dangerously-skip-permissions"]);
  assert.match(payload.stdin, /User: design a button/);
  assert.equal(events.at(-1)?.type, "done");
});

test("cursor adapter passes the prompt as an argv value and adds --force only on autoEdit", async () => {
  // A cursor-shaped provider whose args echo back as JSON so we can read exactly
  // which flags the adapter assembled.
  const echo = createGenericCliAdapter({ ...cursorProvider, defaultArgs: ["--echo-argv"] });
  const entry: AgentEntry = {
    provider: "cursor",
    displayName: "Cursor CLI",
    available: true,
    path: FAKE_AGENT,
    protocols: ["generic-cli"],
  };

  const argvWith = async (autoEdit: boolean): Promise<string[]> => {
    const events = await collect(
      echo.run(
        { provider: "cursor", messages: [{ role: "user", content: "do x" }], options: { autoEdit } },
        entry,
      ),
    );
    return JSON.parse(contentText(events)) as string[];
  };

  // Without autoEdit the prompt is passed as the trailing argv value and --force is absent.
  const withoutForce = await argvWith(false);
  assert.ok(!withoutForce.includes("--force"), "expected no --force without autoEdit");
  assert.match(withoutForce.at(-1) ?? "", /do x/);

  // With autoEdit the --force override is appended.
  const withForce = await argvWith(true);
  assert.ok(withForce.includes("--force"), "expected --force with autoEdit");
});

test("generic-cli engine injects --model / --effort from options, and only when set", async () => {
  // A provider with both arg-builders (claude shape) whose args echo back as JSON.
  const echo = createGenericCliAdapter({
    ...cursorProvider,
    defaultArgs: ["--echo-argv"],
    modelArgs: (m) => ["--model", m],
    effortArgs: (e) => ["--effort", e],
  });
  const entry: AgentEntry = {
    provider: "cursor",
    displayName: "Cursor CLI",
    available: true,
    path: FAKE_AGENT,
    protocols: ["generic-cli"],
  };
  const argvWith = async (options: Record<string, unknown>): Promise<string[]> => {
    const events = await collect(
      echo.run({ provider: "cursor", messages: [{ role: "user", content: "do x" }], options }, entry),
    );
    return JSON.parse(contentText(events)) as string[];
  };

  const bare = await argvWith({});
  assert.ok(!bare.includes("--model"), "no --model when unset");
  assert.ok(!bare.includes("--effort"), "no --effort when unset");

  const withSelection = await argvWith({ model: "claude-opus-4-8", effort: "high" });
  assert.deepEqual(withSelection.slice(0, 3), ["--echo-argv", "--model", "claude-opus-4-8"]);
  assert.ok(
    withSelection.includes("--effort") && withSelection[withSelection.indexOf("--effort") + 1] === "high",
    "effort flag forwarded",
  );
});

test("stream-json engine (claude) forwards --model / --effort to the CLI", async () => {
  const entry: AgentEntry = {
    provider: "claude",
    displayName: "Claude Code",
    available: true,
    path: FAKE_AGENT,
    protocols: ["stream-json"],
  };
  const events = await collect(
    claudeAdapter.run(
      {
        provider: "claude",
        messages: [{ role: "user", content: "go" }],
        options: { model: "claude-opus-4-8", effort: "high" },
      },
      entry,
    ),
  );
  const text = contentText(events);
  assert.match(text, /model claude-opus-4-8/);
  assert.match(text, /effort high/);
});

test("claude / codex / gemini providers declare model injection metadata", () => {
  // Arg-builders present (so model selection is "supported", not runtime-managed).
  assert.equal(typeof claudeProvider.modelArgs, "function");
  assert.equal(typeof claudeProvider.effortArgs, "function");
  assert.equal(typeof codexProvider.modelArgs, "function");
  assert.equal(typeof codexProvider.effortArgs, "function");
  assert.equal(typeof geminiProvider.modelArgs, "function");

  // claude ships a static catalog with exactly one default and resolvable aliases.
  const statics = claudeProvider.models?.static ?? [];
  assert.ok(statics.length >= 3, "claude advertises a static model catalog");
  assert.equal(statics.filter((m) => m.default).length, 1, "exactly one default model");
  assert.ok(statics.some((m) => m.aliases?.includes("opus")), "opus alias present");

  // The verified native flags.
  assert.deepEqual(claudeProvider.modelArgs?.("opus"), ["--model", "opus"]);
  assert.deepEqual(claudeProvider.effortArgs?.("high"), ["--effort", "high"]);
  assert.deepEqual(codexProvider.effortArgs?.("high"), ["-c", "model_reasoning_effort=high"]);
});

test("claude adapter parses stream-json into reasoning / tool_call / tool_result", async () => {
  const entry: AgentEntry = {
    provider: "claude",
    displayName: "Claude Code",
    available: true,
    path: FAKE_AGENT,
    protocols: ["stream-json"],
    // Partial token-level streaming is gated on the probed capability.
    capabilities: { partialMessages: true },
  };
  const events = await collect(
    claudeAdapter.run({ provider: "claude", messages: [{ role: "user", content: "echo hi" }] }, entry),
  );
  const types = events.map((e) => e.type);
  assert.equal(types[0], "start");
  assert.ok(types.includes("reasoning"), "expected a reasoning event");
  assert.ok(types.includes("tool_call"), "expected a tool_call event");
  assert.ok(types.includes("tool_result"), "expected a tool_result event");

  const toolCall = events.find((e) => e.type === "tool_call");
  assert.equal(toolCall?.type === "tool_call" ? toolCall.name : "", "Bash");
  const toolResult = events.find((e) => e.type === "tool_result");
  assert.equal(toolResult?.type === "tool_result" ? toolResult.name : "", "Bash");

  // Partial mode streams text/reasoning as multiple token-level deltas that reassemble
  // into the full strings, and never duplicates them from the complete assistant message.
  const contentEvents = events.filter((e) => e.type === "content");
  assert.ok(contentEvents.length >= 2, "expected token-level content deltas");
  const text = contentEvents.map((e) => (e.type === "content" ? e.delta : "")).join("");
  assert.equal(text, "The output was hi.");
  const reasoning = events
    .filter((e) => e.type === "reasoning")
    .map((e) => (e.type === "reasoning" ? e.delta : ""))
    .join("");
  assert.equal(reasoning, "Let me echo that.");

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.type === "done" ? done.message : "", "The output was hi.");
});

test("claude adapter captures the agent session id and forwards resume args", async () => {
  const entry: AgentEntry = {
    provider: "claude",
    displayName: "Claude Code",
    available: true,
    path: FAKE_AGENT,
    protocols: ["stream-json"],
    // Partial token-level streaming is gated on the probed capability.
    capabilities: { partialMessages: true },
  };

  // First turn: the engine should surface the agent's native session id (capture → pin).
  let captured: string | undefined;
  await collect(
    claudeAdapter.run({ provider: "claude", messages: [{ role: "user", content: "hi" }] }, entry, {
      onAgentSession: (id) => {
        captured = id;
      },
    }),
  );
  assert.equal(captured, "fake-1");

  // Resume: the engine should pass `--resume <id>` (provider.resumeArgs); the fake agent
  // echoes the id back into its answer so we can observe it.
  const resumed = await collect(
    claudeAdapter.run({ provider: "claude", messages: [{ role: "user", content: "again" }] }, entry, {
      resumeSessionId: "sess-9",
    }),
  );
  const text = resumed
    .filter((e) => e.type === "content")
    .map((e) => (e.type === "content" ? e.delta : ""))
    .join("");
  assert.match(text, /\(resumed sess-9\)/);
});

test("claude adapter streams partial deltas only when the capability is present", async () => {
  const base: AgentEntry = {
    provider: "claude",
    displayName: "Claude Code",
    available: true,
    path: FAKE_AGENT,
    protocols: ["stream-json"],
  };
  const request = { provider: "claude", messages: [{ role: "user" as const, content: "echo hi" }] };

  // Capability present → `--include-partial-messages` is passed, so the complete
  // assistant message is deduped against the token-level deltas: text appears once.
  const withCap = await collect(
    claudeAdapter.run(request, { ...base, capabilities: { partialMessages: true } }),
  );
  assert.equal(contentText(withCap), "The output was hi.");

  // Capability absent → no partial flag, so the engine can't dedupe and the complete
  // assistant message arrives on top of the (still emitted) deltas: text appears twice.
  const without = await collect(claudeAdapter.run(request, base));
  assert.equal(contentText(without), "The output was hi.The output was hi.");
});

test("detect-only adapter explains why it cannot run", async () => {
  const entry: AgentEntry = {
    provider: openclawProvider.id,
    displayName: openclawProvider.displayName,
    available: true,
    path: "/usr/local/bin/openclaw",
    protocols: openclawProvider.protocols,
  };
  const events = await collect(
    openclawAdapter.run({ provider: "openclaw", messages: [{ role: "user", content: "hi" }] }, entry),
  );
  assert.equal(events[0]?.type, "start");
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : "", "adapter_unsupported");
});
