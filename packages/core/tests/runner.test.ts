import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnStream, capture } from "../src/runner.ts";
import type { ProcessEvent } from "../src/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

async function drain(gen: AsyncIterable<ProcessEvent>): Promise<ProcessEvent[]> {
  const out: ProcessEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("capture reads --version output", async () => {
  const result = await capture(FAKE_AGENT, ["--version"], { timeoutMs: 5000 });
  assert.match(result.stdout, /1\.4\.2/);
  assert.equal(result.code, 0);
});

test("spawnStream streams stdout chunks then a clean exit", async () => {
  const events = await drain(
    spawnStream(FAKE_AGENT, [], { input: "User: hello\n", timeoutMs: 5000 }),
  );
  const exit = events.at(-1);
  assert.equal(exit?.type, "exit");
  assert.equal(exit?.type === "exit" && exit.code, 0);
  const text = events
    .filter((e) => e.type === "stdout")
    .map((e) => (e.type === "stdout" ? e.chunk : ""))
    .join("");
  assert.match(text, /Echo from fake-agent/);
});

test("spawnStream enforces the timeout watchdog", async () => {
  const events = await drain(spawnStream(FAKE_AGENT, ["--hang"], { timeoutMs: 200 }));
  const exit = events.at(-1);
  assert.equal(exit?.type === "exit" && exit.timedOut, true);
});

test("spawnStream enforces the max output cap", async () => {
  const events = await drain(
    spawnStream(FAKE_AGENT, ["--flood"], { maxOutputBytes: 50_000, timeoutMs: 5000 }),
  );
  const exit = events.at(-1);
  assert.equal(exit?.type === "exit" && exit.outputLimited, true);
});

test("spawnStream honors AbortSignal cancellation", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const events = await drain(
    spawnStream(FAKE_AGENT, ["--hang"], { signal: controller.signal, timeoutMs: 5000 }),
  );
  const exit = events.at(-1);
  assert.equal(exit?.type === "exit" && exit.cancelled, true);
});
