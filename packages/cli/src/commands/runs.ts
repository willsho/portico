import { parseArgs } from "node:util";
import { authHeaders, daemonUrl, readJson } from "./http.ts";
import type { Run, RunDetails, RunResult } from "@portico/orchestrator";

export async function runsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      flat: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });
  const repo = encodeURIComponent(values.repo ?? process.cwd());
  const flatParam = values.flat ? "&flat=true" : "";
  const body = await readJson<{ runs: Run[] }>(
    await fetch(`${daemonUrl(values.url)}/runs?repo=${repo}${flatParam}`, { headers: authHeaders(values.token) }),
  );
  if (values.json) console.log(JSON.stringify(body, null, 2));
  else printRuns(body.runs);
  return 0;
}

export async function statusCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      summary: { type: "boolean" },
      fields: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });
  const id = positionals[0];
  if (!id) {
    console.error("Usage: portico status <run_id> [--repo .]");
    return 1;
  }
  const body = await getRun(values.url, values.token, values.repo, id);
  if (values.json) {
    const printable = values.summary || values.fields ? summarizeDetails(body) : compactDetails(body);
    console.log(JSON.stringify(values.fields ? selectFields(printable, values.fields) : printable, null, 2));
  } else printDetails(body);
  return 0;
}

export async function applyCommand(args: string[]): Promise<number> {
  return actionCommand("apply", args);
}

export async function cancelCommand(args: string[]): Promise<number> {
  return actionCommand("cancel", args);
}

export async function discardCommand(args: string[]): Promise<number> {
  return actionCommand("discard", args);
}

async function actionCommand(action: "apply" | "cancel" | "discard", args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
      child: { type: "string" },
      all: { type: "boolean" },
    },
  });
  const id = positionals[0];
  if (!id) {
    console.error(`Usage: portico ${action} <run_id> [--repo .]${action === "apply" ? " [--child <child_id> | --all]" : ""}`);
    return 1;
  }
  const repo = encodeURIComponent(values.repo ?? process.cwd());
  const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}/${action}?repo=${repo}`;
  const bodyPayload: Record<string, unknown> = {};
  if (action === "apply" && values.child) {
    bodyPayload.child = values.child;
  }
  if (action === "apply" && values.all) {
    bodyPayload.all = true;
  }
  const fetchOpts: RequestInit = {
    method: "POST",
    headers: authHeaders(values.token),
  };
  if (Object.keys(bodyPayload).length > 0) {
    fetchOpts.headers = { ...authHeaders(values.token), "Content-Type": "application/json" };
    fetchOpts.body = JSON.stringify(bodyPayload);
  }
  const body = await readJson<RunDetails>(await fetch(url, fetchOpts));
  if (values.json) console.log(JSON.stringify(body, null, 2));
  else console.log(`${action} ${body.run.id}: ${body.run.status}`);
  return 0;
}

async function getRun(
  url: string | undefined,
  token: string | undefined,
  repo: string | undefined,
  id: string,
): Promise<RunDetails> {
  return readJson<RunDetails>(
    await fetch(`${daemonUrl(url)}/runs/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo ?? process.cwd())}`, {
      headers: authHeaders(token),
    }),
  );
}

function printRuns(runs: Run[]): void {
  if (runs.length === 0) {
    console.log("No runs.");
    return;
  }
  for (const run of runs) {
    const children = (run as unknown as Record<string, unknown>)["_children"] as Run[] | undefined;
    const role = (run as Run & { role?: string }).role ?? "single";
    const status = run.status;
    const mode = (run as Run & { mode?: string }).mode ?? "implement";

    if (role === "group" && children) {
      const ready = children.filter((c) => c.status === "ready").length;
      const failed = children.filter((c) => c.status === "failed" || c.status === "cancelled").length;
      console.log(`${run.id}\t${mode}\t${status}\t(${children.length} children: ${ready} ready, ${failed} failed)`);
      for (const child of children) {
        const prefix = child === children[children.length - 1] ? "  └─" : "  ├─";
        console.log(`${prefix} ${child.id}\t${child.targetAgent}\t${child.status}\t${child.label ?? ""}`);
      }
    } else {
      console.log(`${run.id}\t${status}\t${run.targetAgent}\t${run.createdAt}\t${run.task}`);
    }
  }
}

function printDetails(details: RunDetails): void {
  const { run, artifacts, result } = details;
  console.log(`${run.id}: ${run.status}`);
  console.log(`target: ${run.targetAgent}`);
  console.log(`branch: ${run.branchName}`);
  console.log(`worktree: ${run.worktreePath}`);
  console.log(`report: ${artifacts.reportPath}`);
  if (result?.changedFiles?.length) console.log(`changed: ${result.changedFiles.join(", ")}`);
  if (result?.sandboxEscaped) {
    console.error("WARNING: sandbox escape detected");
    for (const change of result.outOfTreeChanges ?? []) console.error(`  ${change.status} ${change.path}`);
  }
  if (result?.gateWarnings?.length) {
    for (const warning of result.gateWarnings) console.error(`warning: ${warning}`);
  }
  if (result?.telemetry) {
    const usage = result.telemetry.usage;
    console.log(`duration: ${result.telemetry.totalDurationMs}ms total`);
    if (result.telemetry.agentDurationMs !== undefined) console.log(`agent: ${result.telemetry.agentDurationMs}ms`);
    console.log(`tests: ${result.telemetry.testDurationMs}ms`);
    if (usage.available) {
      const tokens = [
        usage.inputTokens !== undefined ? `input=${usage.inputTokens}` : undefined,
        usage.outputTokens !== undefined ? `output=${usage.outputTokens}` : undefined,
        usage.totalTokens !== undefined ? `total=${usage.totalTokens}` : undefined,
      ].filter(Boolean);
      console.log(`usage: ${tokens.length ? tokens.join(" ") : "reported"}`);
      console.log(`cost: ${usage.costUsd !== undefined ? `$${usage.costUsd}` : "not reported"}`);
    } else {
      console.log(`usage: unavailable (${usage.unavailableReason ?? "not reported"})`);
    }
  }
  if (result?.tests?.length) {
    for (const test of result.tests) console.log(`test ${test.status}: ${test.command}`);
  }
}

type CompactRunResult = Omit<RunResult, "run" | "artifacts">;

function compactDetails(details: RunDetails): Omit<RunDetails, "result"> & { result?: CompactRunResult } {
  const result = details.result ? compactResult(details.result) : undefined;
  return {
    run: details.run,
    artifacts: details.artifacts,
    ...(result ? { result } : {}),
  };
}

function compactResult(result: RunResult): CompactRunResult {
  const { run: _run, artifacts: _artifacts, ...rest } = result;
  return rest;
}

function summarizeDetails(details: RunDetails): Record<string, unknown> {
  return {
    id: details.run.id,
    status: details.run.status,
    targetAgent: details.run.targetAgent,
    mode: details.run.mode,
    changedFiles: details.result?.changedFiles ?? [],
    tests: details.result?.tests ?? [],
    sandboxEscaped: details.result?.sandboxEscaped ?? false,
    outOfTreeChanges: details.result?.outOfTreeChanges ?? [],
    agentGateMismatch: details.result?.agentGateMismatch ?? false,
    gateWarnings: details.result?.gateWarnings ?? [],
    telemetry: details.result?.telemetry,
    reportPath: details.artifacts.reportPath,
    resultPath: details.artifacts.resultPath,
  };
}

function selectFields(value: Record<string, unknown>, fields: string): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields.split(",").map((part) => part.trim()).filter(Boolean)) {
    selected[field] = value[field];
  }
  return selected;
}
