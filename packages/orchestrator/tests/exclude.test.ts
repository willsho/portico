import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPorticoExclude } from "../src/orchestrator.ts";

test("applyPorticoExclude writes the granular block on an empty exclude file", () => {
  const out = applyPorticoExclude("");
  assert.equal(out, "/.portico/*\n!/.portico/agents/\n");
});

test("applyPorticoExclude is idempotent once the granular block is present", () => {
  const out = applyPorticoExclude("");
  assert.ok(out);
  assert.equal(applyPorticoExclude(out), null);
});

test("applyPorticoExclude migrates the legacy blanket and preserves user lines", () => {
  const out = applyPorticoExclude("node_modules/\n/.portico/\n*.log\n");
  assert.ok(out);
  // Legacy blanket dropped so the agents re-include can take effect.
  assert.ok(!out.split("\n").includes("/.portico/"));
  // Unrelated user entries preserved.
  assert.match(out, /node_modules\//);
  assert.match(out, /\*\.log/);
  // Granular block appended last (order matters: ignore then re-include).
  assert.ok(out.endsWith("/.portico/*\n!/.portico/agents/\n"));
});
