import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEvent, NdjsonParser, isTerminalEvent } from "../src/events.ts";
import type { RuntimeEvent } from "../src/types.ts";

test("encodeEvent produces one newline-terminated JSON line", () => {
  const line = encodeEvent({ type: "content", delta: "hi" });
  assert.equal(line, '{"type":"content","delta":"hi"}\n');
});

test("NdjsonParser reassembles events split across chunks", () => {
  const parser = new NdjsonParser();
  const events: RuntimeEvent[] = [];
  events.push(...parser.push('{"type":"start","sessionId":"s","provider":"codex"}\n{"type":"con'));
  events.push(...parser.push('tent","delta":"a"}\n{"type":"content","delta":"b"}\n'));
  events.push(...parser.push('{"type":"done","message":"ab"}'));
  events.push(...parser.flush());

  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { type: "start", sessionId: "s", provider: "codex" });
  assert.deepEqual(events[1], { type: "content", delta: "a" });
  assert.deepEqual(events[3], { type: "done", message: "ab" });
});

test("NdjsonParser surfaces malformed lines as error events", () => {
  const parser = new NdjsonParser();
  const events = parser.push("not json\n");
  assert.equal(events[0]?.type, "error");
});

test("isTerminalEvent recognizes done and error", () => {
  assert.equal(isTerminalEvent({ type: "done", message: "" }), true);
  assert.equal(isTerminalEvent({ type: "error", error: "x" }), true);
  assert.equal(isTerminalEvent({ type: "content", delta: "x" }), false);
});
