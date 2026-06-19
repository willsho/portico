import { test } from "node:test";
import assert from "node:assert/strict";
import { logsCommand } from "../src/commands/runs.ts";

test("logs --follow prints only new events between polls", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let calls = 0;
  const output: string[] = [];

  const started = { type: "run_start", runId: "run_1", status: "running" };
  const agent = { type: "agent_start", runId: "run_1", agent: "codex" };
  const done = { type: "run_done", runId: "run_1", status: "ready", reportPath: "report.md", resultPath: "result.json" };

  globalThis.fetch = async () => {
    calls++;
    const events = calls === 1 ? [started, agent] : [started, agent, done];
    return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
  console.log = (msg?: unknown) => {
    output.push(String(msg ?? ""));
  };

  try {
    const code = await logsCommand(["run_1", "--follow", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    assert.equal(calls, 2);
    assert.deepEqual(output, [
      "[run_1] started",
      "[run_1] agent codex started",
      "[run_1] ready",
      "report: report.md",
      "next: portico apply run_1 | portico discard run_1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
