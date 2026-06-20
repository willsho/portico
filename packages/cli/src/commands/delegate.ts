import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  authHeaders,
  daemonUrl,
  DaemonUnreachableError,
  fetchWithRetry,
  printDaemonError,
  readDelegationStream,
  requestJson,
} from "./http.ts";
import type { DelegateRequest, DelegationEvent, ChildSpec, FanInPolicy, RunDetails, RunStatus } from "@portico/orchestrator";

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
      test: { type: "string", multiple: true },
      verify: { type: "string", multiple: true },
      allowed: { type: "string", multiple: true },
      forbidden: { type: "string", multiple: true },
      timeout: { type: "string" },
      json: { type: "boolean" },
      "review-summary": { type: "boolean" },
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
  --test <cmd>             Test command to run (repeatable)
  --verify <cmd>           Verification check, reported separately from tests (repeatable)
  --allowed <path>         Allowed path (repeatable)
  --forbidden <path>       Forbidden path (repeatable)
  --timeout <ms>           Timeout in milliseconds
  --json                   Output JSON format
  --review-summary         After the run, print a one-click apply command + risk summary
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const task = readTask(values.task, values["task-file"]);
  if ("error" in task) {
    console.error(task.error);
    return 1;
  }

  // Resume mode: resume a child run with a new task.
  if (values.resume) {
    const url = `${daemonUrl(values.url)}/runs/${encodeURIComponent(values.resume)}/resume`;
    let res: Response;
    try {
      res = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
        body: JSON.stringify({ task: task.value }),
      });
    } catch (err) {
      printDaemonError(err, url);
      return 1;
    }
    return (await consumeRunStream(res, values.json ?? false)).code;
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

  // Fan-in policy: merge strategy (split defaults to integration) + optional judge.
  let fanIn: FanInPolicy | undefined;
  if (values.merge || values["judge-to"]) {
    fanIn = {};
    if (values.merge) fanIn.merge = values.merge as FanInPolicy["merge"];
    if (values["judge-to"]) {
      fanIn.judge = { to: values["judge-to"], instruction: values["judge-instruction"] };
    }
  }

  const request: DelegateRequest = {
    to: values.to,
    from: values.from,
    repo: values.repo ?? process.cwd(),
    task: task.value,
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
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    depth: Number(process.env["PORTICO_DELEGATION_DEPTH"] ?? "0"),
  };

  const url = `${daemonUrl(values.url)}/delegate`;
  let res: Response;
  try {
    res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
      body: JSON.stringify(request),
    });
  } catch (err) {
    printDaemonError(err, url);
    return 1;
  }

  const outcome = await consumeRunStream(res, values.json ?? false);
  if (values["review-summary"] && outcome.runId) {
    await printReviewSummary(outcome.runId, values.repo ?? process.cwd(), values.url, values.token);
  }
  return outcome.code;
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
  const isGroup = (run.role ?? "single") === "group";
  const risks: string[] = [];
  if (result?.pathPolicy) {
    risks.push(`path policy: ${result.pathPolicy.status}`);
    if (result.pathPolicy.retryAllowed?.length) {
      risks.push(`  out-of-scope: ${result.pathPolicy.retryAllowed.join(", ")}`);
    }
  }
  const tests = result?.tests ?? [];
  const verify = result?.verify ?? [];
  if (tests.length) risks.push(`tests: ${tests.filter((t) => t.status === "passed").length}/${tests.length} passed`);
  if (verify.length) risks.push(`verify: ${verify.filter((t) => t.status === "passed").length}/${verify.length} passed`);
  if (result?.sandboxEscaped) risks.push("sandbox escape: DETECTED");
  for (const w of result?.gateWarnings ?? []) risks.push(`warning: ${w}`);

  console.log("\n── Review summary ──────────────────────────────");
  console.log(`run ${run.id}: ${run.status}`);
  console.log(risks.length ? risks.join("\n") : "no risks recorded.");
  console.log("");
  if (run.status === "ready") {
    console.log(isGroup ? `apply: portico apply ${run.id} --all` : `apply: portico apply ${run.id}`);
  } else if (run.status === "partial" || isGroup) {
    console.log(`review children: portico review ${run.id}`);
  } else {
    console.log(`not ready (${run.status}); inspect: portico status ${run.id}`);
  }
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
}

async function consumeRunStream(res: Response, json: boolean): Promise<StreamOutcome> {
  let last: DelegationEvent | undefined;
  let runId: string | undefined;
  let status: RunStatus | undefined;
  let finished = false;

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
    }
  } catch (err) {
    console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
    trackingHint();
    return { code: 1, runId, status };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  // Stream ended cleanly but without a terminal event — the run outlived the client.
  if (!finished) trackingHint();
  return { code: last?.type === "run_error" ? 1 : 0, runId, status };
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
      if (event.event.type === "content") process.stdout.write(event.event.delta);
      else if (event.event.type === "reasoning") process.stdout.write(event.event.delta);
      else if (event.event.type === "tool_call") console.log(`\n[${event.runId}] tool: ${event.event.name}`);
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
      console.log(
        event.status === "ready"
          ? `next: portico apply ${event.runId} | portico discard ${event.runId}`
          : `next: portico status ${event.runId} | portico discard ${event.runId}`,
      );
      return;
    case "run_error":
      console.error(`[${event.runId ?? "delegate"}] ${event.code ?? "error"}: ${event.error}`);
      return;
  }
}
