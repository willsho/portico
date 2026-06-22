import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketOf,
  buildRows,
  groupProgress,
  normalizeRun,
  renderFrame,
  renderPlain,
  summaryLine,
  type BoardRun,
} from "../src/tui/board.ts";

let seq = 0;
function mk(partial: Partial<BoardRun> & { status: string }): BoardRun {
  const id = partial.id ?? `run_${seq++}`;
  return {
    id,
    status: partial.status,
    name: partial.name ?? id,
    label: partial.label,
    task: partial.task ?? "do a thing",
    targetAgent: partial.targetAgent ?? "codex",
    mode: partial.mode,
    role: partial.role,
    groupId: partial.groupId,
    updatedAt: partial.updatedAt ?? "2026-06-20T00:00:00.000Z",
    createdAt: partial.createdAt ?? "2026-06-20T00:00:00.000Z",
    active: partial.active ?? false,
    ...(partial.lastEventAt ? { lastEventAt: partial.lastEventAt } : {}),
    children: partial.children ?? [],
  };
}

test("bucketOf groups statuses into decide / active / done", () => {
  assert.equal(bucketOf("ready"), "decide");
  assert.equal(bucketOf("conflict"), "decide");
  assert.equal(bucketOf("running"), "active");
  assert.equal(bucketOf("reviewing"), "active");
  assert.equal(bucketOf("applied"), "done");
  assert.equal(bucketOf("failed"), "done");
});

test("summaryLine counts decision-needed and active runs", () => {
  const runs = [
    mk({ status: "ready" }),
    mk({ status: "ready" }),
    mk({ status: "conflict" }),
    mk({ status: "running" }),
    mk({ status: "failed" }),
  ];
  assert.equal(summaryLine(runs), "2 ready · 1 conflict · 1 active · 1 failed");
  assert.equal(summaryLine([]), "no runs");
});

test("buildRows orders decide → active → done and nests children", () => {
  const group = mk({
    id: "g1",
    status: "partial",
    role: "group",
    mode: "compare",
    children: [mk({ id: "c1", status: "ready", groupId: "g1" }), mk({ id: "c2", status: "failed", groupId: "g1" })],
  });
  const runs = [mk({ id: "s1", status: "running" }), group, mk({ id: "s2", status: "applied" })];
  const { rows } = buildRows(runs);
  assert.deepEqual(
    rows.map((r) => r.run.id),
    ["g1", "c1", "c2", "s1", "s2"],
  );
  assert.equal(rows[0]?.bucket, "decide");
  assert.equal(rows[1]?.isChild, true);
  assert.equal(rows[3]?.bucket, "active");
});

test("buildRows folds surplus done runs but always keeps failures", () => {
  const runs: BoardRun[] = [];
  for (let i = 0; i < 10; i++) runs.push(mk({ id: `a${i}`, status: "applied" }));
  runs.push(mk({ id: "f1", status: "failed" }));
  const { rows, foldedDone } = buildRows(runs, { doneCap: 3 });
  assert.equal(foldedDone, 7); // 10 applied, cap 3 → 7 folded
  assert.ok(rows.some((r) => r.run.id === "f1")); // failure never folds
  assert.equal(rows.filter((r) => r.run.status === "applied").length, 3);
});

test("groupProgress reports ready/total/failed", () => {
  const group = mk({
    status: "partial",
    role: "group",
    children: [mk({ status: "ready" }), mk({ status: "ready" }), mk({ status: "failed" })],
  });
  assert.deepEqual(groupProgress(group), { ready: 2, total: 3, failed: 1 });
});

test("renderPlain is ANSI-free and shows names, groups, and folding", () => {
  const group = mk({
    id: "g1",
    name: "fan-out",
    status: "partial",
    role: "group",
    mode: "split",
    children: [mk({ id: "c1", status: "ready", label: "backend", groupId: "g1" })],
  });
  const text = renderPlain([group, mk({ id: "s1", name: "dark-mode", status: "ready" })]);
  assert.doesNotMatch(text, /\x1b\[/); // no escape codes
  assert.match(text, /Needs decision/);
  assert.match(text, /fan-out/);
  assert.match(text, /split 1\/1 ready/);
  assert.match(text, /backend/);
});

test("renderFrame highlights the selected row and includes the summary", () => {
  const runs = [mk({ id: "r1", name: "alpha", status: "ready" }), mk({ id: "r2", name: "beta", status: "running" })];
  const frame = renderFrame(runs, "r2");
  assert.match(frame, /1 ready · 1 active/);
  assert.match(frame, /alpha/);
  assert.match(frame, /beta/);
});

test("normalizeRun lifts transient _active/_children fields", () => {
  const raw = {
    id: "g1",
    status: "partial",
    task: "t",
    targetAgent: "codex,claude",
    mode: "compare",
    role: "group",
    updatedAt: "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    _active: true,
    _children: [{ id: "c1", status: "ready", task: "t", targetAgent: "codex", updatedAt: "x", createdAt: "x" }],
  };
  const norm = normalizeRun(raw as never);
  assert.equal(norm.active, true);
  assert.equal(norm.children.length, 1);
  assert.equal(norm.children[0]?.id, "c1");
});

test("normalizeRun lifts _lastEventAt and renderPlain shows idle time for active runs", () => {
  const raw = {
    id: "s1",
    status: "running",
    task: "do a thing",
    targetAgent: "codex",
    startedAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
    _active: true,
    _lastEventAt: "2026-06-20T00:00:20.000Z",
  };
  const norm = normalizeRun(raw as never);
  assert.equal(norm.lastEventAt, "2026-06-20T00:00:20.000Z");
  // An active run surfaces "idle <ago>" (since the last event) so silence is visible, while the
  // rightmost column tracks total elapsed time (since startedAt) — two distinct facts.
  const text = renderPlain([norm], Date.parse("2026-06-20T00:00:30.000Z"));
  assert.match(text, /idle 10s/);
  assert.match(text, /\t30s$/m); // duration column = now - startedAt
});

test("renderPlain shows the finished span for a done run, not the time since the decision", () => {
  // completedAt stays the finish time even after a later discard; duration = completedAt - startedAt.
  const run = normalizeRun({
    id: "s1",
    status: "discarded",
    task: "do a thing",
    targetAgent: "codex",
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:05:00.000Z",
    updatedAt: "2026-06-20T00:30:00.000Z", // bumped by the discard, 30m later
    createdAt: "2026-06-20T00:00:00.000Z",
  } as never);
  // Render long after the discard — the duration must read 5m (the run), not ~30m (since updated).
  const text = renderPlain([run], Date.parse("2026-06-20T01:00:00.000Z"));
  assert.match(text, /\t5m$/m);
});

test("normalizeRun lifts startedAt/completedAt when present", () => {
  const norm = normalizeRun({
    id: "s1",
    status: "ready",
    task: "t",
    targetAgent: "codex",
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: "2026-06-20T00:02:00.000Z",
    updatedAt: "2026-06-20T00:02:00.000Z",
    createdAt: "2026-06-20T00:00:00.000Z",
  } as never);
  assert.equal(norm.startedAt, "2026-06-20T00:00:00.000Z");
  assert.equal(norm.completedAt, "2026-06-20T00:02:00.000Z");
});
