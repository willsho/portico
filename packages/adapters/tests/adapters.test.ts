import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAdapter, clearAdapters } from "@portico/core";
import type { AgentEntry, RuntimeEvent } from "@portico/core";
import { installBuiltinAdapters, codexAdapter, openclawProvider, openclawAdapter } from "../src/index.ts";

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
  for (const id of ["codex", "claude", "openclaw", "hermes"]) {
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
