#!/usr/bin/env node
// A directive-driven fake agent for Phase 3 split / fan-in tests. The child's task
// embeds a `SPLIT_AGENT:{...}` JSON directive describing the files to create or edit,
// so each split child can touch a controlled set of paths/regions:
//
//   { "writes":   [{ "path": "a.txt", "content": "A\n" }],
//     "replaces": [{ "path": "shared.txt", "find": "L1", "replace": "L1-A" }] }
//
// Mutually-exclusive writes stack cleanly on merge; replaces of the same region in two
// children produce a fan-in conflict, replaces of different regions merge three-way.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("split-agent 1.0.0\n");
  process.exit(0);
}

if (args.includes("stream-json")) {
  process.stdout.write('{"type":"system","session_id":"split-fake-sess"}\n');
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

/** Extract the balanced {...} object following the LAST marker (so a resume overrides). */
function extractJson(text, marker) {
  const at = text.lastIndexOf(marker);
  if (at === -1) return undefined;
  const start = text.indexOf("{", at);
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

const raw = extractJson(prompt, "SPLIT_AGENT:");
const directive = raw ? JSON.parse(raw) : {};
const cwd = process.cwd();

for (const write of directive.writes ?? []) {
  await writeFile(join(cwd, write.path), write.content ?? "");
}
for (const replace of directive.replaces ?? []) {
  const target = join(cwd, replace.path);
  let body = "";
  try {
    body = await readFile(target, "utf8");
  } catch {
    // Replacing in a missing file just writes the replacement value.
  }
  await writeFile(target, body.split(replace.find).join(replace.replace));
}

process.stdout.write("split-agent done\n");
process.exit(0);
