import { parseArgs } from "node:util";
import { authHeaders, daemonUrl, readDelegationStream } from "./http.ts";
import type { DelegateRequest, DelegationEvent } from "@portico/orchestrator";

export async function delegateCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      to: { type: "string" },
      from: { type: "string" },
      repo: { type: "string" },
      task: { type: "string" },
      mode: { type: "string" },
      isolation: { type: "string" },
      "base-ref": { type: "string" },
      cleanup: { type: "string" },
      "permission-profile": { type: "string" },
      "compare-to": { type: "string", multiple: true },
      test: { type: "string", multiple: true },
      allowed: { type: "string", multiple: true },
      forbidden: { type: "string", multiple: true },
      timeout: { type: "string" },
      json: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (!values.to || !values.task) {
    console.error("Usage: portico delegate --to <agent> --task <task> [--repo .] [--test <cmd>]");
    return 1;
  }

  const request: DelegateRequest = {
    to: values.to,
    from: values.from,
    repo: values.repo ?? process.cwd(),
    task: values.task,
    // Forward raw strategy fields; the daemon validates supported combinations.
    mode: values.mode as DelegateRequest["mode"],
    isolation: values.isolation as DelegateRequest["isolation"],
    baseRef: values["base-ref"],
    cleanup: values.cleanup as DelegateRequest["cleanup"],
    permissionProfile: values["permission-profile"] as DelegateRequest["permissionProfile"],
    compareTargets: values["compare-to"],
    testCommands: values.test,
    allowedPaths: values.allowed,
    forbiddenPaths: values.forbidden,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    depth: Number(process.env["PORTICO_DELEGATION_DEPTH"] ?? "0"),
  };

  const res = await fetch(`${daemonUrl(values.url)}/delegate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(values.token) },
    body: JSON.stringify(request),
  });

  let last: DelegationEvent | undefined;
  for await (const event of readDelegationStream(res)) {
    last = event;
    if (values.json) console.log(JSON.stringify(event));
    else printEvent(event);
  }

  return last?.type === "run_error" ? 1 : 0;
}

function printEvent(event: DelegationEvent): void {
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
      else if (event.event.type === "done") console.log(`\n[${event.runId}] agent done`);
      else if (event.event.type === "error") console.log(`\n[${event.runId}] agent error: ${event.event.error}`);
      return;
    case "diff_ready":
      console.log(`\n[${event.runId}] diff ${event.path}`);
      console.log(`changed files: ${event.changedFiles.length ? event.changedFiles.join(", ") : "none"}`);
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
      console.log(`next: portico apply ${event.runId} | portico discard ${event.runId}`);
      return;
    case "run_error":
      console.error(`[${event.runId ?? "delegate"}] ${event.code ?? "error"}: ${event.error}`);
      return;
  }
}
