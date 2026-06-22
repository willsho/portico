// `portico watch` — a live status board for delegation runs, the agent-view borrow.
// Polls GET /runs on an interval, groups runs by state (decision-needed on top), and
// dispatches inline actions to the existing command handlers. Zero TUI dependency:
// raw-mode stdin + ANSI redraw, written by hand. Non-TTY / --once / --json fall back to
// a one-shot snapshot so the command stays scriptable.

import { parseArgs } from "node:util";
import { authHeaders, daemonUrl, fetchWithRetry, resolveRepoArg } from "./http.ts";
import { applyCommand, cancelCommand, discardCommand, integrateCommand, logsCommand, statusCommand } from "./runs.ts";
import { reviewCommand } from "./review.ts";
import { notify } from "../notify.ts";
import { parseDuration } from "../duration.ts";
import {
  buildRows,
  normalizeRun,
  renderFrame,
  renderPlain,
  selectableRows,
  type BoardRun,
  type RunRow,
} from "../tui/board.ts";
import type { Run, RunDetails } from "@portico/orchestrator";

const DECISION_STATUSES = "ready,partial,conflict";

export async function watchCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      status: { type: "string" },
      to: { type: "string" },
      since: { type: "string" },
      "needs-review": { type: "boolean" },
      interval: { type: "string" },
      once: { type: "boolean" },
      json: { type: "boolean" },
      notify: { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico watch [options]

Live status board for delegation runs. Groups runs by state (decision-needed on top),
refreshes on an interval, and dispatches inline actions to the existing commands.

Options:
  --repo <path>            Repository path (default: cwd)
  --status <s1,s2>         Only runs with these statuses (comma-separated)
  --needs-review           Shorthand for --status ${DECISION_STATUSES}
  --to <agent>             Only runs targeting this agent
  --since <dur>            Only runs created within this window (e.g. 30m, 2h)
  --interval <ms>          Poll interval (default 2000)
  --once                   Render a single snapshot and exit (also the non-TTY default)
  --json                   Print the runs JSON once and exit
  --notify                 OS-notify when a run enters ready/partial/conflict/failed (macOS)
  --url <url>              Daemon URL
  --token <token>          Auth token
  -h, --help               Show this help message`);
    return 0;
  }

  const statusFilter = values["needs-review"] ? DECISION_STATUSES : values.status;
  let sinceMs: number | undefined;
  if (values.since !== undefined) {
    sinceMs = parseDuration(values.since);
    if (sinceMs === undefined) {
      console.error(`[portico] invalid --since duration: ${values.since} (try 30m, 2h, 1d)`);
      return 1;
    }
  }

  const interval = values.interval ? Math.max(250, Number(values.interval)) : 2000;
  const repo = resolveRepoArg(values.repo);
  const ctx: WatchCtx = { repo, url: values.url, token: values.token };
  const fetchOpts = { statusFilter, sinceMs, to: values.to };

  // Non-interactive: one snapshot (scriptable). --json prints the raw body.
  const interactive = process.stdout.isTTY && process.stdin.isTTY && !values.once && !values.json;
  if (!interactive) {
    let body: { runs: Run[] };
    try {
      body = await fetchRuns(ctx, fetchOpts);
    } catch (err) {
      console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (values.json) {
      console.log(JSON.stringify(body, null, 2));
    } else {
      console.log(renderPlain(body.runs.map(normalizeRun)));
    }
    return 0;
  }

  return runInteractive(ctx, fetchOpts, interval, values.notify ?? false);
}

interface WatchCtx {
  repo: string;
  url?: string;
  token?: string;
}
interface FetchOpts {
  statusFilter?: string;
  sinceMs?: number;
  to?: string;
}

async function fetchRuns(ctx: WatchCtx, opts: FetchOpts): Promise<{ runs: Run[] }> {
  const params = [`repo=${encodeURIComponent(ctx.repo)}`];
  if (opts.statusFilter) params.push(`status=${encodeURIComponent(opts.statusFilter)}`);
  if (opts.sinceMs !== undefined) params.push(`since=${opts.sinceMs}`);
  const url = `${daemonUrl(ctx.url)}/runs?${params.join("&")}`;
  const res = await fetchWithRetry(url, { headers: authHeaders(ctx.token) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { runs: Run[] };
  if (opts.to) body.runs = body.runs.filter((r) => targetsAgent(r, opts.to as string));
  return body;
}

function targetsAgent(run: Run, agent: string): boolean {
  if (run.targetAgent.split(",").map((s) => s.trim()).includes(agent)) return true;
  const children = (run as unknown as Record<string, unknown>)["_children"] as Run[] | undefined;
  return (children ?? []).some((c) => c.targetAgent === agent);
}

// ── interactive driver ──────────────────────────────────────────────────────

type Mode = "normal" | "confirm" | "pause";

async function runInteractive(ctx: WatchCtx, opts: FetchOpts, interval: number, doNotify: boolean): Promise<number> {
  let runs: BoardRun[] = [];
  let selectedId: string | undefined;
  let banner = "";
  let lastStatus = new Map<string, string>();
  let mode: Mode = "normal";
  let keyResolver: ((key: string) => void) | undefined;
  let suspended = false;
  let stopped = false;
  let lastFrame = "";

  const stdin = process.stdin;
  const stdout = process.stdout;

  const repaint = (force = false) => {
    if (suspended) return;
    const repoLabel = ctx.repo === process.cwd() ? "" : ctx.repo;
    const frame = `${renderFrame(runs, selectedId, { repoLabel })}${banner ? `\n\n${banner}` : ""}\n`;
    if (!force && frame === lastFrame) return;
    lastFrame = frame;
    stdout.write("\x1b[H" + frame + "\x1b[J");
  };

  const poll = async () => {
    try {
      const body = await fetchRuns(ctx, opts);
      runs = body.runs.map(normalizeRun);
      banner = "";
      if (doNotify) fireTransitionNotifications(runs, lastStatus);
      lastStatus = new Map(allRuns(runs).map((r) => [r.id, r.status]));
      const rows = selectableRows(runs);
      if (!rows.some((row) => row.run.id === selectedId)) selectedId = rows[0]?.run.id;
    } catch (err) {
      banner = `\x1b[31m⚠ daemon unreachable (${err instanceof Error ? err.message : String(err)}). retrying…\x1b[0m`;
    }
    repaint();
  };

  const move = (delta: number) => {
    const rows = selectableRows(runs);
    if (rows.length === 0) return;
    let idx = rows.findIndex((r) => r.run.id === selectedId);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
    const sel = rows[idx];
    if (sel) selectedId = sel.run.id;
    repaint();
  };

  const selectedRow = (): RunRow | undefined => selectableRows(runs).find((r) => r.run.id === selectedId);

  const readKey = (next: Mode): Promise<string> =>
    new Promise((resolve) => {
      mode = next;
      keyResolver = resolve;
    });

  /** Suspend the board, run an action with cooked I/O, wait for a keypress, then resume. */
  const suspend = async (fn: () => Promise<unknown>) => {
    suspended = true;
    stdin.setRawMode(false);
    lastFrame = "";
    stdout.write("\x1b[2J\x1b[H\x1b[?25h");
    try {
      await fn();
    } catch (err) {
      console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
    }
    stdout.write("\n— press any key to return to watch —");
    stdin.setRawMode(true);
    await readKey("pause");
    stdout.write("\x1b[?25l");
    suspended = false;
    await poll();
  };

  const doApply = async (row: RunRow) => {
    const plan = applyArgsFor(row);
    if ("error" in plan) {
      banner = `\x1b[33m${plan.error}\x1b[0m`;
      repaint();
      return;
    }
    const guard = await guardLine(ctx, plan.target);
    banner = `apply ${plan.target} — ${guard}  (y to confirm, any other key cancels)`;
    repaint();
    const key = await readKey("confirm");
    if (key !== "y") {
      banner = "apply cancelled";
      repaint();
      return;
    }
    await suspend(() => applyCommand([...plan.args, ...scope(ctx)]));
  };

  const confirmAction = async (verb: "discard" | "cancel", id: string) => {
    banner = `${verb} ${id}? (y to confirm, any other key cancels)`;
    repaint();
    const key = await readKey("confirm");
    if (key !== "y") {
      banner = `${verb} cancelled`;
      repaint();
      return;
    }
    const cmd = verb === "discard" ? discardCommand : cancelCommand;
    await suspend(() => cmd([id, ...scope(ctx)]));
  };

  const onKey = (key: string) => {
    if (mode === "confirm" || mode === "pause") {
      const resolve = keyResolver;
      keyResolver = undefined;
      mode = "normal";
      resolve?.(key);
      return;
    }
    // normal mode
    const row = selectedRow();
    switch (key) {
      case "up":
      case "k":
        move(-1);
        return;
      case "down":
      case "j":
        move(1);
        return;
      case "q":
      case "escape":
      case "ctrl-c":
        stopped = true;
        return;
      case "a":
        if (row) void doApply(row);
        return;
      case "d":
        if (row) void confirmAction("discard", row.run.id);
        return;
      case "c":
        if (row) void confirmAction("cancel", row.run.id);
        return;
      case "f":
        if (row) void suspend(() => logsCommand([row.run.id, "--follow", ...scope(ctx)]));
        return;
      case "enter":
        if (row) void suspend(() => statusCommand([row.run.id, ...scope(ctx)]));
        return;
      case "r":
        if (row) void groupAction(row, "review", reviewCommand, ctx, (b) => (banner = b), repaint, suspend);
        return;
      case "i":
        if (row) void groupAction(row, "integrate", integrateCommand, ctx, (b) => (banner = b), repaint, suspend);
        return;
      default:
        return;
    }
  };

  const onData = (chunk: Buffer) => onKey(parseKey(chunk.toString("utf8")));

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H"); // alternate screen + hide cursor

  let timer: NodeJS.Timeout | undefined;
  let check: NodeJS.Timeout | undefined;
  try {
    await poll();
    timer = setInterval(() => {
      if (!suspended && mode === "normal") void poll();
    }, interval);

    // Spin until quit. onKey sets `stopped`; we resolve and clean up.
    await new Promise<void>((resolve) => {
      check = setInterval(() => {
        if (stopped) resolve();
      }, 50);
    });
    return 0;
  } finally {
    if (timer) clearInterval(timer);
    if (check) clearInterval(check);
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor + restore main screen
  }
}

function scope(ctx: WatchCtx): string[] {
  const out = ["--repo", ctx.repo];
  if (ctx.url) out.push("--url", ctx.url);
  if (ctx.token) out.push("--token", ctx.token);
  return out;
}

/** Flatten groups + children into one list (for transition tracking). */
function allRuns(runs: BoardRun[]): BoardRun[] {
  const out: BoardRun[] = [];
  for (const r of runs) {
    out.push(r);
    for (const c of r.children) out.push(c);
  }
  return out;
}

const NOTIFY_TRANSITIONS = new Set(["ready", "partial", "conflict", "failed", "cancelled"]);

function fireTransitionNotifications(runs: BoardRun[], last: Map<string, string>): void {
  for (const r of allRuns(runs)) {
    const prev = last.get(r.id);
    if (prev !== undefined && prev !== r.status && NOTIFY_TRANSITIONS.has(r.status)) {
      notify(`Portico: ${r.name ?? r.id}`, `${r.status} — ${r.id}`);
    }
  }
}

type ApplyPlan = { args: string[]; target: string } | { error: string };

function applyArgsFor(row: RunRow): ApplyPlan {
  const r = row.run;
  if (row.isChild) {
    if (!r.groupId) return { error: "child run has no group id" };
    return { args: [r.groupId, "--child", r.id], target: r.id };
  }
  if (r.role === "group") {
    if (r.mode === "compare") return { error: "compare group — select a child row to apply one candidate" };
    return { args: [r.id, "--all"], target: r.id };
  }
  return { args: [r.id], target: r.id };
}

async function groupAction(
  row: RunRow,
  verb: string,
  cmd: (args: string[]) => Promise<number>,
  ctx: WatchCtx,
  setBanner: (b: string) => void,
  repaint: () => void,
  suspend: (fn: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const id = row.isChild ? row.run.groupId : row.run.id;
  if (!id || (!row.isChild && row.run.role !== "group")) {
    setBanner(`\x1b[33m${verb} applies to group runs only\x1b[0m`);
    repaint();
    return;
  }
  await suspend(() => cmd([id, ...scope(ctx)]));
}

/** One-line guard summary for the apply confirm, from the run's recorded result. */
async function guardLine(ctx: WatchCtx, id: string): Promise<string> {
  try {
    const url = `${daemonUrl(ctx.url)}/runs/${encodeURIComponent(id)}?repo=${encodeURIComponent(ctx.repo)}`;
    const res = await fetchWithRetry(url, { headers: authHeaders(ctx.token) });
    if (!res.ok) return "guards: unknown";
    const details = (await res.json()) as RunDetails;
    const r = details.result;
    if (!r) return "no result yet";
    const tests = r.tests ?? [];
    const verify = r.verify ?? [];
    const parts = [
      `policy=${r.pathPolicy?.status ?? "n/a"}`,
      `tests=${tests.filter((t) => t.status === "passed").length}/${tests.length}`,
    ];
    if (verify.length) parts.push(`verify=${verify.filter((t) => t.status === "passed").length}/${verify.length}`);
    parts.push(`escape=${r.sandboxEscaped ? "YES" : "no"}`);
    parts.push("(apply still requires a clean tracked tree)");
    return parts.join(" ");
  } catch {
    return "guards: unknown";
  }
}

/** Map a raw stdin chunk to a normalized key name. */
function parseKey(chunk: string): string {
  switch (chunk) {
    case "\x1b[A":
      return "up";
    case "\x1b[B":
      return "down";
    case "\x1b[C":
      return "right";
    case "\x1b[D":
      return "left";
    case "\r":
    case "\n":
      return "enter";
    case "\x1b":
      return "escape";
    case "\x03":
      return "ctrl-c";
    default:
      return chunk.toLowerCase();
  }
}
