#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("edit-agent 1.0.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

// Optional concurrency instrumentation, used by the fan-out parallelism tests.
// When PORTICO_TRACE_FILE is set, append `start`/`end` markers around an optional
// delay so a test can reconstruct how many agents ran at once. Off by default, so
// every other test and example is unaffected.
const trace = process.env.PORTICO_TRACE_FILE;
const delayMs = Number(process.env.PORTICO_AGENT_DELAY_MS ?? "0") || 0;
if (trace) await appendFile(trace, `start:${process.pid}:${Date.now()}\n`);
if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

await writeFile(join(process.cwd(), "delegated.txt"), `created by edit-agent\n${prompt.slice(0, 80)}\n`);
if (trace) await appendFile(trace, `end:${process.pid}:${Date.now()}\n`);
process.stdout.write("edited delegated.txt\n");
process.exit(0);
