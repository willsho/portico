import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDaemon } from "../src/server.ts";
import type { Daemon } from "../src/server.ts";
import type { RuntimeEvent } from "@portico/core";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

let daemon: Daemon;
let base: string;

before(async () => {
  daemon = createDaemon({
    config: { port: 0, reloadIntervalMs: 0 },
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await daemon.start();
  base = info.url;
});

after(async () => {
  await daemon.stop();
});

function parseNdjson(text: string): RuntimeEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RuntimeEvent);
}

test("GET /health returns ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, name: "portico", version: "0.1.0" });
});

test("GET /agents lists the discovered fake codex", async () => {
  const res = await fetch(`${base}/agents`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agents: Array<{ provider: string; available: boolean; version?: string }> };
  const codex = body.agents.find((a) => a.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.available, true);
  assert.equal(codex.version, "1.4.2");
});

test("POST /chat streams start -> content -> done as NDJSON", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "codex",
      context: { schemaVersion: "1.0", kind: "article", title: "T", content: "Body" },
      messages: [{ role: "user", content: "What is the key risk?" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /x-ndjson/);
  const events = parseNdjson(await res.text());
  assert.equal(events[0]?.type, "start");
  assert.ok(events.some((e) => e.type === "content"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.match(done?.type === "done" ? done.message : "", /Echo from fake-agent/);
});

test("POST /chat rejects a malformed body", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonsense: true }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "bad_request");
});

test("CORS allows localhost and rejects unlisted origins", async () => {
  const ok = await fetch(`${base}/agents`, { headers: { Origin: "http://localhost:3000" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");

  const blocked = await fetch(`${base}/agents`, { headers: { Origin: "http://evil.example" } });
  assert.equal(blocked.status, 403);
});

test("token auth rejects requests without a bearer token", async () => {
  const secured = createDaemon({
    config: { port: 0, reloadIntervalMs: 0, token: "s3cret" },
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await secured.start();
  try {
    const noAuth = await fetch(`${info.url}/agents`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${info.url}/agents`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    assert.equal(withAuth.status, 200);
  } finally {
    await secured.stop();
  }
});

test("daemon refuses LAN exposure without a token", async () => {
  const lan = createDaemon({
    config: { host: "0.0.0.0", port: 0, lan: true },
    logger: () => {},
  });
  await assert.rejects(() => lan.start(), /token/i);
});
