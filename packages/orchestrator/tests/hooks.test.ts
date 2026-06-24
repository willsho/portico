import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeHooks, readHooksConfig, runGateHooks } from "../src/hooks.ts";
import type { HookEvent, HookPayload } from "../src/hooks.ts";

const payload = (event: HookEvent): HookPayload => ({
  event,
  runId: "r1",
  repo: "/repo",
  worktree: "/wt",
  mode: "implement",
  targetAgent: "codex",
});

test("normalizeHooks keeps valid specs and drops malformed entries and unknown events", () => {
  const hooks = normalizeHooks({
    preApply: [{ command: "echo ok" }, { command: "" }, { notCommand: 1 }, "nope", { command: "x", timeoutMs: 5000 }],
    preLaunch: [{ command: "setup.sh" }],
    bogusEvent: [{ command: "ignored" }],
  });
  assert.deepEqual(hooks.preApply, [{ command: "echo ok" }, { command: "x", timeoutMs: 5000 }]);
  assert.deepEqual(hooks.preLaunch, [{ command: "setup.sh" }]);
  assert.equal((hooks as Record<string, unknown>).bogusEvent, undefined);
});

test("normalizeHooks returns empty for non-object input", () => {
  assert.deepEqual(normalizeHooks(null), {});
  assert.deepEqual(normalizeHooks("nope"), {});
  assert.deepEqual(normalizeHooks(undefined), {});
});

test("runGateHooks passes when every hook exits zero", async () => {
  const res = await runGateHooks({ preApply: [{ command: "exit 0" }] }, payload("preApply"), tmpdir());
  assert.equal(res.blocked, false);
});

test("runGateHooks blocks on the first non-zero exit and surfaces the hook's stderr", async () => {
  const res = await runGateHooks(
    { preApply: [{ command: "echo nope 1>&2; exit 2" }, { command: "exit 0" }] },
    payload("preApply"),
    tmpdir(),
  );
  assert.equal(res.blocked, true);
  assert.match(res.reason ?? "", /preApply hook blocked \(exit 2\)/);
  assert.match(res.reason ?? "", /nope/);
});

test("runGateHooks passes through when no hooks are configured for the event", async () => {
  const res = await runGateHooks({ preApply: [{ command: "exit 1" }] }, payload("preLaunch"), tmpdir());
  assert.equal(res.blocked, false);
});

test("runGateHooks delivers the event payload to the hook on stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-hook-"));
  try {
    const out = join(dir, "stdin.json");
    const res = await runGateHooks({ preApply: [{ command: `cat > ${out}` }] }, payload("preApply"), dir);
    assert.equal(res.blocked, false);
    const received = JSON.parse(await readFile(out, "utf8"));
    assert.equal(received.event, "preApply");
    assert.equal(received.runId, "r1");
    assert.equal(received.targetAgent, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runGateHooks blocks fail-closed when a hook exceeds its timeout", async () => {
  const res = await runGateHooks(
    { preApply: [{ command: "sleep 5", timeoutMs: 100 }] },
    payload("preApply"),
    tmpdir(),
  );
  assert.equal(res.blocked, true);
  assert.match(res.reason ?? "", /timed out/);
});

test("readHooksConfig reads and normalizes the hooks block from .portico/config.json", async () => {
  const repo = await mkdtemp(join(tmpdir(), "portico-hookcfg-"));
  try {
    await mkdir(join(repo, ".portico"), { recursive: true });
    await writeFile(
      join(repo, ".portico", "config.json"),
      JSON.stringify({ testCommands: [], hooks: { preApply: [{ command: "scan.sh" }] } }),
    );
    const hooks = await readHooksConfig(repo);
    assert.deepEqual(hooks.preApply, [{ command: "scan.sh" }]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("readHooksConfig returns empty when the config is missing or has no hooks", async () => {
  const repo = await mkdtemp(join(tmpdir(), "portico-hookcfg-"));
  try {
    assert.deepEqual(await readHooksConfig(repo), {});
    await mkdir(join(repo, ".portico"), { recursive: true });
    await writeFile(join(repo, ".portico", "config.json"), JSON.stringify({ testCommands: [] }));
    assert.deepEqual(await readHooksConfig(repo), {});
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
