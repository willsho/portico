import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { notifyRunTerminal } from "../notify.ts";
import {
  authHeaders,
  autoStartDaemon,
  daemonUrl,
  DaemonUnreachableError,
  fetchWithRetry,
  printDaemonError,
  readDelegationStream,
  requestJson,
  resolveRepoArg,
} from "./http.ts";
import { logsCommand } from "./runs.ts";
import { buildRunVerdict } from "@portico/orchestrator";
import type { DelegateRequest, DelegationEvent, ChildSpec, FanInPolicy, RunDetails, RunStatus, TestResult } from "@portico/orchestrator";
import { discoverAgents } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";
import { buildContextSections } from "./context-pack.ts";


export const EXIT_CLIENT_DISCONNECTED = 3;
const narratedRuns = new Set<string>();

export function parseCoverageManifest(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    let paths: unknown;
    if (Array.isArray(parsed)) {
      paths = parsed;
    } else if (parsed && typeof parsed === "object") {
      paths = (parsed as Record<string, unknown>).expectedChange || (parsed as Record<string, unknown>).expectedChangePaths;
    }
    if (!Array.isArray(paths)) {
      return [];
    }
    return paths.filter((p) => typeof p === "string");
  } catch {
    return [];
  }
}

export async function buildIterateSection(details: RunDetails, maxChars = 20000): Promise<string> {
  const { run, result } = details;
  const verdict = buildRunVerdict(run, result);
  const lines: string[] = [
    `### Previous attempt: ${run.id} (${run.status})`,
    verdict.topRisks.length ? verdict.topRisks.join("\n") : "no risks recorded.",
  ];

  const failedChecks = [...(result?.tests ?? []), ...(result?.verify ?? [])].filter((check) => check.status === "failed");
  if (failedChecks.length) {
    lines.push("", "Failing checks:");
    for (const check of failedChecks) {
      lines.push(`- ${check.command} (exit ${check.exitCode ?? "unknown"}): ${lastCharsWithMarker(check.output, 2000)}`);
    }
  }

  lines.push("", `Changed files in that attempt: ${result?.changedFiles?.length ? result.changedFiles.join(", ") : "none"}`);
  const fullText = lines.join("\n");
  if (fullText.length > maxChars) {
    const omitted = fullText.length - maxChars;
    const truncated = fullText.slice(0, maxChars);
    const newline = truncated.endsWith("\n") ? "" : "\n";
    return truncated + newline + `[... summary truncated, ${omitted} more characters omitted ...]`;
  }

  return fullText;
}

function lastCharsWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `[... ${omitted} earlier characters omitted ...]\n${text.slice(-maxChars)}`;
}

export async function delegateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      to: { type: "string" },
      from: { type: "string" },
      repo: { type: "string" },
      task: { type: "string" },
      "task-file": { type: "string" },
      name: { type: "string" },
      mode: { type: "string" },
      isolation: { type: "string" },
      "base-ref": { type: "string" },
      cleanup: { type: "string" },
      "permission-profile": { type: "string" },
      "compare-to": { type: "string", multiple: true },
      child: { type: "string", multiple: true },
      merge: { type: "string" },
      "judge-to": { type: "string" },
      "judge-instruction": { type: "string" },
      resume: { type: "string" },
      continue: { type: "string" },
      "iterate-from": { type: "string" },
      context: { type: "string", multiple: true },
      "context-diff": { type: "string", multiple: true },
      "dry-run": { type: "boolean" },

      test: { type: "string", multiple: true },
      verify: { type: "string", multiple: true },
      allowed: { type: "string", multiple: true },
      forbidden: { type: "string", multiple: true },
      "expected-change": { type: "string", multiple: true },
      "coverage-manifest": { type: "string" },
      timeout: { type: "string" },
      "expect-no-changes": { type: "boolean" },
      json: { type: "boolean" },
      "review-summary": { type: "boolean" },
      "apply-on-ready": { type: "boolean" },
      "auto-start": { type: "boolean" },
      "no-auto-start": { type: "boolean" },
      detach: { type: "boolean" },
      notify: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      follow: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico delegate --to <agent> (--task <task> | --task-file <path>) [options]

Options:
  --to <agent>             Target agent to delegate to
  --from <agent>           Agent that initiated this delegation
  --repo <path>            Repository path (default: cwd)
  --task <task>            The task description
  --task-file <path>       Read task from a UTF-8 file, or stdin with -
  --dry-run                Lint the task for files/acceptance-criteria/test-command, then exit
  --context <path>         File or glob to splice into the task as context (repeatable)
  --context-diff <ref>     \`git diff <ref>\` output to splice into the task as context (repeatable)

  --name <name>            Human-readable run name shown in runs/watch (default: slug of task)
  --mode <mode>            Delegation mode
  --isolation <mode>       Isolation mode
  --base-ref <ref>         Base Git reference
  --cleanup <policy>       Cleanup policy
  --permission-profile <p> Permission profile
  --compare-to <agent>     Agent to compare against (repeatable)
  --child <json>           Child spec JSON (repeatable)
  --merge <strategy>       Fan-in merge strategy
  --judge-to <agent>       Agent to judge fan-in
  --judge-instruction <t>  Instruction for the judge
  --resume <run_id>        Resume a child run with a new task
  --continue <run_id>      Re-run a run in its existing worktree without session resume
  --iterate-from <run_id>  Prepend a failure/result summary from a previous run into this task
  --test <cmd>             Test command to run (repeatable)
  --verify <cmd>           Verification check, reported separately from tests (repeatable)
  --allowed <path>         Allowed path (repeatable)
  --forbidden <path>       Forbidden path (repeatable)
  --expected-change <path> Path expected to be changed; reports coverage + warns on a gap (repeatable)
  --coverage-manifest <path> Manifest file with expected-change paths
  --timeout <ms>           Timeout in milliseconds
  --expect-no-changes      Treat a no-change result as acceptable (skip the no-change warning)
  --json                   Output JSON format
  --review-summary         After the run, print a one-click apply command + risk summary
  --apply-on-ready         Auto-apply a ready single run when all safety guards pass (opt-in)
  --auto-start             If the loopback daemon isn't running, start it and retry once (default: on)
  --no-auto-start          Don't auto-start a loopback daemon; fail fast if none is reachable
  --detach                 Exit as soon as the run starts, printing its id (run continues)
  --notify                 Fire an OS notification when the run reaches a terminal state (macOS)
  -y, --yes                Skip the fan-out preflight confirmation prompt
  --follow <run_id>        Re-attach to a run's event log (same as logs --follow)
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message

Exit codes:
  0    Success (run completed / ready, or --detach registered the run)
  1    Run failed or errored
  3    Client disconnected; the run may still be executing on the daemon
  130  Interrupted (Ctrl-C)`);
    return 0;
  }

  // Zero-config default: auto-start a loopback daemon when none is reachable, so a bare
  // `delegate` works without a prior `portico start`. `--no-auto-start` opts back out
  // (e.g. CI expecting a pre-existing daemon); `--auto-start` is kept as an explicit no-op.
  const autoStart = !values["no-auto-start"];

  // Re-attach to an already-running (e.g. detached) run's event log.
  if (values.follow) {
    const followArgs = ["--follow", values.follow];
    if (values.repo) followArgs.push("--repo", values.repo);
    if (values.url) followArgs.push("--url", values.url);
    if (values.token) followArgs.push("--token", values.token);
    if (values.json) followArgs.push("--json");
    return logsCommand(followArgs);
  }

  const task = readTask(values.task, values["task-file"]);
  if ("error" in task) {
    console.error(task.error);
    return 1;
  }

  const repo = resolveRepoArg(values.repo);
  const contextBlocks: string[] = [];
  const continuationFlags = [
    values.resume ? "--resume" : undefined,
    values.continue ? "--continue" : undefined,
    values["iterate-from"] ? "--iterate-from" : undefined,
  ].filter(Boolean);
  if (continuationFlags.length > 1) {
    console.error(`[portico] ${continuationFlags.join(", ")} are mutually exclusive.`);
    return 1;
  }

  if (values["iterate-from"]) {
    const runId = values["iterate-from"];
    const target = `${daemonUrl(values.url)}/runs/${encodeURIComponent(runId)}?repo=${encodeURIComponent(repo)}`;
    let details: RunDetails;
    try {
      details = await requestJson<RunDetails>(target, {}, values.token);
    } catch (err) {
      if (err instanceof DaemonUnreachableError) return 1;
      console.error(`[portico] Error reading --iterate-from run "${runId}": ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    contextBlocks.push(await buildIterateSection(details));
  }
  const contextSections = await buildContextSections(
    repo,
    values.context ?? [],
    values["context-diff"] ?? [],
  );
  if (contextSections) {
    contextBlocks.push(contextSections);
  }
  if (contextBlocks.length) {
    task.value = task.value + "\n\n## Context\n" + contextBlocks.join("\n\n");
  }


  // Resume mode: resume a child run with a new task.
  if (values.resume) {
    const base = daemonUrl(values.url);
    // Forward the resolved repo just like status/apply — without it the daemon falls back to
    // its own cwd (`repoFromUrl` → `process.cwd()`) and resumes against the wrong run store.
    const repo = encodeURIComponent(resolveRepoArg(values.repo));
    const url = `${base}/runs/${encodeURIComponent(values.resume)}/resume?repo=${repo}`;
    const res = await postDelegationStream(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
        body: JSON.stringify({ task: task.value }),
      },
      base,
      autoStart,
      values.token,
    );
    if (!res) return 1;
    return (await consumeRunStream(res, values.json ?? false, values.detach ?? false)).code;
  }

  // Continue mode: re-run a run in its existing worktree with a fresh agent session.
  if (values.continue) {
    const base = daemonUrl(values.url);
    const repo = encodeURIComponent(resolveRepoArg(values.repo));
    const url = `${base}/runs/${encodeURIComponent(values.continue)}/continue?repo=${repo}`;
    const res = await postDelegationStream(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
        body: JSON.stringify({ task: task.value }),
      },
      base,
      autoStart,
      values.token,
    );
    if (!res) return 1;
    return (await consumeRunStream(res, values.json ?? false, values.detach ?? false)).code;
  }

  // Children: parse JSON specs from repeated --child flags.
  let children: ChildSpec[] | undefined;
  if (values.child?.length) {
    children = [];
    for (const raw of values.child) {
      try {
        children.push(JSON.parse(raw) as ChildSpec);
      } catch {
        console.error(`[portico] Invalid --child JSON: ${raw}`);
        return 1;
      }
    }
  }

  if (!values.to) {
    console.error("Usage: portico delegate --to <agent> (--task <task> | --task-file <path>) [--repo .] [--test <cmd>]");
    return 1;
  }

  if (values["dry-run"]) {
    const packedText = task.value;
    const hasFilePath = /[\w.-]+\/[\w.-]+\.[A-Za-z0-9]{1,5}\b/.test(packedText);
    const lowerText = packedText.toLowerCase();
    const hasAcceptance = ["acceptance criteria", "done when", "definition of done", "acceptance:", "criteria:"].some(s => lowerText.includes(s));
    const hasTestFlag = (values.test?.length ?? 0) > 0;
    const hasTestCmd = hasTestFlag || /\b(npm (run|test)|pytest|go test|cargo test|yarn test|pnpm test)\b/i.test(packedText);

    console.log(`[portico] dry-run task self-check (--to ${values.to}):`);
    console.log(`  [${hasFilePath ? "✓" : "✗"}] names a concrete file or path`);
    console.log(`  [${hasAcceptance ? "✓" : "✗"}] states acceptance criteria`);
    console.log(`  [${hasTestCmd ? "✓" : "✗"}] specifies a test command`);

    const allPass = hasFilePath && hasAcceptance && hasTestCmd;
    return allPass ? 0 : 1;
  }


  // Fan-in policy: merge strategy (split defaults to integration) + optional judge.
  let fanIn: FanInPolicy | undefined;
  if (values.merge || values["judge-to"]) {
    fanIn = {};
    if (values.merge) fanIn.merge = values.merge as FanInPolicy["merge"];
    if (values["judge-to"]) {
      fanIn.judge = { to: values["judge-to"], instruction: values["judge-instruction"] };
    }
  }

  let expectedChangePaths = values["expected-change"] ? [...values["expected-change"]] : undefined;
  if (values["coverage-manifest"]) {
    try {
      const content = readFileSync(values["coverage-manifest"], "utf8");
      const manifestPaths = parseCoverageManifest(content);
      if (manifestPaths.length === 0) {
        console.error(`[portico] Error: coverage manifest '${values["coverage-manifest"]}' has no usable string paths`);
        return 1;
      }
      if (!expectedChangePaths) expectedChangePaths = [];
      const seen = new Set(expectedChangePaths);
      for (const p of manifestPaths) {
        if (!seen.has(p)) {
          expectedChangePaths.push(p);
          seen.add(p);
        }
      }
    } catch (err) {
      console.error(`[portico] Error reading coverage manifest '${values["coverage-manifest"]}': ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const request: DelegateRequest = {
    to: values.to,
    from: values.from,
    repo: resolveRepoArg(values.repo),
    task: task.value,
    name: values.name,
    mode: values.mode as DelegateRequest["mode"],
    isolation: values.isolation as DelegateRequest["isolation"],
    baseRef: values["base-ref"],
    cleanup: values.cleanup as DelegateRequest["cleanup"],
    permissionProfile: values["permission-profile"] as DelegateRequest["permissionProfile"],
    compareTargets: values["compare-to"],
    children,
    fanIn,
    testCommands: values.test,
    verifyCommands: values.verify,
    allowedPaths: values.allowed,
    forbiddenPaths: values.forbidden,
    expectedChangePaths: expectedChangePaths,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    expectNoChanges: values["expect-no-changes"],
    depth: Number(process.env["PORTICO_DELEGATION_DEPTH"] ?? "0"),
  };

  const base = daemonUrl(values.url);

  installBuiltinAdapters();
  const discovered = await discoverAgents({ skipVersion: true });
  const availableProviders = new Set(
    discovered.filter((a) => a.available).map((a) => a.provider)
  );

  const targets = new Set<string>();
  if (request.to) {
    targets.add(request.to);
  }
  if (request.compareTargets) {
    for (const t of request.compareTargets) {
      targets.add(t);
    }
  }
  if (request.children) {
    for (const c of request.children) {
      if (c.to) {
        targets.add(c.to);
      }
    }
  }

  let anyMissing = false;
  for (const target of targets) {
    if (!availableProviders.has(target)) {
      console.error(`[portico] agent "${target}" is not available — check: portico agents`);
      anyMissing = true;
    }
  }
  if (anyMissing) {
    return 1;
  }

  // Preflight: echo the resolved facts *before* any agent launches, so a wrong repo / base ref
  // is caught up front instead of after N fan-out agents have already burned time. For a
  // multi-agent fan-out at an interactive terminal, also require confirmation (skip with
  // --yes / non-TTY so agent-driven and scripted use never blocks).
  if (!(await printPreflightAndConfirm(request, base, values.yes ?? false))) {

    console.error("[portico] aborted before launch (no agents started).");
    return 0;
  }

  const url = `${base}/delegate`;
  const res = await postDelegationStream(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
      body: JSON.stringify(request),
    },
    base,
    autoStart,
    values.token,
  );
  if (!res) return 1;

  const outcome = await consumeRunStream(res, values.json ?? false, values.detach ?? false);
  const repoPath = resolveRepoArg(values.repo);
  if (outcome.detached) {
    if (values.notify && outcome.runId) {
      spawnDetachedNotifyWatch(outcome.runId, repoPath, values.url, values.token);
    }
    return outcome.code;
  }
  if (values.notify && outcome.runId) {
    await notifyRunTerminal(outcome.runId, repoPath, values.url, values.token);
  }
  if (values["apply-on-ready"] && outcome.runId) {
    await maybeApplyOnReady(outcome, request, repoPath, values.url, values.token);
  } else if (values["review-summary"] && outcome.runId) {
    await printReviewSummary(outcome.runId, repoPath, values.url, values.token);
  }
  return outcome.code;
}

/**
 * POST a delegation request, with optional auto-start: if the initial request fails to
 * reach the daemon and `--auto-start` is set, start a loopback daemon and retry once.
 * Returns null (after printing a diagnosis) when the daemon stays unreachable.
 */
async function postDelegationStream(
  endpoint: string,
  init: RequestInit,
  base: string,
  autoStart: boolean,
  token?: string,
): Promise<Response | null> {
  try {
    return await fetchWithRetry(endpoint, init);
  } catch (err) {
    if (autoStart) {
      const activeBase = await autoStartDaemon(base, token);
      if (activeBase) {
        try {
          const newBase = typeof activeBase === "string" ? activeBase : base;
          const retryEndpoint = endpoint.replace(base, newBase);
          return await fetchWithRetry(retryEndpoint, init);
        } catch (retryErr) {
          printDaemonError(retryErr, endpoint);
          return null;
        }
      }
    }
    printDaemonError(err, endpoint);
    return null;
  }
}

/**
 * `--apply-on-ready` gate (opt-in): auto-apply a *single* ready run only when every safety
 * guard holds — an explicit `--allowed` boundary, path policy passed, no sandbox escape, and
 * all tests + verify checks green. Apply itself enforces the clean-tracked-tree guard. When a
 * guard is unmet we never apply; we print the unmet items and the review summary instead.
 */
async function maybeApplyOnReady(
  outcome: StreamOutcome,
  request: DelegateRequest,
  repo: string,
  url?: string,
  token?: string,
): Promise<void> {
  const runId = outcome.runId as string;
  const target = `${daemonUrl(url)}/runs/${encodeURIComponent(runId)}?repo=${encodeURIComponent(repo)}`;
  let details: RunDetails;
  try {
    details = await requestJson<RunDetails>(target, {}, token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return;
    throw err;
  }

  const { run, result } = details;
  console.log("\n── apply-on-ready ──────────────────────────────");
  if ((run.role ?? "single") === "group") {
    console.log("group runs aren't auto-applied; review children first.");
    await printReviewSummary(runId, repo, url, token);
    return;
  }

  const unmet: string[] = [];
  if (!request.allowedPaths?.length) unmet.push("no --allowed path boundary (required for auto-apply)");
  if (run.status !== "ready") unmet.push(`run is ${run.status}, not ready`);
  if (result?.pathPolicy && result.pathPolicy.status !== "passed") unmet.push("path policy failed");
  if (result?.sandboxEscaped) unmet.push("sandbox escape detected");
  const failed = (checks: TestResult[] | undefined) => (checks ?? []).some((c) => c.status === "failed");
  if (failed(result?.tests)) unmet.push("one or more tests failed");
  if (failed(result?.verify)) unmet.push("one or more verify checks failed");
  for (const w of result?.gateWarnings ?? []) unmet.push(`gate warning: ${w}`);

  if (unmet.length) {
    console.log("not auto-applying — unmet guards:");
    for (const item of unmet) console.log(`  - ${item}`);
    await printReviewSummary(runId, repo, url, token);
    return;
  }

  const applyUrl = `${daemonUrl(url)}/runs/${encodeURIComponent(runId)}/apply?repo=${encodeURIComponent(repo)}`;
  try {
    const applied = await requestJson<RunDetails>(applyUrl, { method: "POST" }, token);
    console.log(`all guards passed — auto-applied: ${applied.run.id} (${applied.run.status})`);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return;
    console.log(`auto-apply failed: ${err instanceof Error ? err.message : String(err)}`);
    await printReviewSummary(runId, repo, url, token);
  }
}

export function getNextActionHint(
  run: { id: string; status: RunStatus; role?: string },
  reviewDecision?: "approve" | "needs_attention" | null
): string {
  const isGroup = (run.role ?? "single") === "group";
  if (run.status === "ready" && reviewDecision === "needs_attention") {
    return `needs attention before apply; inspect: portico status ${run.id}`;
  } else if (run.status === "ready") {
    return isGroup ? `apply: portico apply ${run.id} --all` : `apply: portico apply ${run.id}`;
  } else if (run.status === "partial" || isGroup) {
    return `review children: portico review ${run.id}`;
  } else {
    return `not ready (${run.status}); inspect: portico status ${run.id}`;
  }
}

/**
 * After a run finishes, print a copy-paste apply command plus a risk summary
 * (path policy, tests/verify, gate warnings). Lets an authorized reviewer act in one
 * step without hand-assembling the apply command or re-reading the report.
 */
async function printReviewSummary(runId: string, repo: string, url?: string, token?: string): Promise<void> {
  const target = `${daemonUrl(url)}/runs/${encodeURIComponent(runId)}?repo=${encodeURIComponent(repo)}`;
  let details: RunDetails;
  try {
    details = await requestJson<RunDetails>(target, {}, token);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return;
    throw err;
  }

  const { run, result } = details;
  const verdict = buildRunVerdict(run, result);

  console.log("\n── Review summary ──────────────────────────────");
  console.log(`run ${run.id}: ${run.status}`);
  console.log(verdict.topRisks.length ? verdict.topRisks.join("\n") : "no risks recorded.");
  console.log("");
  console.log(getNextActionHint(run, result?.reviewDecision));
  console.log(`discard: portico discard ${run.id}`);
}

/**
 * Drive a delegation NDJSON stream to the terminal. Captures the run id from the
 * first event so that, if the client is interrupted (Ctrl-C) or the connection
 * drops before `run_done`, we tell the user the run may still be executing on the
 * daemon and how to track it — instead of leaving them to guess from `[terminated]`.
 */
interface StreamOutcome {
  code: number;
  runId?: string;
  status?: RunStatus;
  /** True when --detach returned early; the run continues on the daemon. */
  detached?: boolean;
}

async function consumeRunStream(res: Response, json: boolean, detach = false): Promise<StreamOutcome> {
  let last: DelegationEvent | undefined;
  let runId: string | undefined;
  let status: RunStatus | undefined;
  let finished = false;
  let detached = false;

  const trackingHint = () => {
    if (!runId || finished) return;
    console.error(`\n[portico] run ${runId} may still be running on the daemon (the client disconnected).`);
    console.error(`[portico] track it: portico status ${runId} | portico logs ${runId} --follow`);
  };
  const onSigint = () => {
    trackingHint();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    for await (const event of readDelegationStream(res)) {
      last = event;
      if ("runId" in event && event.runId) runId = event.runId;
      if (event.type === "run_done") {
        finished = true;
        status = event.status;
      } else if (event.type === "run_error") {
        finished = true;
      }
      if (json) console.log(JSON.stringify(event));
      else printEvent(event);
      // --detach: leave as soon as the run is registered. handleDelegate does not abort on
      // client disconnect, so the run keeps executing on the daemon.
      if (detach && runId && event.type === "run_start") {
        detached = true;
        console.log(`[${runId}] detached — track it: portico logs ${runId} --follow | portico status ${runId}`);
        break;
      }
    }
  } catch (err) {
    console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
    trackingHint();
    return { code: runId ? EXIT_CLIENT_DISCONNECTED : 1, runId, status };
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (detached) await res.body?.cancel().catch(() => {});
  }

  if (detached) return { code: 0, runId, status, detached: true };
  // Stream ended cleanly but without a terminal event — the run outlived the client.
  if (!finished) trackingHint();
  return { code: last?.type === "run_error" ? 1 : (!finished && runId ? EXIT_CLIENT_DISCONNECTED : 0), runId, status };
}

/**
 * Spawn a detached background watcher that notifies once the run reaches a terminal state.
 * Needed for `--detach --notify`: the foreground process exits at run_start, so a separate
 * process must observe the terminal event. Loopback-only side effect; fully best-effort.
 */
function spawnDetachedNotifyWatch(runId: string, repo: string, url?: string, token?: string): void {
  const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const args = ["_notify-watch", runId, "--repo", repo];
  if (url) args.push("--url", url);
  if (token) args.push("--token", token);
  const child = spawn(process.execPath, [...process.execArgv, cliEntry, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

/**
 * Enumerate the agents a request will launch, so the preflight shows exactly what is about to
 * run. Children take precedence (heterogeneous fan-out), then compare targets, else a single
 * target.
 */
function describeTargets(request: DelegateRequest): { count: number; lines: string[] } {
  if (request.children?.length) {
    return {
      count: request.children.length,
      lines: request.children.map((c, i) => `  - ${c.label ?? `c${i + 1}`}: ${c.to}${c.task ? ` — ${snippet(c.task)}` : ""}`),
    };
  }
  if (request.compareTargets?.length) {
    const all = [request.to, ...request.compareTargets];
    return { count: all.length, lines: all.map((a, i) => `  - candidate ${i + 1}: ${a}`) };
  }
  return { count: 1, lines: [`  - ${request.to}`] };
}

function snippet(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Print the resolved repo / base ref / worktree root / daemon URL and the agents about to run,
 * then — only for a multi-agent fan-out at an interactive TTY — ask for confirmation. Returns
 * false when the user declines. The echo goes to stderr so it never corrupts a `--json` stdout
 * stream, and confirmation is skipped for `--yes` and non-interactive (agent-driven / scripted)
 * use so automation never blocks.
 */
async function printPreflightAndConfirm(request: DelegateRequest, base: string, skipConfirm: boolean): Promise<boolean> {
  const { count, lines } = describeTargets(request);
  const worktreeRoot = join(request.repo, ".portico", "worktrees");
  console.error("[portico] preflight:");
  console.error(`  daemon:        ${base}`);
  console.error(`  repo:          ${request.repo}`);
  console.error(`  base ref:      ${request.baseRef ?? "HEAD (default)"}`);
  console.error(`  worktree root: ${worktreeRoot}`);
  console.error(`  timeout:       ${request.timeoutMs ? `${request.timeoutMs}ms` : "daemon default"}`);
  console.error(`  ${count === 1 ? "agent" : `agents (${count})`}:`);
  for (const line of lines) console.error(line);

  const isFanout = count > 1;
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  if (!isFanout || skipConfirm || !interactive) return true;
  return confirm(`Launch ${count} agents in ${request.repo}? [y/N] `);
}

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function readTask(task: string | undefined, taskFile: string | undefined): { value: string; error?: undefined } | { error: string } {
  if ((task !== undefined && taskFile !== undefined) || (task === undefined && taskFile === undefined)) {
    return { error: "Usage: portico delegate --to <agent> (--task <task> | --task-file <path>) [--repo .]" };
  }

  let value: string;
  if (taskFile !== undefined) {
    try {
      value = readFileSync(taskFile === "-" ? 0 : taskFile, "utf8");
    } catch (err) {
      return { error: `[portico] Error reading task file: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    value = task ?? "";
  }

  if (value.length === 0) return { error: "[portico] Error: task is empty" };
  return { value };
}

export function printEvent(event: DelegationEvent): void {
  switch (event.type) {
    case "run_start":
      console.log(`[${event.runId}] started`);
      return;
    case "worktree_created":
      console.log(`[${event.runId}] worktree ${event.path} (${event.branch})`);
      return;
    case "agent_start":
      console.log(`[${event.runId}] agent ${event.agent} started`);
      return;
    case "agent_event":
      if (event.event.type === "content" || event.event.type === "reasoning") {
        if (!narratedRuns.has(event.runId)) {
          console.log(`[${event.runId}] agent narration (unverified, not Portico's verdict):`);
          narratedRuns.add(event.runId);
        }
        process.stdout.write(event.event.delta);
      } else if (event.event.type === "tool_call") console.log(`\n[${event.runId}] tool: ${event.event.name}`);
      else if (event.event.type === "tool_result") console.log(`\n[${event.runId}] tool result: ${event.event.name}`);
      else if (event.event.type === "done") console.log(`\n[${event.runId}] agent done`);
      else if (event.event.type === "error") console.log(`\n[${event.runId}] agent error: ${event.event.error}`);
      return;
    case "sandbox_escape_detected":
      console.error(`\n[${event.runId}] WARNING: sandbox escape detected`);
      for (const change of event.changes) console.error(`  ${change.status} ${change.path}`);
      return;
    case "diff_ready":
      console.log(`\n[${event.runId}] diff ${event.path}`);
      console.log(`changed files: ${event.changedFiles.length ? event.changedFiles.join(", ") : "none"}`);
      return;
    case "verdict_update":
      console.log(
        `[${event.runId}] verdict (Portico, in progress): ${event.verdict.topRisks.length ? event.verdict.topRisks.join("; ") : "no risks yet"}`,
      );
      return;
    case "fanin_start":
      console.log(`[${event.runId}] fan-in: ${event.strategy}`);
      return;
    case "merge_done":
      console.log(`[${event.runId}] merge ${event.status}${event.conflicts?.length ? `: conflicts in ${event.conflicts.join(", ")}` : ""}`);
      return;
    case "judge_done":
      console.log(
        `[${event.runId}] judge done${event.recommendedChildId ? `: recommend ${event.recommendedChildId}` : ""}${event.verdict ? ` (${event.verdict})` : ""}`,
      );
      return;
    case "test_start":
      console.log(`[${event.runId}] test: ${event.command}`);
      return;
    case "test_done":
      console.log(`[${event.runId}] test ${event.status} (${event.exitCode ?? "null"}): ${event.command}`);
      return;
    case "run_done":
      console.log(`[${event.runId}] ${event.status}`);
      console.log(`report: ${event.reportPath}`);
      if (event.verdict?.topRisks.length) console.log(event.verdict.topRisks.join("\n"));
      console.log(
        (event.verdict ? event.verdict.readiness === "ready" : event.status === "ready")
          ? `next: portico apply ${event.runId} | portico discard ${event.runId}`
          : `next: portico status ${event.runId} | portico discard ${event.runId}`,
      );
      return;
    case "run_error":
      console.error(`[${event.runId ?? "delegate"}] ${event.code ?? "error"}: ${event.error}`);
      if (event.verdict?.changedFiles.length) {
        console.error(`[${event.runId}] left ${event.verdict.changedFiles.length} changed file(s) in the worktree (salvaged)`);
        console.error(`next: portico status ${event.runId} | portico discard ${event.runId}`);
      }
      return;
  }
}
