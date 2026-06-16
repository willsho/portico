#!/usr/bin/env node
// Minimal Node CLI that calls a local Agent in-process via @portico/core.
//
//   node examples/node-cli ask --provider codex --file context.md -m "What is the key risk?"
//
// With no real Agent installed, point a provider at the fake agent:
//   PORTICO_CODEX_PATH=./test/fixtures/fake-agent.mjs node examples/node-cli ask --provider codex -m hi

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { discoverAgents, runAgent } from "@portico/core";
import type { ContextBundle } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";

async function main(): Promise<number> {
  installBuiltinAdapters();
  const [command, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const agents = await discoverAgents();
    for (const a of agents) {
      console.log(`${a.provider.padEnd(10)} ${a.available ? "available" : "not found"}  ${a.version ?? ""}`);
    }
    return 0;
  }

  if (command !== "ask") {
    console.log("Usage: node examples/node-cli ask --provider <id> [--file <path>] [-m <message>]");
    console.log("       node examples/node-cli list");
    return command ? 1 : 0;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      provider: { type: "string" },
      file: { type: "string" },
      message: { type: "string", short: "m" },
    },
  });

  const provider = values.provider ?? "codex";
  const message = values.message ?? "Summarize this and list the key risks.";

  let context: ContextBundle | undefined;
  if (values.file) {
    const content = await readFile(values.file, "utf8");
    context = { schemaVersion: "1.0", kind: "document", title: values.file, content };
  }

  let exitCode = 0;
  for await (const event of runAgent({
    provider,
    ...(context ? { context } : {}),
    messages: [{ role: "user", content: message }],
  })) {
    switch (event.type) {
      case "content":
        process.stdout.write(event.delta);
        break;
      case "reasoning":
        process.stderr.write(`\x1b[2m${event.delta}\x1b[0m`);
        break;
      case "error":
        console.error(`\n[error:${event.code ?? "?"}] ${event.error}`);
        exitCode = 1;
        break;
      case "done":
        process.stdout.write("\n");
        break;
      default:
        break;
    }
  }
  return exitCode;
}

main().then((code) => {
  if (code !== 0) process.exitCode = code;
});
