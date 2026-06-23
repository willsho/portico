import { parseArgs } from "node:util";
import { listProfiles, loadProfile, type DelegateProfile } from "../profiles.ts";
import { resolveRepoArg } from "./http.ts";

export async function profilesCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
    },
  });

  const sub = positionals[0];
  if (values.help || !sub) {
    console.log(`Usage: portico profiles <list|show> [options]

Commands:
  list                     List delegate profiles from .portico/agents/ and ~/.portico/agents/
  show <name>              Show one resolved profile (merged project over user)

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON
  -h, --help               Show this help message`);
    return values.help ? 0 : 1;
  }

  const repo = resolveRepoArg(values.repo);

  if (sub === "list") {
    const profiles = listProfiles(repo);
    if (values.json) {
      console.log(JSON.stringify(profiles, null, 2));
      return 0;
    }
    if (profiles.length === 0) {
      console.log("No delegate profiles found. Create .portico/agents/<name>.md (run `portico init` for examples).");
      return 0;
    }
    for (const p of profiles) {
      const facets = [p.to && `to ${p.to}`, p.mode && `mode ${p.mode}`, p.permissionProfile && p.permissionProfile]
        .filter(Boolean)
        .join(", ");
      console.log(`${p.name}${facets ? `  (${facets})` : ""}  [${p.sources.join("+")}]`);
      if (p.description) console.log(`    ${p.description}`);
    }
    return 0;
  }

  if (sub === "show") {
    const name = positionals[1];
    if (!name) {
      console.error("Usage: portico profiles show <name>");
      return 1;
    }
    const profile = loadProfile(repo, name);
    if (!profile) {
      console.error(`[portico] profile "${name}" not found in .portico/agents/ or ~/.portico/agents/`);
      return 1;
    }
    if (values.json) {
      console.log(JSON.stringify(profile, null, 2));
      return 0;
    }
    printProfile(profile);
    return 0;
  }

  console.error(`Unknown profiles command: ${sub}`);
  return 1;
}

function printProfile(p: DelegateProfile): void {
  console.log(`profile: ${p.name}  [${p.sources.join("+")}]`);
  const field = (label: string, value: string | number | string[] | undefined) => {
    if (value === undefined) return;
    console.log(`  ${label}: ${Array.isArray(value) ? value.join(", ") : value}`);
  };
  field("description", p.description);
  field("to", p.to);
  field("mode", p.mode);
  field("model", p.model);
  field("effort", p.effort);
  field("permissionProfile", p.permissionProfile);
  field("allowed", p.allowed);
  field("forbidden", p.forbidden);
  field("testCommands", p.testCommands);
  field("idleTimeoutMs", p.idleTimeoutMs);
  if (p.body) {
    console.log("  body (task preamble):");
    for (const line of p.body.split("\n")) console.log(`    ${line}`);
  }
}
