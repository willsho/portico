import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDaemon } from "@portico/daemon";
import type { Daemon } from "@portico/daemon";
import { createPorticoClient, PorticoClientError } from "../src/browser.ts";
import { readNdjsonStream } from "../src/stream.ts";
import type { RuntimeEvent } from "@portico/core";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

let daemon: Daemon;
let endpoint: string;

before(async () => {
  daemon = createDaemon({
    config: { port: 0, reloadIntervalMs: 0 },
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await daemon.start();
  endpoint = info.url;
});

after(async () => {
  await daemon.stop();
});

test("readNdjsonStream parses events split across chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"start","sessionId":"s","provider":"codex"}\n{"type":"con'));
      controller.enqueue(encoder.encode('tent","delta":"hi"}\n{"type":"done","message":"hi"}'));
      controller.close();
    },
  });
  const events: RuntimeEvent[] = [];
  for await (const e of readNdjsonStream(stream)) events.push(e);
  assert.equal(events.length, 3);
  assert.equal(events[0]?.type, "start");
  assert.equal(events.at(-1)?.type, "done");
});

test("client health and listAgents talk to the daemon", async () => {
  const client = createPorticoClient({ endpoint });
  const health = await client.health();
  assert.equal(health.ok, true);
  const agents = await client.listAgents();
  assert.ok(agents.find((a) => a.provider === "codex")?.available);
});

test("client chat streams a full answer", async () => {
  const client = createPorticoClient({ endpoint });
  const events: RuntimeEvent[] = [];
  for await (const event of client.chat({
    provider: "codex",
    messages: [{ role: "user", content: "Summarize the key risks." }],
  })) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "start");
  assert.ok(events.some((e) => e.type === "content"));
  assert.equal(events.at(-1)?.type, "done");
});

test("health() throws a typed error when the daemon is unreachable", async () => {
  const client = createPorticoClient({ endpoint: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.health(),
    (err: unknown) => err instanceof PorticoClientError && err.code === "unreachable",
  );
});

test("chat() degrades gracefully to an error event when unreachable", async () => {
  const client = createPorticoClient({ endpoint: "http://127.0.0.1:1" });
  const events: RuntimeEvent[] = [];
  for await (const event of client.chat({ provider: "codex", messages: [] })) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" ? events[0].code : "", "unreachable");
});
