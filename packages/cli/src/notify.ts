// Best-effort OS notifications for delegation runs reaching a terminal state.
// Zero-dependency: shells out to the platform notifier. Darwin uses `osascript`
// (the plan's first-phase scope); other platforms are a silent no-op. Any failure
// is swallowed — a missing notifier must never break the command that asked for it.

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  authHeaders,
  daemonUrl,
  fetchWithRetry,
  readDelegationStream,
} from "./commands/http.ts";
import type { DelegationEvent, RunDetails } from "@portico/orchestrator";

/** Statuses worth interrupting the user for: a decision is now possible (ready/partial/
 *  conflict) or the run failed. Working/applied/discarded never notify. */
export const NOTIFY_STATUSES = new Set(["ready", "partial", "conflict", "failed", "cancelled"]);

/** Fire a single OS notification. Best-effort and silent on unsupported platforms. */
export function notify(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${quote(body)} with title ${quote(title)}`;
      const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
    // Other platforms: no-op for now (plan: first phase is darwin-only).
  } catch {
    // Never let notification failure surface to the caller.
  }
}

function quote(text: string): string {
  // AppleScript string literal: wrap in quotes, escape backslashes and quotes.
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Fetch a run's name + status and, when terminal-worthy, fire a notification.
 *  Used after a foreground run finishes. */
export async function notifyRunTerminal(
  runId: string,
  repo: string,
  url?: string,
  token?: string,
): Promise<void> {
  const target = `${daemonUrl(url)}/runs/${encodeURIComponent(runId)}?repo=${encodeURIComponent(repo)}`;
  let details: RunDetails;
  try {
    const res = await fetchWithRetry(target, { headers: authHeaders(token) });
    if (!res.ok) return;
    details = (await res.json()) as RunDetails;
  } catch {
    return;
  }
  const { run } = details;
  if (!NOTIFY_STATUSES.has(run.status)) return;
  notify(`Portico: ${run.name ?? run.id}`, `${run.status} — ${run.id}`);
}

/**
 * Poll a run's event log until it reaches a terminal event, then notify. Backs the
 * detached `--notify` path: the foreground process exits at run_start, so a separate
 * watcher must observe the terminal state. Mirrors `logs --follow`'s snapshot polling.
 */
export async function watchAndNotify(
  runId: string,
  repo: string,
  url?: string,
  token?: string,
  pollMs = 1500,
  timeoutMs = 6 * 60 * 60 * 1000,
): Promise<void> {
  const eventsUrl = `${daemonUrl(url)}/runs/${encodeURIComponent(runId)}/events?repo=${encodeURIComponent(repo)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let terminal: DelegationEvent | undefined;
    try {
      const res = await fetchWithRetry(eventsUrl, { headers: authHeaders(token) });
      if (res.ok) {
        for await (const event of readDelegationStream(res)) {
          if (event.type === "run_done" || event.type === "run_error") terminal = event;
        }
      }
    } catch {
      // Daemon momentarily unreachable — retry until the deadline.
    }
    if (terminal) {
      await notifyRunTerminal(runId, repo, url, token);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Internal `portico _notify-watch <run_id>` command: a headless detached watcher that
 *  notifies once the run finishes. Spawned by `delegate --detach --notify`; not in USAGE. */
export async function notifyWatchCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });
  const runId = positionals[0];
  if (!runId) return 1;
  await watchAndNotify(runId, values.repo ?? process.cwd(), values.url, values.token);
  return 0;
}
