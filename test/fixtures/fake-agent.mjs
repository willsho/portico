#!/usr/bin/env node
import { once } from "node:events";

// A fake Agent CLI used by tests and examples. It mimics the generic-cli contract:
//   --version            print a semver and exit 0
//   --fail               write to stderr and exit 1
//   --hang               never exit (used to exercise the timeout watchdog)
//   --flood              emit a large amount of output (exercise the output cap)
//   (otherwise)          read the prompt from stdin, stream a reply on stdout, exit 0
//
// Streaming uses small async chunks so consumers observe multiple `content` deltas.

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("fake-agent 1.4.2\n");
  process.exit(0);
}

if (args.includes("--fail")) {
  process.stderr.write("fake-agent: simulated failure\n");
  process.exit(1);
}

if (args.includes("--hang")) {
  // Keep the event loop alive forever.
  setInterval(() => {}, 1 << 30);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // If nothing is piped, resolve quickly.
    process.stdin.on("error", () => resolve(data));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stream-json mode: emit a canned trace of Claude Code stream-json messages so the
// stream-json engine can be exercised end to end (the claude adapter passes
// `--output-format stream-json --include-partial-messages`, which land here). This
// mirrors the real partial-message shape: token-level `stream_event` deltas for text
// and thinking, plus the complete `assistant` messages that carry full tool_use input.
if (args.includes("stream-json")) {
  // When resumed, prefix the answer with a marker so tests can observe that the engine
  // forwarded `--resume <id>` to us.
  const resumeIdx = args.indexOf("--resume");
  const resumedId = resumeIdx !== -1 ? args[resumeIdx + 1] : null;
  const head = resumedId ? `(resumed ${resumedId}) ` : "";
  const lines = [
    { type: "system", subtype: "init", session_id: "fake-1", tools: ["Bash"], model: "fake" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    // Reasoning, streamed token by token.
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me echo " } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "that." } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me echo that.", signature: "sig" }] } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    // Tool call: input streams as partial_json, full input arrives in the assistant message.
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] } },
    // Final answer, streamed token by token.
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${head}The output ` } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "was hi." } } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `${head}The output was hi.` }] } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "result", subtype: "success", is_error: false, result: `${head}The output was hi.`, usage: { output_tokens: 7 } },
  ];
  for (let i = 0; i < lines.length; i++) {
    const text = JSON.stringify(lines[i]) + "\n";
    if (i === 3) {
      // Split one line across two writes to exercise the engine's cross-chunk buffering.
      const mid = Math.floor(text.length / 2);
      process.stdout.write(text.slice(0, mid));
      await sleep(5);
      process.stdout.write(text.slice(mid));
    } else {
      process.stdout.write(text);
    }
    await sleep(2);
  }
  process.exit(0);
}

if (!args.includes("--hang")) {
  const prompt = await readStdin();

  if (args.includes("--flood")) {
    const block = "x".repeat(8192);
    for (let i = 0; i < 1000; i++) {
      if (!process.stdout.write(block)) await once(process.stdout, "drain");
    }
    process.exit(0);
  }

  // Derive a short deterministic reply from the prompt's last "User:" line.
  const userLines = prompt
    .split("\n")
    .filter((l) => l.startsWith("User:"))
    .map((l) => l.slice("User:".length).trim());
  const question = userLines.at(-1) ?? "your prompt";

  const reply = `Echo from fake-agent. You asked: "${question}". Here is a streamed reply.`;
  const chunks = reply.match(/.{1,12}/gs) ?? [reply];
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    await sleep(5);
  }
  process.stdout.write("\n");
  process.exit(0);
}
