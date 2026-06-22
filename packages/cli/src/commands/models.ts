// `portico models` — list known models per agent (or a single --to agent).

import { parseArgs } from "node:util";
import { discoverAgents, discoverModels, getProvider } from "@portico/core";
import type { AgentEntry, ModelDescriptor } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";

export async function modelsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      to: { type: "string" },
      json: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico models [options]

List known models per installed agent.

Options:
  --to <agent>             Show models for a single agent only
  --json                   Output JSON format
  -h, --help               Show this help message`);
    return 0;
  }

  installBuiltinAdapters();
  const agents = await discoverAgents();

  const targets = values.to
    ? agents.filter((a) => a.provider === values.to)
    : agents.filter((a) => a.available);

  if (values.to && targets.length === 0) {
    console.error(`[portico] agent "${values.to}" not found or not available.`);
    return 1;
  }

  interface AgentModelsRecord {
    provider: string;
    modelSelection: AgentEntry["modelSelection"];
    models: ModelDescriptor[];
  }

  const records: AgentModelsRecord[] = [];
  for (const entry of targets) {
    const provider = getProvider(entry.provider);
    if (!provider) continue;
    const models = await discoverModels(provider, entry);
    records.push({
      provider: entry.provider,
      modelSelection: entry.modelSelection,
      models,
    });
  }

  if (values.json) {
    console.log(JSON.stringify({ agents: records }, null, 2));
    return 0;
  }

  for (const rec of records) {
    console.log(`\n${rec.provider}:`);
    if (rec.modelSelection === "managed-by-runtime") {
      console.log("  model selection managed by runtime");
      continue;
    }
    if (rec.models.length === 0) {
      console.log("  no known models (any value passed through)");
      continue;
    }
    const rows = rec.models.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      def: m.default ? "*" : "",
      aliases: m.aliases?.join(", ") ?? "",
    }));
    const widths = {
      id: Math.max(5, ...rows.map((r) => r.id.length)),
      label: Math.max(5, ...rows.map((r) => r.label.length)),
      def: 3,
      aliases: Math.max(7, ...rows.map((r) => r.aliases.length)),
    };
    const header = `  ${"Model".padEnd(widths.id)}   ${"Label".padEnd(widths.label)}   ${"Def".padEnd(widths.def)}   Aliases`;
    console.log(header);
    for (const r of rows) {
      console.log(
        `  ${r.id.padEnd(widths.id)}   ${r.label.padEnd(widths.label)}   ${r.def.padEnd(widths.def)}   ${r.aliases}`,
      );
    }
  }

  return 0;
}
