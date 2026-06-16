import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemorySessionStore } from "../src/session.ts";

test("create mints a uuid handle and starts active with zero turns", () => {
  const store = createInMemorySessionStore();
  const rec = store.create({ provider: "claude", cwd: "/tmp/x" });
  assert.match(rec.id, /[0-9a-f-]{36}/);
  assert.equal(rec.provider, "claude");
  assert.equal(rec.cwd, "/tmp/x");
  assert.equal(rec.status, "active");
  assert.equal(rec.turns, 0);
  assert.equal(rec.agentSessionId, undefined);
  assert.deepEqual(store.get(rec.id), rec);
});

test("create honors a supplied id (e.g. an evicted client handle)", () => {
  const store = createInMemorySessionStore();
  const rec = store.create({ id: "fixed-1", provider: "claude" });
  assert.equal(rec.id, "fixed-1");
  assert.equal(store.get("fixed-1")?.id, "fixed-1");
});

test("pinAgentSession records the native resume pointer", () => {
  const store = createInMemorySessionStore();
  const rec = store.create({ provider: "claude" });
  store.pinAgentSession(rec.id, "agent-abc");
  assert.equal(store.get(rec.id)?.agentSessionId, "agent-abc");
});

test("setStatus and touch update status and turn count", () => {
  const store = createInMemorySessionStore();
  const rec = store.create({ provider: "claude" });
  store.touch(rec.id);
  store.touch(rec.id);
  assert.equal(store.get(rec.id)?.turns, 2);
  store.setStatus(rec.id, "interrupted");
  assert.equal(store.get(rec.id)?.status, "interrupted");
});

test("list and delete", () => {
  const store = createInMemorySessionStore();
  const a = store.create({ provider: "claude" });
  store.create({ provider: "codex" });
  assert.equal(store.list().length, 2);
  assert.equal(store.delete(a.id), true);
  assert.equal(store.delete(a.id), false);
  assert.equal(store.list().length, 1);
});

test("mutations on an unknown id are no-ops, not throws", () => {
  const store = createInMemorySessionStore();
  store.pinAgentSession("nope", "x");
  store.setStatus("nope", "ended");
  store.touch("nope");
  assert.equal(store.get("nope"), undefined);
});
