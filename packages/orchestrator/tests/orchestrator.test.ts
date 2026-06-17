import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";
import { createDelegationOrchestrator } from "../src/index.ts";
import type { AgentEntry } from "@portico/core";
import type { DelegationEvent } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EDIT_AGENT = join(here, "../../../test/fixtures/edit-agent.mjs");

test("delegation creates a worktree, artifacts, diff and report", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", testCommands: ["test -f delegated.txt"] },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    assert.equal(done?.type === "run_done" ? done.status : "", "ready");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "ready");
    assert.ok(details.result?.changedFiles.includes("delegated.txt"));
    assert.match(await readFile(details.artifacts.diffPath as string, "utf8"), /delegated.txt/);
    assert.match(await readFile(details.artifacts.reportPath, "utf8"), /Portico Run Report/);

    const applied = await orchestrator.apply(repo, runId);
    assert.equal(applied.run.status, "applied");
    assert.match(await readFile(join(repo, "delegated.txt"), "utf8"), /created by edit-agent/);

    const discarded = await orchestrator.discard(repo, runId);
    assert.equal(discarded.run.status, "discarded");
    await assert.rejects(() => stat(details.run.worktreePath));
    // The worktree must be deregistered from git, not just deleted from disk.
    const worktrees = await capture("git", ["-C", repo, "worktree", "list"]);
    assert.doesNotMatch(worktrees.stdout, /run_/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review mode is rejected as unsupported", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("claude", EDIT_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "claude", repo, task: "review the diff", mode: "review" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const last = events.at(-1);
    assert.equal(last?.type, "run_error");
    assert.equal(last?.type === "run_error" ? last.code : "", "mode_unsupported");
    // Rejected before any run was created, so nothing landed on disk.
    assert.deepEqual(await orchestrator.listRuns(repo), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "portico-delegate-"));
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "# test\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "init");
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await capture("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

function agentEntry(provider: string, path: string): AgentEntry {
  return {
    provider,
    displayName: provider,
    available: true,
    path,
    version: "1.0.0",
    protocols: ["generic-cli"],
    source: "config",
  };
}
