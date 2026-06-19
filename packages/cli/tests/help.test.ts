import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsCommand } from "../src/commands/agents.ts";
import { delegateCommand } from "../src/commands/delegate.ts";
import { logsCommand } from "../src/commands/runs.ts";

async function captureLog(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const originalLog = console.log;
  let output = "";
  console.log = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };
  try {
    return { code: await fn(), output };
  } finally {
    console.log = originalLog;
  }
}

test("delegate command handles --help before task validation", async () => {
  const { code, output } = await captureLog(() => delegateCommand(["--help"]));
  assert.equal(code, 0);
  assert.match(output, /Usage: portico delegate/);
  assert.match(output, /--task-file/);
  assert.match(output, /--cleanup/);
  assert.match(output, /--timeout/);
  assert.match(output, /--allowed/);
  assert.match(output, /--forbidden/);
  assert.match(output, /--resume/);
  assert.match(output, /--json/);
  assert.match(output, /--url/);
  assert.match(output, /--token/);
});

test("delegate command still throws on unknown options", async () => {
  await assert.rejects(() => delegateCommand(["--unknown"]), /Unknown option '--unknown'/);
});

test("simple commands handle help", async () => {
  const agents = await captureLog(() => agentsCommand(["-h"]));
  assert.equal(agents.code, 0);
  assert.match(agents.output, /Usage: portico agents/);

  const logs = await captureLog(() => logsCommand(["--help"]));
  assert.equal(logs.code, 0);
  assert.match(logs.output, /Usage: portico logs/);
  assert.match(logs.output, /--follow/);
});
