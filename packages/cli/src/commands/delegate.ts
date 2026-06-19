import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { authHeaders, daemonUrl, describeFetchError, fetchWithRetry, readDelegationStream } from "./http.ts";
import type { DelegateRequest, DelegationEvent, ChildSpec, FanInPolicy } from "@portico/orchestrator";

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
      allowed: { type: "string", multiple: true },
      forbidden: { type: "string", multiple: true },
      timeout: { type: "string" },
      json: { type: "boolean" },
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
  --allowed <path>         Allowed path (repeatable)
  --forbidden <path>       Forbidden path (repeatable)
  --timeout <ms>           Timeout in milliseconds
  --json                   Output JSON format
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
      console.error(`[portico] ${describeFetchError(err, url)}`);
      return 1;
    }
    let last: DelegationEvent | undefined;
    try {
      for await (const event of readDelegationStream(res)) {
        last = event;
        if (values.json) console.log(JSON.stringify(event));
        else printEvent(event);
      }
    } catch (err) {
      console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    return last?.type === "run_error" ? 1 : 0;
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
    console.error(`[portico] ${describeFetchError(err, url)}`);
    console.error("[portico] check `portico start` or set PORTICO_URL to the running daemon.");
    return 1;
  }

  let last: DelegationEvent | undefined;
  try {
    for await (const event of readDelegationStream(res)) {
      last = event;
      if (values.json) console.log(JSON.stringify(event));
      else printEvent(event);
    }
  } catch (err) {
    console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  return last?.type === "run_error" ? 1 : 0;
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
