import { test } from "node:test";
import assert from "node:assert/strict";
import { translateStreamJsonLine } from "../src/stream-json.ts";

// Lines below mirror the real shapes emitted by `claude -p --output-format stream-json`.

test("thinking blocks become reasoning events", () => {
  const toolNames = new Map<string, string>();
  const out = translateStreamJsonLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }),
    toolNames,
  );
  assert.deepEqual(out, [{ type: "reasoning", delta: "hmm" }]);
});

test("tool_use becomes tool_call and records the tool name by id", () => {
  const toolNames = new Map<string, string>();
  const out = translateStreamJsonLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo" } }] },
    }),
    toolNames,
  );
  assert.deepEqual(out, [{ type: "tool_call", name: "Bash", input: { command: "echo" } }]);
  assert.equal(toolNames.get("toolu_1"), "Bash");
});

test("tool_result is labelled with the tool name resolved from its tool_use_id", () => {
  const toolNames = new Map([["toolu_1", "Bash"]]);
  const out = translateStreamJsonLine(
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] },
    }),
    toolNames,
  );
  assert.deepEqual(out, [{ type: "tool_result", name: "Bash", output: "hi" }]);
});

test("tool_result falls back to its id when the tool name is unknown", () => {
  const out = translateStreamJsonLine(
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "x" }] } }),
    new Map<string, string>(),
  );
  assert.deepEqual(out, [{ type: "tool_result", name: "toolu_x", output: "x" }]);
});

test("text blocks become content; success result becomes done with usage", () => {
  const m = new Map<string, string>();
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      m,
    ),
    [{ type: "content", delta: "hi" }],
  );
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "result", subtype: "success", result: "hi", usage: { output_tokens: 1 } }),
      m,
    ),
    [{ type: "done", message: "hi", usage: { output_tokens: 1 } }],
  );
});

test("error result becomes an error event", () => {
  const out = translateStreamJsonLine(
    JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "too many turns" }),
    new Map<string, string>(),
  );
  assert.equal(out[0]?.type, "error");
  assert.equal(out[0]?.type === "error" ? out[0].error : "", "too many turns");
});

test("system and rate_limit_event lines carry nothing", () => {
  const m = new Map<string, string>();
  assert.deepEqual(translateStreamJsonLine(JSON.stringify({ type: "system", subtype: "init", tools: [] }), m), []);
  assert.deepEqual(translateStreamJsonLine(JSON.stringify({ type: "rate_limit_event" }), m), []);
});

test("a non-JSON line degrades to a content event", () => {
  assert.deepEqual(translateStreamJsonLine("oops not json", new Map<string, string>()), [
    { type: "content", delta: "oops not json" },
  ]);
});

// --- partial-message mode (--include-partial-messages) ---

test("partial mode: stream_event deltas stream text and reasoning", () => {
  const m = new Map<string, string>();
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } }),
      m,
      true,
    ),
    [{ type: "content", delta: "hi" }],
  );
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } }),
      m,
      true,
    ),
    [{ type: "reasoning", delta: "hmm" }],
  );
});

test("partial mode: signature_delta and input_json_delta carry nothing", () => {
  const m = new Map<string, string>();
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "signature_delta", signature: "x" } } }),
      m,
      true,
    ),
    [],
  );
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }),
      m,
      true,
    ),
    [],
  );
});

test("partial mode: complete assistant message yields tool_use but not duplicate text", () => {
  const m = new Map<string, string>();
  // text was already streamed via stream_event deltas — the complete message is a dup.
  assert.deepEqual(
    translateStreamJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "dup" }] } }), m, true),
    [],
  );
  // tool_use still surfaces (its full input isn't available in the partial fragments).
  assert.deepEqual(
    translateStreamJsonLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }] } }),
      m,
      true,
    ),
    [{ type: "tool_call", name: "Bash", input: { command: "x" } }],
  );
});
