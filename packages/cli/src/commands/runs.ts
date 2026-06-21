import { parseArgs } from "node:util";
import {
  authHeaders,
  daemonUrl,
  DaemonUnreachableError,
  fetchWithRetry,
  printDaemonError,
  readDelegationStream,
  requestJson,
  resolveRepoArg,
} from "./http.ts";
import { parseDuration } from "../duration.ts";
import { printEvent } from "./delegate.ts";
import { watchCommand } from "./watch.ts";
import type { CleanupResult, IntegrateResult, Run, RunDetails, RunResult } from "@portico/orchestrator";

export async function runsCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      flat: { type: "boolean" },
      status: { type: "string" },
      since: { type: "string" },
      watch: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico runs [options]

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --flat                   Flatten the list of runs
  --status <s1,s2>         Only runs with these statuses (comma-separated)
  --since <dur>            Only runs created within this window (e.g. 30m, 2h, 1d)
  --watch                  Open the live status board (same as: portico watch)
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  // `runs --watch` is the equivalent live board, sharing the same filters.
  if (values.watch) {
    const watchArgs: string[] = [];
    if (values.repo) watchArgs.push("--repo", values.repo);
    if (values.status) watchArgs.push("--status", values.status);
    if (values.since) watchArgs.push("--since", values.since);
    if (values.json) watchArgs.push("--json");
    if (values.url) watchArgs.push("--url", values.url);
    if (values.token) watchArgs.push("--token", values.token);
    return watchCommand(watchArgs);
  }

  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const params = [`repo=${repo}`];
  if (values.flat) params.push("flat=true");
  if (values.status) params.push(`status=${encodeURIComponent(values.status)}`);
  if (values.since !== undefined) {
    const sinceMs = parseDuration(values.since);
    if (sinceMs === undefined) {
      console.error(`[portico] invalid --since duration: ${values.since} (try 30m, 2h, 1d)`);
      return 1;
    }
    params.push(`since=${sinceMs}`);
  }
  const url = `${daemonUrl(values.url)}/runs?${params.join("&")}`;
  let body: { runs: Run[] };
  try {
    body = await requestJson<{ runs: Run[] }>(url, {}, values.token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }
  if (values.json) console.log(JSON.stringify(body, null, 2));
  else printRuns(body.runs);
  return 0;
}

export async function logsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      follow: { type: "boolean" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico logs <run_id> [options]

Options:
  --repo <path>            Repository path (default: cwd)
  --follow                 Poll and print new events until the run finishes
  --json                   Output raw NDJSON events
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const id = positionals[0];
  if (!id) {
    console.error("Usage: portico logs <run_id> [--repo .] [--follow] [--json]");
    return 1;
  }

  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}/events?repo=${repo}`;
  let offset = 0;
  let done = false;
  let code = 0;

  while (!done) {
    let res: Response;
    try {
      res = await fetchWithRetry(url, { headers: authHeaders(values.token) });
    } catch (err) {
      printDaemonError(err, url);
      return 1;
    }

    try {
      let index = 0;
      for await (const event of readDelegationStream(res)) {
        if (index >= offset) {
          if (values.json) console.log(JSON.stringify(event));
          else printEvent(event);
          offset++;
          if (event.type === "run_done" || event.type === "run_error") {
            done = true;
            if (event.type === "run_error") code = 1;
          }
        }
        index++;
      }
    } catch (err) {
      console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    if (done || !values.follow) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return code;
}

export async function statusCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      summary: { type: "boolean" },
      fields: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico status <run_id> [options]

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --summary                Output summary format
  --fields <fields>        Comma-separated fields to select
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const id = positionals[0];
  if (!id) {
    console.error("Usage: portico status <run_id> [--repo .]");
    return 1;
  }
  let body: RunDetails;
  try {
    body = await getRun(values.url, values.token, values.repo, id);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }
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
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
      child: { type: "string" },
      all: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico ${action} <run_id> [options]

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --url <url>              Daemon URL
  --token <token>          Auth token
  --child <child_id>       Specific child run ID (for apply)
  --all                    Apply the merged group patch (for apply)
  -h, --help               Show this help message`);
    return 0;
  }

  const id = positionals[0];
  if (!id) {
    console.error(`Usage: portico ${action} <run_id> [--repo .]${action === "apply" ? " [--child <child_id> | --all]" : ""}`);
    return 1;
  }
  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}/${action}?repo=${repo}`;
  const bodyPayload: Record<string, unknown> = {};
  if (action === "apply" && values.child) {
    bodyPayload.child = values.child;
  }
  if (action === "apply" && values.all) {
    bodyPayload.all = true;
  }
  const fetchOpts: RequestInit = { method: "POST" };
  if (Object.keys(bodyPayload).length > 0) {
    fetchOpts.headers = { "Content-Type": "application/json" };
    fetchOpts.body = JSON.stringify(bodyPayload);
  }
  let body: RunDetails;
  try {
    body = await requestJson<RunDetails>(url, fetchOpts, values.token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }
  if (values.json) console.log(JSON.stringify(body, null, 2));
  else {
    console.log(`${action} ${body.run.id}: ${body.run.status}`);
    if (action === "apply" && (values.all || values.child)) {
      console.log(`Tip: review the applied patch, commit it, then run/apply any small follow-up fixes as separate patches rather than folding them in — keeping a reviewable, layered history.`);
    }
  }
  return 0;
}

export async function integrateCommand(args: string[]): Promise<number> {
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
    console.log(`Usage: portico integrate <group_id> [options]

Merge a group's ready children into an integration worktree (implement/split groups only).

Options:
  --repo <path>            Repository path (default: cwd)
  --json                   Output JSON format
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const id = positionals[0];
  if (!id) {
    console.error("Usage: portico integrate <group_id> [--repo .]");
    return 1;
  }
  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(id)}/integrate?repo=${repo}`;
  let body: IntegrateResult;
  try {
    body = await requestJson<IntegrateResult>(url, { method: "POST" }, values.token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }
  if (values.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  printIntegrate(id, body);
  return body.status === "conflict" ? 1 : 0;
}

function printIntegrate(groupId: string, result: IntegrateResult): void {
  const order = result.order.map((c) => (c.label ? `${c.id} [${c.label}]` : c.id));
  if (result.status === "conflict") {
    console.log(`integrate ${groupId}: conflict`);
    console.log("\nConflicts (merge stopped at the first conflicting child):");
    for (const c of result.conflicts ?? []) console.log(`  - ${c.file} (from ${c.child})`);
    console.log("\nSuggested review order (apply order; resolve the last one against the earlier ones):");
    order.forEach((entry, index) => console.log(`  ${index + 1}. ${entry}`));
    console.log(`\nnext: narrow a child, then re-integrate:`);
    console.log(`  portico delegate --resume <child_id> --task "..."`);
    console.log(`  portico integrate ${groupId}`);
    return;
  }
  console.log(`integrate ${groupId}: ready (${result.order.length} child(ren) merged)`);
  console.log(`merged order: ${order.join(" → ")}`);
  if (result.mergedDiffPath) console.log(`merged diff: ${result.mergedDiffPath}`);
  console.log(`\nnext: portico apply ${groupId} --all | portico discard ${groupId}`);
}

export async function cleanupCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      failed: { type: "boolean" },
      status: { type: "string" },
      "older-than": { type: "string" },
      purge: { type: "boolean" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico cleanup [options]

Reclaim finished runs. By default removes only the worktree and keeps artifacts
(report/diff/events); ready/applied and in-flight runs are never touched.

Options:
  --repo <path>            Repository path (default: cwd)
  --failed                 Target failed + cancelled runs (the default)
  --status <s1,s2>         Explicit statuses to reclaim (overrides --failed)
  --older-than <dur>       Only runs finished more than this ago (e.g. 1h, 7d)
  --purge                  Also delete artifacts, not just the worktree
  --json                   Output JSON format
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const payload: { failed?: boolean; status?: string[]; olderThanMs?: number; purge?: boolean } = {};
  if (values.failed) payload.failed = true;
  if (values.status) payload.status = values.status.split(",").map((s) => s.trim()).filter(Boolean);
  if (values.purge) payload.purge = true;
  if (values["older-than"] !== undefined) {
    const ms = parseDuration(values["older-than"]);
    if (ms === undefined) {
      console.error(`[portico] invalid --older-than duration: ${values["older-than"]} (try 1h, 7d)`);
      return 1;
    }
    payload.olderThanMs = ms;
  }

  const repo = encodeURIComponent(resolveRepoArg(values.repo));
  const url = `${daemonUrl(values.url)}/cleanup?repo=${repo}`;
  let body: CleanupResult;
  try {
    body = await requestJson<CleanupResult>(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      values.token,
    );
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return 1;
    throw err;
  }
  if (values.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }
  if (body.cleaned.length === 0) {
    console.log(`No runs reclaimed (${body.skipped} examined).`);
    return 0;
  }
  for (const c of body.cleaned) {
    console.log(`${c.id}\t${c.status}\t${c.purged ? "purged (artifacts removed)" : c.worktreeRemoved ? "worktree removed" : "no worktree"}`);
  }
  console.log(`\nReclaimed ${body.cleaned.length} run(s); ${body.skipped} left untouched.`);
  return 0;
}

async function getRun(
  url: string | undefined,
  token: string | undefined,
  repo: string | undefined,
  id: string,
): Promise<RunDetails> {
  const target = `${daemonUrl(url)}/runs/${encodeURIComponent(id)}?repo=${encodeURIComponent(resolveRepoArg(repo))}`;
  return requestJson<RunDetails>(target, {}, token);
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

    const name = (run as Run & { name?: string }).name;

    if (role === "group" && children) {
      const ready = children.filter((c) => c.status === "ready").length;
      const failed = children.filter((c) => c.status === "failed" || c.status === "cancelled").length;
      const label = name ? `${name}\t` : "";
      console.log(`${run.id}\t${label}${mode}\t${status}${activeTag(run)}\t(children ${ready}/${children.length} ready${failed ? `, ${failed} failed` : ""})`);
      for (const child of children) {
        const prefix = child === children[children.length - 1] ? "  └─" : "  ├─";
        console.log(`${prefix} ${child.id}\t${child.targetAgent}\t${child.status}${activeTag(child)}\t${child.label ?? ""}`);
      }
    } else {
      const label = name ? `${name}\t` : "";
      console.log(`${run.id}\t${label}${status}${activeTag(run)}\t${run.targetAgent}\t${run.createdAt}\t${run.task}`);
    }
  }
}

/** ` [active]` when the daemon reports a live agent for this run (server-attached `_active`). */
function activeTag(run: Run): string {
  return (run as unknown as Record<string, unknown>)["_active"] ? " [active]" : "";
}

function printDetails(details: RunDetails): void {
  const { run, artifacts, result, progress } = details;
  console.log(`${run.id}: ${run.status}`);
  if (run.name) console.log(`name: ${run.name}`);
  if (progress) {
    console.log(`phase: ${progress.phase}${progress.active ? " (agent active)" : ""}`);
    if (progress.lastEvent) console.log(`last event: ${progress.lastEvent.type} at ${progress.lastEvent.at}`);
  }
  console.log(`target: ${run.targetAgent}`);
  console.log(`branch: ${run.branchName}`);
  console.log(`worktree: ${run.worktreePath}`);
  console.log(`report: ${artifacts.reportPath}`);
  console.log(`events: ${artifacts.eventsPath}`);
  if (artifacts.diffPath) console.log(`diff: ${artifacts.diffPath}`);
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
    progress: details.progress,
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
