// `portico agents` — discover installed Agents and print a table (or JSON).

import { parseArgs } from "node:util";
import { discoverAgents } from "@portico/core";
import type { AgentEntry } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";

export async function agentsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico agents [options]

Locally-installed agents (does not require or check a running daemon).

Options:
  --url <url>              Daemon URL (accepted for consistency, not used)
  --token <token>          Auth token (accepted for consistency, not used)
  --json                   Output JSON format
  -h, --help               Show this help message`);
    return 0;
  }

  installBuiltinAdapters();
  const agents = await discoverAgents();

  if (values.json) {
    console.log(JSON.stringify({ agents }, null, 2));
    return 0;
  }

  console.log("Locally-installed agents (does not require or check a running daemon).\n");
  printTable(agents);
  return 0;
}

function printTable(agents: AgentEntry[]): void {
  const rows = agents.map((a) => ({
    provider: a.provider,
    available: a.available ? "yes" : "no",
    version: a.version ?? "-",
    path: a.path ?? "not found",
  }));

  const headers = { provider: "Provider", available: "Available", version: "Version", path: "Path" };
  const widthOf = (key: keyof typeof headers) =>
    Math.max(headers[key].length, ...rows.map((r) => r[key].length));
  const widths = {
    provider: widthOf("provider"),
    available: widthOf("available"),
    version: widthOf("version"),
    path: widthOf("path"),
  };

  const line = (r: Record<keyof typeof headers, string>) =>
    `${r.provider.padEnd(widths.provider)}   ${r.available.padEnd(widths.available)}   ${r.version.padEnd(
      widths.version,
    )}   ${r.path}`;

  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}
