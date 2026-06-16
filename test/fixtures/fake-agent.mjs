#!/usr/bin/env node
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

if (!args.includes("--hang")) {
  const prompt = await readStdin();

  if (args.includes("--flood")) {
    const block = "x".repeat(8192);
    for (let i = 0; i < 1000; i++) process.stdout.write(block);
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
