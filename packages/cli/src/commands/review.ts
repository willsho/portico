// `portico review <run_id>` — read-only aggregation of a group's children (or a single
// run) so a reviewer can see every child's status, changed files, checks, report/diff
// paths, and cross-child file overlap in one place instead of opening each run by hand.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { daemonUrl, DaemonUnreachableError, requestJson, resolveRepoArg } from "./http.ts";
import type { RunDetails, RunResult } from "@portico/orchestrator";

interface ChildReview {
  id: string;
  label?: string;
  agent: string;
  status: string;
  changedFiles: string[];
  tests: { passed: number; failed: number };
  verify: { passed: number; failed: number };
  policy?: string;
  /** Whether this child's own patch applies to the group base (read-only fan-in check). */
  applyCheck?: { applies: boolean; reason?: string };
  reportPath: string;
  diffPath?: string;
}

export async function reviewCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      "ready-only": { type: "boolean" },
      "open-diff": { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico review <run_id> [options]

Aggregate a group run's children (or a single run) for review.

Options:
  --repo <path>            Repository path (default: cwd)
  --ready-only             Only show children that are ready to apply
  --open-diff              Print each shown child's full diff inline
  --json                   Output JSON aggregation
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const id = positionals[0];
  if (!id) {
    console.error("Usage: portico review <run_id> [--repo .] [--ready-only] [--json] [--open-diff]");
    return 1;
  }

  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}?repo=${repo}`;
  let details: RunDetails;
  try {
    details = await requestJson<RunDetails>(url, {}, values.token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }

  const result = details.result;
  // A group exposes childResults; a single run reviews as one entry.
  const childResults: RunResult[] = result?.childResults ?? result?.compareResults ?? (result ? [result] : []);
  let children = childResults.map(toChildReview);
  if (values["ready-only"]) children = children.filter((c) => c.status === "ready");

  const overlap = computeOverlap(children);
  const aggregation = {
    id: details.run.id,
    status: details.run.status,
    role: details.run.role ?? "single",
    mode: details.run.mode,
    task: details.run.task,
    children,
    overlap,
  };

  if (values.json) {
    console.log(JSON.stringify(aggregation, null, 2));
    return 0;
  }

  printReview(aggregation);
  if (values["open-diff"]) await printDiffs(children);
  return 0;
}

function toChildReview(r: RunResult): ChildReview {
  return {
    id: r.run.id,
    label: r.run.label,
    agent: r.run.targetAgent,
    status: r.run.status,
    changedFiles: r.changedFiles ?? [],
    tests: countChecks(r.tests),
    verify: countChecks(r.verify ?? []),
    policy: r.pathPolicy?.status,
    ...(r.applyCheck ? { applyCheck: { applies: r.applyCheck.applies, ...(r.applyCheck.reason ? { reason: r.applyCheck.reason } : {}) } } : {}),
    reportPath: r.artifacts.reportPath,
    diffPath: r.artifacts.diffPath,
  };
}

function countChecks(checks: { status: "passed" | "failed" }[]): { passed: number; failed: number } {
  return {
    passed: checks.filter((c) => c.status === "passed").length,
    failed: checks.filter((c) => c.status === "failed").length,
  };
}

/** Files changed by more than one child — the manual-merge hot spots (feedback: overlap). */
function computeOverlap(children: ChildReview[]): Array<{ file: string; children: string[] }> {
  const byFile = new Map<string, string[]>();
  for (const child of children) {
    for (const file of child.changedFiles) {
      const owners = byFile.get(file) ?? [];
      owners.push(child.label ?? child.id);
      byFile.set(file, owners);
    }
  }
  return [...byFile.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([file, owners]) => ({ file, children: owners }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function printReview(agg: {
  id: string;
  status: string;
  role: string;
  children: ChildReview[];
  task: string;
  overlap: Array<{ file: string; children: string[] }>;
}): void {
  const ready = agg.children.filter((c) => c.status === "ready").length;
  const failed = agg.children.filter((c) => c.status === "failed" || c.status === "cancelled").length;
  console.log(`Group ${agg.id} — ${agg.status} (${agg.children.length} shown: ${ready} ready, ${failed} failed)`);
  console.log(`Task: ${firstLine(agg.task)}\n`);

  for (const c of agg.children) {
    const label = c.label ? ` [${c.label}]` : "";
    console.log(`${c.id}${label}  ${c.status}  agent=${c.agent}`);
    console.log(`  changed: ${c.changedFiles.length} file(s)${c.changedFiles.length ? `: ${c.changedFiles.join(", ")}` : ""}`);
    const checks = [
      `tests ${c.tests.passed}✓/${c.tests.failed}✗`,
      `verify ${c.verify.passed}✓/${c.verify.failed}✗`,
      `policy ${c.policy ?? "n/a"}`,
      `apply ${c.applyCheck ? (c.applyCheck.applies ? "ok" : "FAILS") : "n/a"}`,
    ];
    console.log(`  checks: ${checks.join("   ")}`);
    // A child whose own patch won't apply to the base is the case `overlap: []` can't explain.
    if (c.applyCheck && !c.applyCheck.applies) {
      console.log(`  apply-check: does not apply to group base${c.applyCheck.reason ? ` — ${c.applyCheck.reason}` : ""}`);
    }
    console.log(`  report: ${c.reportPath}`);
    if (c.diffPath) console.log(`  diff:   ${c.diffPath}`);
    if (c.status === "ready") console.log(`  → portico apply ${agg.id} --child ${c.id}`);
    else if (c.status === "failed" || c.status === "cancelled") console.log(`  → portico delegate --resume ${c.id} --task "..."`);
    console.log("");
  }

  if (agg.overlap.length) {
    console.log("Overlapping files (changed by >1 child — review/merge carefully):");
    for (const o of agg.overlap) console.log(`  - ${o.file}: ${o.children.join(", ")}`);
  } else if (agg.children.length > 1) {
    console.log("No overlapping files across children.");
  }
}

async function printDiffs(children: ChildReview[]): Promise<void> {
  for (const c of children) {
    if (!c.diffPath) continue;
    console.log(`\n===== diff: ${c.id}${c.label ? ` [${c.label}]` : ""} =====`);
    try {
      console.log(await readFile(c.diffPath, "utf8"));
    } catch {
      console.log("(diff unavailable)");
    }
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text.trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
