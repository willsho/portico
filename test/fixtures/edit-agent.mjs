#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("edit-agent 1.0.0\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

await writeFile(join(process.cwd(), "delegated.txt"), `created by edit-agent\n${prompt.slice(0, 80)}\n`);
process.stdout.write("edited delegated.txt\n");
process.exit(0);
