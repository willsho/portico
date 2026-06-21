import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsCommand } from "../src/commands/agents.ts";

test("agents command accepts --url and --token and prints local agents", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };
  
  try {
    const code = await agentsCommand(["--url", "http://127.0.0.1:8787", "--token", "foo"]);
    assert.equal(code, 0);
    assert.match(output, /Locally-installed agents/);
    assert.match(output, /Provider/);
  } finally {
    console.log = originalLog;
  }
});
