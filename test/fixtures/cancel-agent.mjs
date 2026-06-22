#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("cancel-agent 1.0.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

// Make real progress, then hang — simulates a delegate that produced a real change
// before the caller cancelled it mid-flight. Only the orchestrator's abort signal
// (SIGKILL) stops it; used to test that cancel salvages the worktree diff.
writeFileSync(process.cwd() + "/delegated.txt", "created by cancel-agent\n");
process.stdout.write("working...\n");
setInterval(() => {}, 1 << 30);
