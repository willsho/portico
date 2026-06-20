import { test } from "node:test";
import assert from "node:assert/strict";
import { watchCommand } from "../src/commands/watch.ts";

const RUNS = {
  runs: [
    {
      id: "run_a",
      status: "ready",
      name: "dark-mode",
      task: "add dark mode",
      targetAgent: "codex",
      mode: "implement",
      role: "single",
      updatedAt: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-06-20T00:00:00.000Z",
    },
    {
      id: "run_g",
      status: "partial",
      name: "fan-out",
      task: "split work",
      targetAgent: "codex,claude",
      mode: "split",
      role: "group",
      updatedAt: "2026-06-20T00:00:00.000Z",
      createdAt: "2026-06-20T00:00:00.000Z",
      _children: [{ id: "c1", status: "ready", task: "backend", targetAgent: "codex", updatedAt: "x", createdAt: "x" }],
    },
  ],
};

function withMockFetch(body: unknown, run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("watch --once prints an ANSI-free snapshot grouped by state", async () => {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (msg?: unknown) => out.push(String(msg ?? ""));
  try {
    await withMockFetch(RUNS, async () => {
      const code = await watchCommand(["--once", "--url", "http://127.0.0.1:1"]);
      assert.equal(code, 0);
    });
    const text = out.join("\n");
    assert.doesNotMatch(text, /\x1b\[/);
    assert.match(text, /Needs decision/);
    assert.match(text, /dark-mode/);
    assert.match(text, /split 1\/1 ready/);
  } finally {
    console.log = originalLog;
  }
});

test("watch --json prints the raw runs body once", async () => {
  let captured = "";
  const originalLog = console.log;
  console.log = (msg?: unknown) => (captured = String(msg ?? ""));
  try {
    await withMockFetch(RUNS, async () => {
      const code = await watchCommand(["--json", "--url", "http://127.0.0.1:1"]);
      assert.equal(code, 0);
    });
    const parsed = JSON.parse(captured) as typeof RUNS;
    assert.equal(parsed.runs.length, 2);
    assert.equal(parsed.runs[0]?.name, "dark-mode");
  } finally {
    console.log = originalLog;
  }
});

test("watch --to filters runs by target agent (keeping groups with a matching child)", async () => {
  const out: string[] = [];
  const originalLog = console.log;
  console.log = (msg?: unknown) => out.push(String(msg ?? ""));
  try {
    await withMockFetch(RUNS, async () => {
      await watchCommand(["--once", "--to", "claude", "--url", "http://127.0.0.1:1"]);
    });
    const text = out.join("\n");
    // run_a targets only codex → dropped; run_g has a claude target → kept.
    assert.doesNotMatch(text, /dark-mode/);
    assert.match(text, /fan-out/);
  } finally {
    console.log = originalLog;
  }
});
