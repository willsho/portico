import { test } from "node:test";
import assert from "node:assert/strict";
import { resultCommand } from "../src/commands/result.ts";

async function captureOutput(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (msg?: unknown) => {
    stdout += String(msg ?? "") + "\n";
  };
  console.error = (msg?: unknown) => {
    stderr += String(msg ?? "") + "\n";
  };
  try {
    return { code: await fn(), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("result command --json output is valid JSON and contains all required keys", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(
      JSON.stringify({
        run: {
          id: "run_123",
          status: "ready",
          role: "single",
        },
        result: {
          reviewDecision: "approve",
          changedFiles: ["src/index.ts"],
          tests: [{ name: "t1", status: "passed" }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const { code, stdout, stderr } = await captureOutput(() =>
      resultCommand(["run_123", "--json", "--url", "http://127.0.0.1:1"])
    );
    assert.equal(code, 0);
    assert.equal(fetchCalled, true);
    assert.equal(stderr, "");
    
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.id, "run_123");
    assert.equal(parsed.status, "ready");
    assert.equal(parsed.role, "single");
    assert.equal(parsed.verdict.readiness, "ready");
    assert.deepEqual(parsed.verdict.topRisks, ["tests: 1/1 passed"]);
    assert.equal(parsed.next, "apply: portico apply run_123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result command default output includes run id status and next action line", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(
      JSON.stringify({
        run: {
          id: "run_123",
          status: "ready",
          role: "single",
        },
        result: {
          reviewDecision: "approve",
          changedFiles: ["src/index.ts"],
          tests: [{ name: "t1", status: "passed" }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const { code, stdout, stderr } = await captureOutput(() =>
      resultCommand(["run_123", "--url", "http://127.0.0.1:1"])
    );
    assert.equal(code, 0);
    assert.equal(fetchCalled, true);
    assert.equal(stderr, "");
    assert.match(stdout, /run run_123: ready/);
    assert.match(stdout, /^next: apply: portico apply run_123/m);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result command --help / -h prints usage and returns 0 without calling fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  try {
    const helpOptions = ["--help", "-h"];
    for (const opt of helpOptions) {
      const { code, stdout, stderr } = await captureOutput(() =>
        resultCommand([opt])
      );
      assert.equal(code, 0);
      assert.equal(stderr, "");
      assert.match(stdout, /Usage: portico result/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result command with role: group produces group parent warning in default output", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(
      JSON.stringify({
        run: {
          id: "run_123",
          status: "ready",
          role: "group",
        },
        result: {
          reviewDecision: "approve",
          changedFiles: ["src/index.ts"],
          tests: [{ name: "t1", status: "passed" }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const { code, stdout, stderr } = await captureOutput(() =>
      resultCommand(["run_123", "--url", "http://127.0.0.1:1"])
    );
    assert.equal(code, 0);
    assert.equal(fetchCalled, true);
    assert.equal(stderr, "");
    assert.match(stdout, /run run_123: ready/);
    assert.match(stdout, /^next: apply: portico apply run_123 --all/m);
    assert.match(stdout, /this is a group parent; children should be reviewed via portico review run_123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result command missing run_id returns exit code 1 with Usage on stderr", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fetch should not be called");
  };

  try {
    const { code, stdout, stderr } = await captureOutput(() =>
      resultCommand([])
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /Usage: portico result <run_id>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result command daemon unreachable case returns exit code 1 with permission denied on stderr", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error("fetch failed");
    (err as Error & { cause?: NodeJS.ErrnoException }).cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
    throw err;
  };

  try {
    const { code, stdout, stderr } = await captureOutput(() =>
      resultCommand(["run_123", "--url", "http://127.0.0.1:1"])
    );
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /permission denied/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
