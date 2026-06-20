import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCommand } from "../src/commands/review.ts";

function childResult(id: string, label: string, status: string, changedFiles: string[]) {
  return {
    run: { id, label, targetAgent: "codex", status },
    changedFiles,
    tests: [{ status: "passed" }],
    verify: [],
    pathPolicy: { status: "passed" },
    artifacts: { reportPath: `/runs/${id}/report.md`, diffPath: `/runs/${id}/diff.patch` },
  };
}

function mockGroup() {
  return {
    run: { id: "run_group", role: "group", mode: "split", status: "partial", task: "do a thing" },
    artifacts: { reportPath: "/runs/run_group/report.md" },
    result: {
      childResults: [
        childResult("run_a", "cli", "ready", ["src/delegate.ts", "docs/cli.md"]),
        childResult("run_b", "logs", "failed", ["src/delegate.ts"]),
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
      children: unknown[];
      overlap: Array<{ file: string; children: string[] }>;
    };
    assert.equal(parsed.children.length, 2);
    assert.equal(parsed.overlap[0]?.file, "src/delegate.ts");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
