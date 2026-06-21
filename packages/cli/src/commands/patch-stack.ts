import { parseArgs } from "node:util";
import { daemonUrl, DaemonUnreachableError, requestJson, resolveRepoArg } from "./http.ts";
import { computeOverlap } from "./review.ts";
import type { RunDetails } from "@portico/orchestrator";

export async function patchStackCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico patch-stack <id> <id> [id...] [options]

Read-only file-overlap & apply-order summary across runs.

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  if (positionals.length < 2) {
    console.error("Usage: portico patch-stack <run_id> <run_id> [run_id...] [--repo .]");
    return 1;
  }

  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const base = daemonUrl(values.url);
  const runs: { id: string; status: string; changedFiles: string[] }[] = [];

  for (const id of positionals) {
    try {
      const url = `${base}/runs/${encodeURIComponent(id)}?repo=${repo}`;
      const details = await requestJson<RunDetails>(url, {}, values.token);
      runs.push({
        id: details.run.id,
        status: details.run.status,
        changedFiles: details.result?.changedFiles ?? [],
      });
    } catch (err) {
      if (err instanceof DaemonUnreachableError) return 1;
      throw err;
    }
  }

  const overlap = computeOverlap(runs);
  const order = computeApplyOrder(runs);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          runs,
          overlap: overlap.map((o) => ({ file: o.file, runs: o.children })),
          order,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`Patch stack — ${runs.length} runs\n`);
  for (const r of runs) {
    console.log(`${r.id}  ${r.status}  (${r.changedFiles.length} file(s))`);
    if (r.changedFiles.length > 0) {
      for (const f of r.changedFiles) {
        console.log(`  ${f}`);
      }
    }
  }

  console.log("");
  if (overlap.length > 0) {
    console.log("Overlapping files (changed by >1 run — review/merge carefully):");
    for (const o of overlap) {
      console.log(`  - ${o.file}: ${o.children.join(", ")}`);
    }
  } else {
    console.log("No overlapping files across runs.");
  }

  console.log(`\nSuggested apply/review order: ${order.join(", ")}`);

  if (overlap.length > 0) {
    console.log("Caution: overlapping files need careful manual merge / review. patch-stack does not apply anything.");
  }

  return 0;
}

export function computeApplyOrder(runs: { id: string; changedFiles: string[] }[]): string[] {
  return [...runs]
    .sort((a, b) => {
      const diff = b.changedFiles.length - a.changedFiles.length;
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    })
    .map((r) => r.id);
}
