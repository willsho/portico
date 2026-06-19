import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAdapter, clearAdapters } from "@portico/core";
import type { AgentEntry, RuntimeEvent } from "@portico/core";
import {
  installBuiltinAdapters,
  antigravityAdapter,
  codexAdapter,
  claudeAdapter,
  openclawProvider,
  openclawAdapter,
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
  for (const id of ["codex", "claude", "gemini", "antigravity", "opencode", "openclaw", "hermes"]) {
    assert.ok(getAdapter(id), `expected an adapter for ${id}`);
  }
});

test("codex adapter drives a binary through the generic-cli engine", async () => {
  const entry: AgentEntry = {
    provider: "codex",
    displayName: "Codex",
    available: true,
    path: FAKE_AGENT,
    protocols: ["generic-cli"],
  };
  const events = await collect(
    codexAdapter.run(
      { provider: "codex", messages: [{ role: "user", content: "ping" }] },
      entry,
    ),
  );
  assert.equal(events[0]?.type, "start");
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.match(done?.type === "done" ? done.message : "", /Echo from fake-agent/);
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
