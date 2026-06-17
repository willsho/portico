import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverAgent, discoverAgents } from "../src/discovery.ts";
import { getProvider } from "../src/registry.ts";
import { runAgent } from "../src/run.ts";
import type { RuntimeEvent } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

test("discoverAgent resolves an explicit env path and probes its version", async () => {
  const codex = getProvider("codex")!;
  const entry = await discoverAgent(codex, {
    // Keep a real PATH so the fake agent's `#!/usr/bin/env node` shebang can run.
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    skipLoginShell: true,
  });
  assert.equal(entry.available, true);
  assert.equal(entry.source, "env");
  assert.equal(entry.path, FAKE_AGENT);
  assert.equal(entry.version, "1.4.2");
  assert.equal(entry.versionStatus, "ok");
});

test("discoverAgent reports unavailable when nothing resolves", async () => {
  const hermes = getProvider("hermes")!;
  const entry = await discoverAgent(hermes, {
    env: { PATH: "" },
    skipLoginShell: true,
  });
  assert.equal(entry.available, false);
  assert.match(entry.reason ?? "", /Not found/);
});

test("discoverAgents returns one entry per registered provider", async () => {
  const entries = await discoverAgents({ env: { PATH: "" }, skipLoginShell: true, skipVersion: true });
  const ids = entries.map((e) => e.provider).sort();
  assert.deepEqual(ids, ["antigravity", "claude", "codex", "gemini", "hermes", "openclaw", "opencode"]);
});

test("runAgent streams start -> content -> done through the generic-cli engine", async () => {
  const events: RuntimeEvent[] = [];
  for await (const event of runAgent(
    {
      provider: "codex",
      messages: [{ role: "user", content: "What is the strongest counterargument?" }],
    },
    { env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT } },
  )) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "start");
  assert.ok(events.some((e) => e.type === "content"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.match(done?.type === "done" ? done.message : "", /Echo from fake-agent/);
});

test("runAgent yields agent_not_found for an unknown provider", async () => {
  const events: RuntimeEvent[] = [];
  for await (const event of runAgent({ provider: "nope", messages: [] })) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" ? events[0].code : "", "agent_not_found");
});
