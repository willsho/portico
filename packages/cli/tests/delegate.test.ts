import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIterateSection, delegateCommand, parseCoverageManifest, printEvent } from "../src/commands/delegate.ts";
import { registerProvider } from "@portico/core";
import { buildContextSections } from "../src/commands/context-pack.ts";
import type { RunDetails } from "@portico/orchestrator";

registerProvider({
  id: "agent",
  displayName: "Agent",
  commandNames: ["nonexistent-command-name-here-12345"],
  envPathNames: ["PORTICO_AGENT_PATH"],
  protocols: ["generic-cli"],
});
process.env.PORTICO_AGENT_PATH = process.execPath;
process.env.PORTICO_CODEX_PATH = process.execPath;
process.env.PORTICO_CLAUDE_PATH = process.execPath;


function capturePrintEvent(fn: () => void): string {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  let output = "";
  console.log = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };
  console.error = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk ?? "");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
    return output;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

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

function iterateRunDetails(overrides: {
  tests?: Array<{ command: string; status: "passed" | "failed"; exitCode: number | null; output: string }>;
  verify?: Array<{ command: string; status: "passed" | "failed"; exitCode: number | null; output: string }>;
  changedFiles?: string[];
} = {}): RunDetails {
  const run = {
    id: "run_previous",
    repoPath: "/repo",
    worktreePath: "/repo/.portico/worktrees/run_previous",
    branchName: "portico/run_previous",
    rootAgent: "codex",
    targetAgent: "codex",
    task: "previous task",
    mode: "implement" as const,
    isolation: { workspace: "worktree" as const },
    permissionProfile: "auto-edit" as const,
    status: "failed" as const,
    depth: 0,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
  const artifacts = {
    runId: "run_previous",
    taskPath: "task.md",
    eventsPath: "events.ndjson",
    agentLogPath: "agent.log",
    reportPath: "report.md",
    resultPath: "result.json",
  };
  return {
    run,
    artifacts,
    result: {
      run,
      artifacts,
      changedFiles: overrides.changedFiles ?? [],
      tests: overrides.tests ?? [],
      verify: overrides.verify,
      agentEvents: [],
    },
  };
}

test("printEvent renders verdict_update as an in-progress Portico signal", () => {
  const verdict = {
    status: "running" as const,
    readiness: "not_ready" as const,
    changedFiles: ["delegated.txt"],
    tests: { total: 0, passed: 0, failed: 0 },
    verify: { total: 0, passed: 0, failed: 0 },
    sandboxEscaped: false,
    topRisks: ["path policy: passed"],
  };
  const verdictOutput = capturePrintEvent(() => {
    printEvent({ type: "verdict_update", runId: "run_verdict", verdict });
  });
  const doneOutput = capturePrintEvent(() => {
    printEvent({
      type: "run_done",
      runId: "run_verdict",
      status: "ready",
      reportPath: "report.md",
      resultPath: "result.json",
      verdict: { ...verdict, status: "ready", readiness: "ready" },
    });
  });

  assert.match(verdictOutput, /\[run_verdict\] verdict \(Portico, in progress\): path policy: passed/);
  assert.doesNotMatch(doneOutput, /Portico, in progress/);
});

test("printEvent labels agent narration once per run before the first delta", () => {
  const output = capturePrintEvent(() => {
    printEvent({ type: "agent_event", runId: "run_narration_once", event: { type: "content", delta: "first " } });
    printEvent({ type: "agent_event", runId: "run_narration_once", event: { type: "content", delta: "second" } });
  });

  const banner = "[run_narration_once] agent narration (unverified, not Portico's verdict):";
  assert.equal(output.split(banner).length - 1, 1);
  assert.ok(output.indexOf(banner) < output.indexOf("first "));
  assert.equal(output.endsWith("first second"), true);
});

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

test("delegate command threads --model / --effort into the delegate request", async () => {
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
    const code = await delegateCommand([
      "--to", "agent", "--task", "x",
      "--model", "claude-opus-4-8", "--effort", "high",
      "--url", "http://127.0.0.1:1",
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "claude-opus-4-8");
    assert.equal(parsed.effort, "high");

    // Omitted → absent, so the daemon/agent falls back to its own default.
    await delegateCommand(["--to", "agent", "--task", "x", "--url", "http://127.0.0.1:1"]);
    const bare = JSON.parse(body);
    assert.equal(bare.model, undefined);
    assert.equal(bare.effort, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
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
    let code = await delegateCommand(["--to", "agent", "--task", "x", "--repo", ".", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    assert.match(errOut, /preflight:/);
    // A relative `--repo .` is echoed as an absolute path — the wrong-repo guard.
    assert.ok(errOut.includes(`repo:`) && errOut.includes(process.cwd()));
    assert.match(errOut, /timeout:\s+daemon default/);

    errOut = "";
    code = await delegateCommand(["--to", "agent", "--task", "x", "--timeout", "5000", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 0);
    assert.match(errOut, /timeout:\s+5000ms/);
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

test("delegate returns 3 when the stream drops mid-run but the run has a runId", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  globalThis.fetch = async () => new Response(
    `${JSON.stringify({ type: "run_start", runId: "r1" })}\n${JSON.stringify({ type: "agent_start", runId: "r1", agent: "foo" })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
  );

  try {
    const code = await delegateCommand(["--to", "agent", "--task", "x", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 3);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

test("delegate returns 1 on run_error", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  globalThis.fetch = async () => new Response(
    `${JSON.stringify({ type: "run_error", runId: "r1", error: "boom", code: "failed" })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
  );

  try {
    const code = await delegateCommand(["--to", "agent", "--task", "x", "--url", "http://127.0.0.1:1"]);
    assert.equal(code, 1);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

test("parseCoverageManifest extracts string paths from varied manifest shapes", () => {
  assert.deepEqual(parseCoverageManifest('{"expectedChange": ["a.ts", "b.ts"]}'), ["a.ts", "b.ts"]);
  assert.deepEqual(parseCoverageManifest('{"expectedChangePaths": ["c.ts"]}'), ["c.ts"]);
  assert.deepEqual(parseCoverageManifest('["d.ts", "e.ts"]'), ["d.ts", "e.ts"]);
  assert.deepEqual(parseCoverageManifest('["f.ts", 123, null, "g.ts"]'), ["f.ts", "g.ts"]);
  assert.deepEqual(parseCoverageManifest('{}'), []);
  assert.deepEqual(parseCoverageManifest('{"other": ["a.ts"]}'), []);
  assert.deepEqual(parseCoverageManifest('invalid json'), []);
});

test("buildIterateSection summarizes failed checks and changed files", async () => {
  const section = await buildIterateSection(iterateRunDetails({
    tests: [{ command: "npm test", status: "failed", exitCode: 1, output: "line one\nfinal error" }],
    changedFiles: ["packages/cli/src/commands/delegate.ts", "packages/cli/tests/delegate.test.ts"],
  }));

  assert.match(section, /### Previous attempt: run_previous \(failed\)/);
  assert.match(section, /tests: 0\/1 passed/);
  assert.match(section, /Failing checks:/);
  assert.match(section, /npm test \(exit 1\): line one\nfinal error/);
  assert.match(section, /Changed files in that attempt: packages\/cli\/src\/commands\/delegate\.ts, packages\/cli\/tests\/delegate\.test\.ts/);
});

test("buildIterateSection omits failing checks block when there are no failures", async () => {
  const section = await buildIterateSection(iterateRunDetails({
    tests: [{ command: "npm test", status: "passed", exitCode: 0, output: "ok" }],
    changedFiles: [],
  }));

  assert.doesNotMatch(section, /Failing checks:/);
  assert.match(section, /Changed files in that attempt: none/);
});

test("buildIterateSection truncates long summaries with an omitted-count marker", async () => {
  const output = `${"a".repeat(2500)}LAST_ERROR`;
  const section = await buildIterateSection(iterateRunDetails({
    tests: [{ command: "npm test", status: "failed", exitCode: 1, output }],
    changedFiles: ["src/a.ts"],
  }), 500);

  assert.match(section, /\[\.\.\. \d+ earlier characters omitted \.\.\.\]/);
  assert.match(section, /\[\.\.\. summary truncated, \d+ more characters omitted \.\.\.\]/);
});

test("delegateCommand with --iterate-from splices previous run summary into delegate request", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const calls: string[] = [];
  let delegateBody = "";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/runs/run_previous")) {
      return new Response(JSON.stringify(iterateRunDetails({
        tests: [{ command: "npm test", status: "failed", exitCode: 1, output: "expected failure" }],
        changedFiles: ["src/fix.ts"],
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/delegate")) {
      delegateBody = String(init?.body ?? "");
      return new Response(
        `${JSON.stringify({ type: "run_done", runId: "run_2", status: "ready", reportPath: "report.md", resultPath: "result.json" })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    assert.fail(`unexpected fetch: ${url}`);
  };
  console.log = () => {};
  console.error = () => {};

  try {
    const code = await delegateCommand([
      "--to", "agent",
      "--task", "Refine packages/cli/src/commands/delegate.ts. Acceptance criteria: npm test passes.",
      "--iterate-from", "run_previous",
      "--url", "http://127.0.0.1:1",
    ]);
    assert.equal(code, 0);
    assert.equal(calls.filter((url) => url.includes("/runs/run_previous")).length, 1);
    assert.equal(calls.filter((url) => url.includes("/delegate")).length, 1);
    const request = JSON.parse(delegateBody);
    assert.match(request.task, /## Context/);
    assert.match(request.task, /### Previous attempt: run_previous \(failed\)/);
    assert.match(request.task, /npm test \(exit 1\): expected failure/);
    assert.match(request.task, /Changed files in that attempt: src\/fix\.ts/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

test("delegateCommand with --continue posts to continue endpoint with resolved repo", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const calls: string[] = [];
  let continueBody = "";

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/runs/run_previous/continue")) {
      continueBody = String(init?.body ?? "");
      return new Response(
        `${JSON.stringify({ type: "run_done", runId: "run_previous", status: "ready", reportPath: "report.md", resultPath: "result.json" })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    assert.fail(`unexpected fetch: ${url}`);
  };
  console.log = () => {};
  console.error = () => {};

  try {
    const code = await delegateCommand([
      "--continue", "run_previous",
      "--task", "Refine the existing worktree. Acceptance criteria: npm test passes.",
      "--repo", ".",
      "--url", "http://127.0.0.1:1",
    ]);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /\/runs\/run_previous\/continue\?repo=/);
    assert.equal(JSON.parse(continueBody).task, "Refine the existing worktree. Acceptance criteria: npm test passes.");
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
});

test("delegateCommand rejects combined continuation modes", async () => {
  const result = await captureError(() => delegateCommand([
    "--continue", "run_previous",
    "--iterate-from", "run_other",
    "--task", "Refine packages/cli/src/commands/delegate.ts. Acceptance criteria: npm test passes.",
  ]));
  assert.equal(result.code, 1);
  assert.match(result.output, /mutually exclusive/);
});

test("delegateCommand with --iterate-from returns 1 on unreachable daemon and does not delegate", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let fetchCount = 0;
  let errOut = "";

  globalThis.fetch = async () => {
    fetchCount += 1;
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  console.error = (msg?: unknown) => {
    errOut += String(msg ?? "") + "\n";
  };

  try {
    const code = await delegateCommand([
      "--to", "agent",
      "--task", "Refine packages/cli/src/commands/delegate.ts. Acceptance criteria: npm test passes.",
      "--iterate-from", "run_previous",
      "--url", "http://127.0.0.1:1",
    ]);
    assert.equal(code, 1);
    assert.equal(fetchCount, 2);
    assert.match(errOut, /daemon not running|daemon is running|fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("delegateCommand with --dry-run prints report and returns code based on heuristics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail("fetch should not be called in dry-run mode");
  };

  const originalLog = console.log;
  let logOut = "";
  console.log = (msg?: unknown) => {
    logOut += String(msg ?? "") + "\n";
  };

  try {
    // 1. Missing all three signals prints all three as failing and returns 1
    const result1 = await delegateCommand([
      "--to", "agent",
      "--task", "clean task with no paths or criteria or tests",
      "--dry-run",
    ]);
    assert.equal(result1, 1);
    assert.match(logOut, /\[✗\] names a concrete file or path/);
    assert.match(logOut, /\[✗\] states acceptance criteria/);
    assert.match(logOut, /\[✗\] specifies a test command/);

    logOut = "";
    // 2. Task with a file path, "acceptance criteria:", and --test passed returns 0
    const result2 = await delegateCommand([
      "--to", "agent",
      "--task", "Please modify packages/cli/src/main.ts. Acceptance criteria: it must work.",
      "--test", "npm run test",
      "--dry-run",
    ]);
    assert.equal(result2, 0);
    assert.match(logOut, /\[✓\] names a concrete file or path/);
    assert.match(logOut, /\[✓\] states acceptance criteria/);
    assert.match(logOut, /\[✓\] specifies a test command/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("delegateCommand agent availability preflight fails when agent is not available", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail("fetch should not be called when preflight availability check fails");
  };

  const originalError = console.error;
  let errOut = "";
  console.error = (msg?: unknown) => {
    errOut += String(msg ?? "") + "\n";
  };

  const origAgentPath = process.env.PORTICO_AGENT_PATH;
  delete process.env.PORTICO_AGENT_PATH;

  try {
    const code = await delegateCommand([
      "--to", "agent",
      "--task", "do something",
      "--url", "http://127.0.0.1:1",
    ]);
    assert.equal(code, 1);
    assert.match(errOut, /agent "agent" is not available/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (origAgentPath !== undefined) {
      process.env.PORTICO_AGENT_PATH = origAgentPath;
    }
  }
});

test("buildContextSections handles file globs, file content, git diff, and character limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-context-"));
  const fileA = join(dir, "a.txt");
  const fileB = join(dir, "b.txt");
  await writeFile(fileA, "hello from a");
  await writeFile(fileB, "hello from b");

  try {
    // 1. One file glob match gets spliced in with the ### Context: <path> header
    const res1 = await buildContextSections(dir, ["*.txt"]);
    assert.match(res1, /### Context: a\.txt/);
    assert.match(res1, /hello from a/);
    assert.match(res1, /### Context: b\.txt/);
    assert.match(res1, /hello from b/);

    // 2. A --context-diff with a bad ref produces a stderr warning but doesn't throw
    const originalError = console.error;
    let errOut = "";
    console.error = (msg?: unknown) => {
      errOut += String(msg ?? "") + "\n";
    };
    try {
      const resDiff = await buildContextSections(dir, [], ["invalid-ref-12345"]);
      assert.equal(resDiff, "");
      assert.match(errOut, /warning: git diff for ref "invalid-ref-12345" failed/);
    } finally {
      console.error = originalError;
    }

    // 3. Combined cap truncates and appends the marker when content exceeds it
    const resCap = await buildContextSections(dir, ["a.txt"], [], 15);
    assert.equal(resCap.length, 15 + "\n[... context truncated, 26 more characters omitted ...]".length);
    assert.match(resCap, /\[\.\.\. context truncated, \d+ more characters omitted \.\.\.\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
