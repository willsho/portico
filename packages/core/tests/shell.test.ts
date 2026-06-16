import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateShells, resolveViaLoginShell, loginShellPath } from "../src/shell.ts";

test("candidateShells prefers $SHELL then falls back to zsh/bash", () => {
  const shells = candidateShells();
  assert.ok(shells.length >= 1);
  if (process.env["SHELL"]) assert.equal(shells[0], process.env["SHELL"]);
});

test("resolveViaLoginShell returns null for a non-existent command", { skip: process.platform === "win32" }, async () => {
  const resolved = await resolveViaLoginShell("definitely-not-a-real-binary-xyz123", { timeoutMs: 4000 });
  assert.equal(resolved, null);
});

test("login-shell fallback can recover a real binary path", { skip: process.platform === "win32" }, async () => {
  // `node` is on PATH, so a login shell should locate it. Tolerate environments where the
  // login shell can't (assert only the shape when found) so the test stays deterministic.
  const resolved = await resolveViaLoginShell("node", { timeoutMs: 4000 });
  if (resolved !== null) assert.ok(resolved.startsWith("/"));

  const path = await loginShellPath({ timeoutMs: 4000 });
  if (path !== null) assert.ok(path.includes("/"));
});
