// Pure rendering for `portico watch` — no I/O, no stdout. The driver (commands/watch.ts)
// feeds it the folded runs list + the selected row id and writes the returned frame.
// Kept pure so the bucketing, summary, and row layout are unit-testable.

import { formatAgo } from "../duration.ts";
import type { Run } from "@portico/orchestrator";

export type Bucket = "decide" | "active" | "done";

/** A folded run as the listing returns it, plus the transient `_active`/`_children` fields. */
export interface BoardRun {
  id: string;
  status: string;
  name?: string;
  label?: string;
  task: string;
  targetAgent: string;
  mode?: string;
  role?: string;
  groupId?: string;
  updatedAt: string;
  createdAt: string;
  active: boolean;
  /** Event-log mtime for in-flight runs — lets the board flag silence (time since last event). */
  lastEventAt?: string;
  children: BoardRun[];
}

export interface RunRow {
  run: BoardRun;
  bucket: Bucket;
  isChild: boolean;
}

/** Statuses that need a human decision (apply / resolve), surfaced at the top. */
const DECIDE = new Set(["ready", "partial", "conflict"]);
/** In-flight statuses. */
const ACTIVE = new Set(["created", "planning", "running", "testing", "reviewing"]);

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  inverse: "\x1b[7m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

/** Normalize a raw folded Run (with transient `_active`/`_children`) into a BoardRun. */
export function normalizeRun(raw: Run): BoardRun {
  const rec = raw as unknown as Record<string, unknown>;
  const children = (rec["_children"] as Run[] | undefined) ?? [];
  return {
    id: raw.id,
    status: raw.status,
    name: raw.name,
    label: raw.label,
    task: raw.task,
    targetAgent: raw.targetAgent,
    mode: raw.mode,
    role: raw.role,
    groupId: raw.groupId ?? raw.parentRunId,
    updatedAt: raw.updatedAt,
    createdAt: raw.createdAt,
    active: rec["_active"] === true,
    ...(typeof rec["_lastEventAt"] === "string" ? { lastEventAt: rec["_lastEventAt"] as string } : {}),
    children: children.map(normalizeRun),
  };
}

export function bucketOf(status: string): Bucket {
  if (DECIDE.has(status)) return "decide";
  if (ACTIVE.has(status)) return "active";
  return "done";
}

export interface SummaryCounts {
  ready: number;
  partial: number;
  conflict: number;
  active: number;
  failed: number;
}

export function summaryCounts(runs: BoardRun[]): SummaryCounts {
  const c: SummaryCounts = { ready: 0, partial: 0, conflict: 0, active: 0, failed: 0 };
  for (const r of runs) {
    if (r.status === "ready") c.ready++;
    else if (r.status === "partial") c.partial++;
    else if (r.status === "conflict") c.conflict++;
    else if (r.status === "failed" || r.status === "cancelled") c.failed++;
    if (bucketOf(r.status) === "active" || r.active) c.active++;
  }
  return c;
}

/** Compact one-line summary, e.g. "3 ready · 1 conflict · 2 active". Plain text. */
export function summaryLine(runs: BoardRun[]): string {
  const c = summaryCounts(runs);
  const parts: string[] = [];
  if (c.ready) parts.push(`${c.ready} ready`);
  if (c.partial) parts.push(`${c.partial} partial`);
  if (c.conflict) parts.push(`${c.conflict} conflict`);
  if (c.active) parts.push(`${c.active} active`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? parts.join(" · ") : "no runs";
}

/** Ready/total children for a group row (the `done/total` progress borrow). */
export function groupProgress(run: BoardRun): { ready: number; total: number; failed: number } {
  const total = run.children.length;
  const ready = run.children.filter((c) => c.status === "ready").length;
  const failed = run.children.filter((c) => c.status === "failed" || c.status === "cancelled").length;
  return { ready, total, failed };
}

export interface BuildRowsOptions {
  /** Max folded (applied/discarded) done rows before collapsing into "… N more". */
  doneCap?: number;
}

/**
 * Flatten runs into the ordered, selectable rows the board shows: decide bucket first,
 * then active, then done. Group rows are followed by their (indented) child rows. Failed
 * runs always stay visible; surplus applied/discarded rows fold away.
 */
export function buildRows(runs: BoardRun[], opts: BuildRowsOptions = {}): { rows: RunRow[]; foldedDone: number } {
  const doneCap = opts.doneCap ?? 8;
  const byBucket: Record<Bucket, BoardRun[]> = { decide: [], active: [], done: [] };
  for (const r of runs) byBucket[bucketOf(r.status)].push(r);
  for (const b of Object.keys(byBucket) as Bucket[]) {
    byBucket[b].sort((a, z) => z.updatedAt.localeCompare(a.updatedAt));
  }

  const rows: RunRow[] = [];
  const pushRun = (run: BoardRun, bucket: Bucket) => {
    rows.push({ run, bucket, isChild: false });
    for (const child of run.children) rows.push({ run: child, bucket, isChild: true });
  };

  for (const run of byBucket.decide) pushRun(run, "decide");
  for (const run of byBucket.active) pushRun(run, "active");

  // Done: keep failed/cancelled always; fold surplus applied/discarded beyond the cap.
  const done = byBucket.done;
  const alwaysShow = done.filter((r) => r.status === "failed" || r.status === "cancelled");
  const foldable = done.filter((r) => r.status !== "failed" && r.status !== "cancelled");
  const shownFoldable = foldable.slice(0, doneCap);
  const foldedDone = foldable.length - shownFoldable.length;
  for (const run of [...alwaysShow, ...shownFoldable]) pushRun(run, "done");

  return { rows, foldedDone };
}

function color(status: string): string {
  switch (status) {
    case "ready":
      return ANSI.green;
    case "applied":
      return ANSI.green;
    case "partial":
      return ANSI.yellow;
    case "conflict":
    case "failed":
      return ANSI.red;
    case "cancelled":
    case "discarded":
      return ANSI.grey;
    default:
      return ANSI.cyan; // in-flight
  }
}

function pad(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width - 1) + "…" : text;
  return t.padEnd(width);
}

function rowLine(row: RunRow, selected: boolean, now: number): string {
  const { run, isChild } = row;
  const indent = isChild ? "  └ " : "  ";
  const badge = `${color(run.status)}${pad(run.status, 9)}${ANSI.reset}`;
  const display = isChild ? run.label ?? run.name ?? run.id : run.name ?? run.id;
  const name = pad(display, 22);
  const agent = `${ANSI.dim}${pad(run.targetAgent, 10)}${ANSI.reset}`;

  let info: string;
  if (!isChild && run.role === "group") {
    const p = groupProgress(run);
    info = `${run.mode ?? "group"} · ${p.ready}/${p.total} ready${p.failed ? ` · ${p.failed} failed` : ""}`;
  } else {
    const task = run.task.replace(/\s+/g, " ").trim();
    // Active rows lead with idle time (since last event) so a stalled run is obvious even when
    // the task text is truncated; the idle marker survives the pad/truncate below.
    info = run.active && run.lastEventAt ? `⏱ ${formatAgo(run.lastEventAt, now)} idle · ${task}` : task;
  }
  // For an active run, the meaningful age is "since last event" (silence); else "since updated".
  const ageSource = run.active && run.lastEventAt ? run.lastEventAt : run.updatedAt;
  const age = `${ANSI.dim}${pad(formatAgo(ageSource, now), 4)}${ANSI.reset}`;
  const activeMark = run.active ? `${ANSI.cyan}●${ANSI.reset} ` : "  ";

  const line = `${indent}${activeMark}${badge} ${name} ${agent} ${pad(info, 40)} ${age}`;
  return selected ? `${ANSI.inverse}${stripForSelect(line)}${ANSI.reset}` : line;
}

/** Inverse video doesn't compose with nested color codes; flatten to plain text when selected. */
function stripForSelect(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

const HEADERS: Record<Bucket, string> = {
  decide: "Needs decision",
  active: "Working",
  done: "Done",
};

export interface RenderOptions {
  doneCap?: number;
  repoLabel?: string;
}

/** Build the full frame string for the current runs + selection. */
export function renderFrame(
  runs: BoardRun[],
  selectedId: string | undefined,
  opts: RenderOptions = {},
  now = Date.now(),
): string {
  const { rows, foldedDone } = buildRows(runs, { doneCap: opts.doneCap });
  const lines: string[] = [];
  const title = `${ANSI.bold}portico watch${ANSI.reset}`;
  const repo = opts.repoLabel ? ` ${ANSI.dim}${opts.repoLabel}${ANSI.reset}` : "";
  lines.push(`${title}${repo}   ${summaryLine(runs)}`);
  lines.push("");

  if (rows.length === 0) {
    lines.push(`${ANSI.dim}No runs. Start one with: portico delegate --to <agent> --task "…"${ANSI.reset}`);
  }

  let lastBucket: Bucket | undefined;
  for (const row of rows) {
    if (row.bucket !== lastBucket) {
      if (lastBucket !== undefined) lines.push("");
      lines.push(`${ANSI.bold}${HEADERS[row.bucket]}${ANSI.reset}`);
      lastBucket = row.bucket;
    }
    lines.push(rowLine(row, row.run.id === selectedId, now));
  }
  if (foldedDone > 0) lines.push(`${ANSI.dim}  … ${foldedDone} more done${ANSI.reset}`);

  lines.push("");
  lines.push(
    `${ANSI.dim}↑/↓ move · a apply · d discard · c cancel · f follow · r review · i integrate · enter status · q quit${ANSI.reset}`,
  );
  return lines.join("\n");
}

/** The selectable rows in display order — the driver navigates this with ↑/↓. */
export function selectableRows(runs: BoardRun[], opts: BuildRowsOptions = {}): RunRow[] {
  return buildRows(runs, opts).rows;
}

/** ANSI-free snapshot, used when stdout is not a TTY (pipes / `--once`). Tab-separated. */
export function renderPlain(runs: BoardRun[], now = Date.now()): string {
  const lines: string[] = [`portico watch — ${summaryLine(runs)}`];
  const { rows, foldedDone } = buildRows(runs);
  let lastBucket: Bucket | undefined;
  for (const row of rows) {
    if (row.bucket !== lastBucket) {
      lines.push(`\n${HEADERS[row.bucket]}`);
      lastBucket = row.bucket;
    }
    const r = row.run;
    const disp = row.isChild ? r.label ?? r.name ?? r.id : r.name ?? r.id;
    let info: string;
    if (!row.isChild && r.role === "group") {
      const p = groupProgress(r);
      info = `${r.mode ?? "group"} ${p.ready}/${p.total} ready`;
    } else {
      const task = r.task.replace(/\s+/g, " ").trim();
      info = r.active && r.lastEventAt ? `idle ${formatAgo(r.lastEventAt, now)} · ${task}` : task;
    }
    const mark = r.active ? "* " : "  ";
    const ageSource = r.active && r.lastEventAt ? r.lastEventAt : r.updatedAt;
    lines.push(
      `${row.isChild ? "  └ " : "  "}${mark}${r.status.padEnd(9)}\t${disp}\t${r.targetAgent}\t${info}\t${formatAgo(ageSource, now)}`,
    );
  }
  if (foldedDone > 0) lines.push(`  … ${foldedDone} more done`);
  return lines.join("\n");
}
