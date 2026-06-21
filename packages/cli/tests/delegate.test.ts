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

test("delegate --review-summary prints an apply command and risk summary", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output: string[] = [];

  globalThis.fetch = async (input: string | URL | Request) => {
    const urlStr = String(input);
    // First call: the /delegate stream. Second: GET /runs/<id> for the summary.
    if (urlStr.includes("/delegate")) {
      return new Response(
        `${JSON.stringify({ type: "run_done", runId: "run_1", status: "ready", reportPath: "r.md", resultPath: "x.json" })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    return new Response(
      JSON.stringify({
        run: { id: "run_1", role: "single", status: "ready", task: "t" },
        artifacts: { reportPath: "r.md" },
        result: {
          tests: [{ status: "passed" }],
          verify: [{ status: "passed" }],
          pathPolicy: { status: "passed", allowed: [], forbidden: [], notAllowed: [] },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  console.log = (msg?: unknown) => output.push(String(msg ?? ""));

  try {
    const code = await delegateCommand([
      "--to",
      "agent",
      "--task",
      "do it",
      "--review-summary",
      "--url",
      "http://127.0.0.1:1",
    ]);
    assert.equal(code, 0);
    const text = output.join("\n");
    assert.match(text, /Review summary/);
    assert.match(text, /path policy: passed/);
    assert.match(text, /tests: 1\/1 passed/);
    assert.match(text, /apply: portico apply run_1/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
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

test("delegate prints a preflight echo with the resolved absolute repo before launching", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  let errOut = "";
  console.error = (msg?: unknown) => {
    errOut += String(msg ?? "") + "\n";
  };
  console.log = () => {};
  globalThis.fetch = async () =>
    new Response(
      `${JSON.stringify({ type: "run_done", runId: "run_1", status: "ready", reportPath: "report.md", resultPath: "result.json" })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  try {
    const code = await delegateCommand(["--to", "agent", "--task", "x", "--repo", ".", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    assert.match(errOut, /preflight:/);
    // A relative `--repo .` is echoed as an absolute path — the wrong-repo guard.
    assert.ok(errOut.includes(`repo:`) && errOut.includes(process.cwd()));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("delegate preflight lists every fan-out child with its agent", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  let errOut = "";
  console.error = (msg?: unknown) => {
    errOut += String(msg ?? "") + "\n";
  };
  console.log = () => {};
  globalThis.fetch = async () =>
    new Response(
      `${JSON.stringify({ type: "run_done", runId: "g_1", status: "ready", reportPath: "report.md", resultPath: "result.json" })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  try {
    const code = await delegateCommand([
      "--to", "codex", "--task", "split it", "--mode", "split", "--url", "http://127.0.0.1:1",
      "--child", JSON.stringify({ to: "codex", task: "backend", label: "be" }),
      "--child", JSON.stringify({ to: "claude", task: "frontend", label: "fe" }),
    ]);
    assert.equal(code, 0);
    assert.match(errOut, /agents \(2\)/);
    assert.match(errOut, /be: codex/);
    assert.match(errOut, /fe: claude/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
});
