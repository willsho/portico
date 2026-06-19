import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegateCommand } from "../src/commands/delegate.ts";

async function captureError(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const originalError = console.error;
  let output = "";
  console.error = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };
  try {
    return { code: await fn(), output };
  } finally {
    console.error = originalError;
  }
}

test("delegate command requires exactly one of --task and --task-file", async () => {
  let result = await captureError(() => delegateCommand(["--to", "agent"]));
  assert.equal(result.code, 1);
  assert.match(result.output, /--task <task> \| --task-file <path>/);

  result = await captureError(() => delegateCommand(["--to", "agent", "--task", "foo", "--task-file", "bar.txt"]));
  assert.equal(result.code, 1);
  assert.match(result.output, /--task <task> \| --task-file <path>/);
});

test("delegate command rejects empty task file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-task-file-"));
  const taskPath = join(dir, "task.txt");
  await writeFile(taskPath, "");
  try {
    const result = await captureError(() => delegateCommand(["--to", "agent", "--task-file", taskPath]));
    assert.equal(result.code, 1);
    assert.match(result.output, /task is empty/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delegate command reads task file contents into delegate request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-task-file-"));
  const taskPath = join(dir, "task.txt");
  await writeFile(taskPath, "Do the thing\nKeep the newline.\n");

  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let body = "";
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(
      `${JSON.stringify({ type: "run_done", runId: "run_1", status: "ready", reportPath: "report.md", resultPath: "result.json" })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  };
  console.log = () => {};

  try {
    const code = await delegateCommand(["--to", "agent", "--task-file", taskPath, "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(body).task, "Do the thing\nKeep the newline.\n");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});
