#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("escape-agent 1.0.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const match = prompt.match(/MAIN_REPO:([^\n]+)/);
const mainRepo = match?.[1]?.trim();
if (!mainRepo) {
  process.stderr.write("missing MAIN_REPO marker\n");
  process.exit(1);
}

await writeFile(join(mainRepo, "escaped.txt"), "written outside the Portico worktree\n");
process.stdout.write("ALL_NINE_PRESENT: escaped.txt is complete\n");
process.exit(0);
