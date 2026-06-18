import { parseArgs } from "node:util";
import { authHeaders, daemonUrl, readJson } from "./http.ts";
import type { Run, RunDetails } from "@portico/orchestrator";

export async function runsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });
  const repo = encodeURIComponent(values.repo ?? process.cwd());
  const body = await readJson<{ runs: Run[] }>(
    await fetch(`${daemonUrl(values.url)}/runs?repo=${repo}`, { headers: authHeaders(values.token) }),
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
  if (values.json) console.log(JSON.stringify(body, null, 2));
  else printDetails(body);
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
    },
  });
  const id = positionals[0];
  if (!id) {
    console.error(`Usage: portico ${action} <run_id> [--repo .]`);
    return 1;
  }
  const repo = encodeURIComponent(values.repo ?? process.cwd());
  const body = await readJson<RunDetails>(
    await fetch(`${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}/${action}?repo=${repo}`, {
      method: "POST",
      headers: authHeaders(values.token),
    }),
  );
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
    console.log(`${run.id}\t${run.status}\t${run.targetAgent}\t${run.createdAt}\t${run.task}`);
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
  if (result?.tests?.length) {
    for (const test of result.tests) console.log(`test ${test.status}: ${test.command}`);
  }
}
