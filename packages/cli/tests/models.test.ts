import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsCommand } from "../src/commands/models.ts";

// Claude is a built-in provider with a static catalog; point discovery at a real binary
// so it resolves as available and surfaces its models.
process.env.PORTICO_CLAUDE_PATH = process.execPath;

test("models command --json emits the agents/models shape", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (msg?: unknown) => {
    output += String(msg ?? "") + "\n";
  };

  try {
    const code = await modelsCommand(["--to", "claude", "--json"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(output) as {
      agents: Array<{ provider: string; modelSelection?: string; models: Array<{ id: string }> }>;
    };
    const claude = parsed.agents.find((a) => a.provider === "claude");
    assert.ok(claude, "claude listed");
    assert.equal(claude!.modelSelection, "supported");
    assert.ok(claude!.models.some((m) => m.id === "claude-sonnet-4-6"), "static catalog surfaced");
  } finally {
    console.log = originalLog;
  }
});

test("models command errors for an unknown --to agent", async () => {
  const originalError = console.error;
  let err = "";
  console.error = (msg?: unknown) => {
    err += String(msg ?? "") + "\n";
  };
  try {
    const code = await modelsCommand(["--to", "nonexistent-agent-xyz", "--json"]);
    assert.equal(code, 1);
    assert.match(err, /not found or not available/);
  } finally {
    console.error = originalError;
  }
});
