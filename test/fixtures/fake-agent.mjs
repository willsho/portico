#!/usr/bin/env node
import { once } from "node:events";
import { writeFileSync } from "node:fs";

// A fake Agent CLI used by tests and examples. It mimics the generic-cli contract:
//   --version            print a semver and exit 0
//   --help               print a help blurb listing supported flags and exit 0
//   --touch-cwd <name>   write <name> into the process cwd, print a semver, exit 0
//   --echo-argv          print the received argv as JSON and exit 0
//   --echo-argv-json     emit the argv as a Codex-style NDJSON content+done trace
//   --echo-argv-stdin    print argv and stdin as JSON and exit 0
//   --cli-error-ok       write a TTY-flavored CLI error to stderr and exit 0
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

// Help text for capability probes: lists a couple of flags so a probe can detect
// which ones this build supports by scanning the output.
if (args.includes("--help")) {
  process.stdout.write(
    [
      "Usage: fake-agent [options]",
      "  --include-partial-messages   stream token-level deltas",
      "  --output-format <fmt>        set the output format",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

// Write a marker file into the current working directory so a test can assert which
// cwd a read-only probe ran in (probes should default to a temp dir, not the repo).
const touchIdx = args.indexOf("--touch-cwd");
if (touchIdx !== -1) {
  const name = args[touchIdx + 1] ?? "cwd-marker";
  writeFileSync(name, "x");
  process.stdout.write("fake-agent 1.4.2\n");
  process.exit(0);
}

// Echo the received argv as a JSON array so tests can assert how the engine assembled
// the command line (e.g. that autoEdit appended the provider's autoEditArgs).
if (args.includes("--echo-argv")) {
  process.stdout.write(JSON.stringify(args) + "\n");
  process.exit(0);
}

// Same idea, but framed as a real `codex exec --json` trace (agent_message + turn.completed)
// so the codex JSON adapter surfaces the argv through a `content` event (used to assert
// autoEdit arg assembly).
if (args.includes("--echo-argv-json")) {
  process.stdout.write(
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(args) } }) + "\n",
  );
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
  process.exit(0);
}

if (args.includes("--cli-error-ok")) {
  process.stderr.write("CLI error: bubbletea: error opening TTY: bubbletea: could not open TTY\n");
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

if (args.includes("--stderr-heartbeat")) {
  let count = 0;
  const timer = setInterval(() => {
    process.stderr.write(`heartbeat ${count++}\n`);
    if (count >= 15) { // 15 * 200ms = 3s
      clearInterval(timer);
      process.exit(0);
    }
  }, 200);
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
  // Prefix the answer with a marker so tests can observe which flags the engine forwarded
  // (--resume / --model / --effort). The `(resumed <id>)` form is kept verbatim when only
  // resume is set, so existing resume tests stay valid.
  const flagValue = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };
  const markers = [];
  const resumedId = flagValue("--resume");
  if (resumedId) markers.push(`resumed ${resumedId}`);
  const model = flagValue("--model");
  if (model) markers.push(`model ${model}`);
  const effort = flagValue("--effort");
  if (effort) markers.push(`effort ${effort}`);
  const head = markers.length ? `(${markers.join(", ")}) ` : "";
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

if (!args.includes("--hang") && !args.includes("--stderr-heartbeat")) {
  const prompt = await readStdin();

  if (args.includes("--echo-argv-stdin")) {
    process.stdout.write(JSON.stringify({ args, stdin: prompt }) + "\n");
    process.exit(0);
  }

  if (process.env.FAKE_AGENT_ECHO_AGY === "1" && args.includes("-p") && args.includes("-")) {
    process.stdout.write(JSON.stringify({ args, stdin: prompt }) + "\n");
    process.exit(0);
  }

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
