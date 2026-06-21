import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCommand, computeOverlap } from "../src/commands/review.ts";

function childResult(
  id: string,
  label: string,
  status: string,
  changedFiles: string[],
  applyCheck?: { applies: boolean; reason?: string },
) {
  return {
    run: { id, label, targetAgent: "codex", status },
    changedFiles,
    tests: [{ status: "passed" }],
    verify: [],
    pathPolicy: { status: "passed" },
    ...(applyCheck ? { applyCheck } : {}),
    artifacts: { reportPath: `/runs/${id}/report.md`, diffPath: `/runs/${id}/diff.patch` },
  };
}

function mockGroup() {
  return {
    run: { id: "run_group", role: "group", mode: "split", status: "partial", task: "do a thing" },
    artifacts: { reportPath: "/runs/run_group/report.md" },
    result: {
      childResults: [
        childResult("run_a", "cli", "ready", ["src/delegate.ts", "docs/cli.md"], { applies: true }),
        childResult("run_b", "logs", "failed", ["src/delegate.ts"], {
          applies: false,
          reason: "error: patch failed: src/delegate.ts:42",
        }),
      ],
    },
  };
}

test("review aggregates children, flags overlap, and emits per-child actions", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];

  globalThis.fetch = async () =>
    new Response(JSON.stringify(mockGroup()), { status: 200, headers: { "Content-Type": "application/json" } });
  console.log = (msg?: unknown) => output.push(String(msg ?? ""));

  try {
    const code = await reviewCommand(["run_group", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    const text = output.join("\n");
    assert.match(text, /run_a \[cli\]  ready/);
    assert.match(text, /run_b \[logs\]  failed/);
    assert.match(text, /portico apply run_group --child run_a/);
    assert.match(text, /portico delegate --resume run_b/);
    // src/delegate.ts is changed by both children → overlap section lists it.
    assert.match(text, /Overlapping files/);
    assert.match(text, /src\/delegate\.ts: cli, logs/);
    assert.doesNotMatch(text, /docs\/cli\.md: /); // only changed by one child, not overlap
    // applyCheck is shown alongside overlap: one child applies to base, one doesn't.
    assert.match(text, /apply ok/);
    assert.match(text, /apply FAILS/);
    assert.match(text, /apply-check: does not apply to group base — error: patch failed: src\/delegate\.ts:42/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("review groups no-change children separately and shows per-child decision", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];

  const group = {
    run: { id: "run_group", role: "group", mode: "compare", status: "ready", task: "do a thing" },
    artifacts: { reportPath: "/runs/run_group/report.md" },
    result: {
      childResults: [
        { ...childResult("run_x", "real", "ready", ["src/a.ts"], { applies: true }), reviewDecision: "approve" },
        { ...childResult("run_y", "empty", "ready", []), reviewDecision: "needs_attention" },
      ],
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify(group), { status: 200, headers: { "Content-Type": "application/json" } });
  console.log = (msg?: unknown) => output.push(String(msg ?? ""));

  try {
    const code = await reviewCommand(["run_group", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    const text = output.join("\n");
    // The no-change ready child is tagged inline and called out in its own group.
    assert.match(text, /run_y \[empty\]  ready  decision=needs_attention  agent=codex  ⚠ no file changes/);
    assert.match(text, /No-change \(ready, but produced no file changes[^)]*\): empty/);
    // The summary counts no-change separately from plain ready.
    assert.match(text, /1 no-change/);
    // The real child shows its approve decision.
    assert.match(text, /run_x \[real\]  ready  decision=approve/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("review --ready-only shows only ready children", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];

  globalThis.fetch = async () =>
    new Response(JSON.stringify(mockGroup()), { status: 200, headers: { "Content-Type": "application/json" } });
  console.log = (msg?: unknown) => output.push(String(msg ?? ""));

  try {
    const code = await reviewCommand(["run_group", "--ready-only", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    const text = output.join("\n");
    assert.match(text, /run_a \[cli\]/);
    assert.doesNotMatch(text, /run_b \[logs\]/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("review --json emits structured aggregation with overlap", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let captured = "";

  globalThis.fetch = async () =>
    new Response(JSON.stringify(mockGroup()), { status: 200, headers: { "Content-Type": "application/json" } });
  console.log = (msg?: unknown) => (captured = String(msg ?? ""));

  try {
    const code = await reviewCommand(["run_group", "--json", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(captured) as {
      children: Array<{ id: string; applyCheck?: { applies: boolean; reason?: string } }>;
      overlap: Array<{ file: string; children: string[] }>;
    };
    assert.equal(parsed.children.length, 2);
    assert.equal(parsed.overlap[0]?.file, "src/delegate.ts");
    assert.equal(parsed.children.find((c) => c.id === "run_a")?.applyCheck?.applies, true);
    assert.equal(parsed.children.find((c) => c.id === "run_b")?.applyCheck?.applies, false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("computeOverlap computes files changed by more than one run", () => {
  const children = [
    { id: "r1", label: "l1", changedFiles: ["a", "b"] },
    { id: "r2", label: "l2", changedFiles: ["b", "c"] },
    { id: "r3", changedFiles: ["a", "c", "d"] },
  ];
  assert.deepEqual(computeOverlap(children), [
    { file: "a", children: ["l1", "r3"] },
    { file: "b", children: ["l1", "l2"] },
    { file: "c", children: ["l2", "r3"] },
  ]);
});
