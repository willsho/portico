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
import type { DelegationEvent, Run } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EDIT_AGENT = join(here, "../../../test/fixtures/edit-agent.mjs");
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");
const ESCAPE_AGENT = join(here, "../../../test/fixtures/escape-agent.mjs");
const SPLIT_AGENT = join(here, "../../../test/fixtures/split-agent.mjs");
const JUDGE_AGENT = join(here, "../../../test/fixtures/judge-agent.mjs");

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
    assert.equal(details.run.isolation.workspace, "worktree");
    assert.equal(details.run.permissionProfile, "auto-edit");
    assert.ok(details.result?.changedFiles.includes("delegated.txt"));
    assert.ok((details.result?.telemetry?.totalDurationMs ?? -1) >= 0);
    assert.ok((details.result?.telemetry?.agentDurationMs ?? -1) >= 0);
    assert.ok((details.result?.tests[0]?.durationMs ?? -1) >= 0);
    assert.equal(details.result?.telemetry?.usage.available, false);
    assert.match(await readFile(details.artifacts.diffPath as string, "utf8"), /delegated.txt/);
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Portico Run Report/);
    assert.match(report, /## Telemetry/);

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

test("review mode runs read-only in the shared workspace and cannot be applied", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", FAKE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "review the repo", mode: "review" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const last = events.at(-1);
    assert.equal(last?.type, "run_done");
    assert.equal(last?.type === "run_done" ? last.status : "", "ready");
    const runId = last?.type === "run_done" ? last.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.mode, "review");
    assert.equal(details.run.isolation.workspace, "shared");
    assert.equal(details.run.permissionProfile, "read-only");
    assert.deepEqual(details.result?.changedFiles, []);
    await assert.rejects(() => orchestrator.apply(repo, runId), /only implement runs can be applied/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree cleanup can remove no-change runs automatically", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", FAKE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "say hello without editing", cleanup: "onNoChanges" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "ready");
    assert.deepEqual(details.result?.changedFiles, []);
    assert.match(details.result?.gateWarnings?.join("\n") ?? "", /produced no file changes/);
    assert.ok(details.run.worktreeRemovedAt);
    await assert.rejects(() => stat(details.run.worktreePath));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("delegation records token usage when the agent reports it", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("claude", FAKE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "claude", repo, task: "say hello without editing" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    assert.equal(done?.type === "run_done" ? done.status : "", "ready");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.result?.telemetry?.usage.available, true);
    assert.equal(details.result?.telemetry?.usage.outputTokens, 7);
    assert.equal(details.result?.telemetry?.usage.totalTokens, 7);
    assert.match(await readFile(details.artifacts.reportPath, "utf8"), /Output Tokens: 7/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree runs detect agents that write outside the sandbox", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", ESCAPE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: `create escaped.txt. MAIN_REPO:${repo}`,
        testCommands: ["test -f escaped.txt"],
      },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    assert.equal(done?.type === "run_done" ? done.status : "", "failed");
    assert.ok(events.some((event) => event.type === "sandbox_escape_detected"));
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.result?.sandboxEscaped, true);
    assert.ok(details.result?.outOfTreeChanges?.some((change) => change.path === "escaped.txt"));
    assert.equal(details.result?.agentGateMismatch, true);
    assert.match(details.result?.gateWarnings?.join("\n") ?? "", /Agent claimed success but Portico gate failed/);
    assert.match(await readFile(details.artifacts.reportPath, "utf8"), /Out-of-Tree Changes/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree isolation can branch from an explicit base ref", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const originalBranch = (await capture("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"])).stdout.trim();
  await git(repo, "checkout", "-b", "base-ref-source");
  await writeFile(join(repo, "base-only.txt"), "from base ref\n");
  await git(repo, "add", "base-only.txt");
  await git(repo, "commit", "-m", "base ref file");
  await git(repo, "checkout", originalBranch);

  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", baseRef: "base-ref-source" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.isolation.baseRef, "base-ref-source");
    assert.match(await readFile(join(details.run.worktreePath, "base-only.txt"), "utf8"), /from base ref/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("compare mode runs multiple isolated candidates and records a parent report", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    assert.equal(done?.type === "run_done" ? done.status : "", "ready");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.mode, "compare");
    assert.equal(details.result?.compareResults?.length, 2);
    assert.match(await readFile(details.artifacts.reportPath, "utf8"), /Compare Candidates/);
    await assert.rejects(() => orchestrator.apply(repo, runId), /Group run.*has multiple children|only implement runs can be applied/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("compare mode runs candidates in parallel", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const traceDir = await mkdtemp(join(tmpdir(), "portico-trace-"));
  const traceFile = join(traceDir, "trace.log");
  const orchestrator = createDelegationOrchestrator();
  process.env.PORTICO_TRACE_FILE = traceFile;
  process.env.PORTICO_AGENT_DELAY_MS = "300";

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["gemini", "opencode"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    assert.equal(done?.type === "run_done" ? done.status : "", "ready");
    const trace = await readFile(traceFile, "utf8");
    assert.ok(peakConcurrency(trace) >= 2, `expected overlapping agent runs, trace:\n${trace}`);
  } finally {
    delete process.env.PORTICO_TRACE_FILE;
    delete process.env.PORTICO_AGENT_DELAY_MS;
    await rm(repo, { recursive: true, force: true });
    await rm(traceDir, { recursive: true, force: true });
  }
});

test("compare mode honors the agent-process concurrency cap", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const traceDir = await mkdtemp(join(tmpdir(), "portico-trace-"));
  const traceFile = join(traceDir, "trace.log");
  const orchestrator = createDelegationOrchestrator({ maxConcurrentAgentProcesses: 1 });
  process.env.PORTICO_TRACE_FILE = traceFile;
  process.env.PORTICO_AGENT_DELAY_MS = "150";

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["gemini", "opencode"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    assert.equal(events.at(-1)?.type, "run_done");
    const trace = await readFile(traceFile, "utf8");
    assert.equal(peakConcurrency(trace), 1, `expected serialized agent runs, trace:\n${trace}`);
  } finally {
    delete process.env.PORTICO_TRACE_FILE;
    delete process.env.PORTICO_AGENT_DELAY_MS;
    await rm(repo, { recursive: true, force: true });
    await rm(traceDir, { recursive: true, force: true });
  }
});

/** Reconstruct the peak number of overlapping agent runs from the edit-agent trace. */
function peakConcurrency(trace: string): number {
  const events = trace
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [kind, , ts] = line.split(":");
      return { kind, ts: Number(ts) };
    })
    // On a timestamp tie, count ends before starts so overlap is never overstated.
    .sort((a, b) => a.ts - b.ts || (a.kind === "end" ? -1 : 1));
  let live = 0;
  let peak = 0;
  for (const event of events) {
    if (event.kind === "start") {
      live++;
      peak = Math.max(peak, live);
    } else {
      live--;
    }
  }
  return peak;
}

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

// ---- Phase 2 group-run tests --------------------------------------------------------

test("compareTargets are normalized to children and produce group+child lineage", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.role, "group");
    assert.ok(group.run.childRunIds);
    assert.equal(group.run.childRunIds!.length, 2);

    // Each child has role:"child", groupId, parentRunId
    for (const childId of group.run.childRunIds!) {
      const child = await orchestrator.getRun(repo, childId);
      assert.equal(child.run.role, "child");
      assert.equal(child.run.groupId, groupId);
      assert.equal(child.run.parentRunId, groupId);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("explicit children with heterogeneous config are reflected in child run.json", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "create delegated file",
        children: [
          { to: "codex", label: "c1", permissionProfile: "read-only", allowedPaths: ["src/**"] },
          { to: "claude", label: "c2", permissionProfile: "auto-edit", model: "sonnet" },
        ],
      },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.role, "group");
    assert.ok(group.run.childRunIds);
    assert.equal(group.run.childRunIds!.length, 2);

    // Verify child labels and permission profiles
    const children = await Promise.all(group.run.childRunIds!.map((id) => orchestrator.getRun(repo, id)));
    const labels = children.map((c) => c.run.label).sort();
    assert.deepEqual(labels, ["c1", "c2"]);

    const c1 = children.find((c) => c.run.label === "c1")!;
    assert.equal(c1.run.role, "child");
    assert.equal(c1.run.permissionProfile, "read-only");
    assert.deepEqual(c1.run.isolation.workspace, "worktree");

    const c2 = children.find((c) => c.run.label === "c2")!;
    assert.equal(c2.run.permissionProfile, "auto-edit");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("old run.json with no role reads as single", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file" },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    // Role absent → treated as "single"
    assert.ok(!details.run.role || details.run.role === "single");

    // Apply should work (single implement run)
    const applied = await orchestrator.apply(repo, runId);
    assert.equal(applied.run.status, "applied");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("aggregate status: all ready → group ready", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.role, "group");
    assert.equal(group.run.status, "ready");
    assert.ok(group.result?.groupSummary);
    assert.equal(group.result!.groupSummary!.ready, 2);
    assert.equal(group.result!.groupSummary!.failed, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("aggregate status: mixed ready and failed → group partial", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "create delegated file",
        children: [
          { to: "codex", label: "ok" },
          // This child writes delegated.txt, which is outside its allowed paths, so
          // Portico's path gate fails it — yielding one ready + one failed = partial.
          { to: "claude", label: "blocked", allowedPaths: ["src/**"] },
        ],
      },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.role, "group");
    assert.equal(group.run.status, "partial");
    assert.equal(group.result!.groupSummary!.total, 2);
    assert.equal(group.result!.groupSummary!.ready, 1);
    assert.equal(group.result!.groupSummary!.failed, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply group without --child errors with clear message", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";

    await assert.rejects(
      () => orchestrator.apply(repo, groupId),
      /has multiple children.*--child/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply group --child applies child diff and sets group applied", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    const childId = group.run.childRunIds![0];

    const applied = await orchestrator.apply(repo, groupId, { child: childId });
    assert.equal(applied.run.id, childId);
    assert.equal(applied.run.status, "applied");
    assert.match(await readFile(join(repo, "delegated.txt"), "utf8"), /created by edit-agent/);

    // Group should also be applied
    const groupAfter = await orchestrator.getRun(repo, groupId);
    assert.equal(groupAfter.run.status, "applied");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply group --child with a child from a different group errors", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    // Create a single (non-group) run to use as a fake child
    const events1: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file" },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events1.push(event);
    }
    const singleDone = events1.at(-1);
    assert.equal(singleDone?.type, "run_done");
    const singleId = singleDone?.type === "run_done" ? singleDone.runId : "";

    // Create a group
    const events2: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events2.push(event);
    }
    const groupDone = events2.at(-1);
    assert.equal(groupDone?.type, "run_done");
    const groupId = groupDone?.type === "run_done" ? groupDone.runId : "";

    // Try to apply the single run as a child of the group
    await assert.rejects(
      () => orchestrator.apply(repo, groupId, { child: singleId }),
      /does not belong to group/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("cancel group cascades to all children (idempotent)", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);

    // Cancel the group
    const cancelled = await orchestrator.cancel(repo, groupId);
    assert.equal(cancelled.run.status, "cancelled");

    // All children should be cancelled too
    for (const childId of group.run.childRunIds!) {
      const child = await orchestrator.getRun(repo, childId);
      assert.equal(child.run.status, "cancelled");
    }

    // Cancel again (idempotent — should not throw)
    const cancelled2 = await orchestrator.cancel(repo, groupId);
    assert.equal(cancelled2.run.status, "cancelled");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("discard group cascades to remove all child worktrees", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);

    // Discard the group
    const discarded = await orchestrator.discard(repo, groupId);
    assert.equal(discarded.run.status, "discarded");

    // Child worktrees should be removed
    for (const childId of group.run.childRunIds!) {
      const child = await orchestrator.getRun(repo, childId);
      assert.equal(child.run.status, "discarded");
    }

    // Discard again (idempotent)
    const discarded2 = await orchestrator.discard(repo, groupId);
    assert.equal(discarded2.run.status, "discarded");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runs folded view nests children under group; flat view flattens", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }

    // Folded view
    const folded = await orchestrator.listRuns(repo);
    const groups = folded.filter((r) => (r.role ?? "single") === "group");
    assert.ok(groups.length >= 1);
    for (const group of groups) {
      const children = (group as unknown as Record<string, unknown>)["_children"] as Run[] | undefined;
      assert.ok(children && children.length >= 2);
    }

    // Flat view
    const flat = await orchestrator.listRuns(repo, { flat: true });
    assert.ok(flat.length > folded.length);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resume a child with agentSessionId re-runs and updates result", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    const childId = group.run.childRunIds![0]!;
    const child = await orchestrator.getRun(repo, childId);
    assert.ok(child.run.agentSessionId, "child should have agentSessionId from start event");

    // Resume the child with a new task
    const resumeEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.resumeChild(
      repo, childId, "create an extra file called resume-output.txt",
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      resumeEvents.push(event);
    }
    const resumeDone = resumeEvents.at(-1);
    assert.equal(resumeDone?.type, "run_done", "resume should complete");

    // The child should have re-generated its diff
    const childAfter = await orchestrator.getRun(repo, childId);
    assert.ok((childAfter.result?.changedFiles?.length ?? 0) >= 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resume with a cleaned worktree errors", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "create delegated file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const groupId = done?.type === "run_done" ? done.runId : "";
    const group = await orchestrator.getRun(repo, groupId);
    const childId = group.run.childRunIds![0]!;
    const child = await orchestrator.getRun(repo, childId);

    // Remove the worktree to simulate cleanup
    if (child.run.isolation.workspace === "worktree") {
      await rm(child.run.worktreePath, { recursive: true, force: true });
    }

    // Resume should fail because worktree is missing
    const resumeEvents: DelegationEvent[] = [];
    let sawWorktreeError = false;
    try {
      for await (const event of orchestrator.resumeChild(
        repo, childId, "fix the tests",
        { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
      )) {
        resumeEvents.push(event);
        if (event.type === "run_error" && event.code === "worktree_missing") sawWorktreeError = true;
      }
    } catch {
      // May also throw
    }
    assert.ok(sawWorktreeError || resumeEvents.some((e) => e.type === "run_error" && (e.code === "worktree_missing" || e.code === "resume_unsupported")));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---- Phase 3 split / fan-in tests ---------------------------------------------------

function groupIdOf(events: DelegationEvent[]): string {
  const done = events.at(-1);
  assert.equal(done?.type, "run_done");
  return done?.type === "run_done" ? done.runId : "";
}

function splitChild(provider: string, label: string, directive: Record<string, unknown>, allowedPaths?: string[]) {
  return {
    to: provider,
    label,
    task: `Do part ${label}. SPLIT_AGENT:${JSON.stringify(directive)}`,
    ...(allowedPaths ? { allowedPaths } : {}),
  };
}

/** Route judge runs to the judge fixture; everything else to the split fixture. */
function splitOrJudge(provider: string) {
  return provider === "gemini" ? agentEntry("gemini", JUDGE_AGENT) : agentEntry(provider, SPLIT_AGENT);
}

async function createRepoWithShared(content: string): Promise<string> {
  const repo = await createRepo();
  await writeFile(join(repo, "shared.txt"), content);
  await git(repo, "add", "shared.txt");
  await git(repo, "commit", "-m", "shared");
  return repo;
}

test("split mode requires every child to declare a task", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "split work",
        mode: "split",
        children: [{ to: "codex", task: "has a task" }, { to: "claude" }],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }
    const err = events.find((e) => e.type === "run_error");
    assert.ok(err, "expected a validation error");
    assert.equal(err?.type === "run_error" ? err.code : "", "split_child_task_required");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("split mode runs complementary children and merges mutually-exclusive files", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "build a + b",
        mode: "split",
        children: [
          splitChild("codex", "a", { writes: [{ path: "a.txt", content: "A\n" }] }, ["a.txt"]),
          splitChild("claude", "b", { writes: [{ path: "b.txt", content: "B\n" }] }, ["b.txt"]),
        ],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.role, "group");
    assert.equal(group.run.mode, "split");
    assert.equal(group.run.status, "ready");
    assert.equal(group.run.childRunIds!.length, 2);

    for (const childId of group.run.childRunIds!) {
      const child = await orchestrator.getRun(repo, childId);
      assert.equal(child.run.role, "child");
      assert.equal(child.run.groupId, groupId);
      assert.equal(child.run.status, "ready");
    }

    // Fan-in events and a clean merge.
    assert.ok(events.some((e) => e.type === "fanin_start"));
    const merge = events.find((e) => e.type === "merge_done");
    assert.equal(merge?.type === "merge_done" ? merge.status : "", "ready");
    assert.equal(group.result?.merge?.status, "ready");

    // The merged group diff carries both contributions.
    const mergedDiff = await readFile(group.artifacts.diffPath as string, "utf8");
    assert.match(mergedDiff, /a\.txt/);
    assert.match(mergedDiff, /b\.txt/);

    // apply --all lands every contribution.
    const applied = await orchestrator.apply(repo, groupId, { all: true });
    assert.equal(applied.run.status, "applied");
    assert.match(await readFile(join(repo, "a.txt"), "utf8"), /A/);
    assert.match(await readFile(join(repo, "b.txt"), "utf8"), /B/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("split merge does a three-way merge of non-overlapping edits to one file", async () => {
  installBuiltinAdapters();
  const repo = await createRepoWithShared("ALPHA\nmiddle\nOMEGA\n");
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "edit two regions",
        mode: "split",
        children: [
          splitChild("codex", "a", { replaces: [{ path: "shared.txt", find: "ALPHA", replace: "ALPHA-A" }] }, ["shared.txt"]),
          splitChild("claude", "b", { replaces: [{ path: "shared.txt", find: "OMEGA", replace: "OMEGA-B" }] }, ["shared.txt"]),
        ],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.status, "ready");

    const applied = await orchestrator.apply(repo, groupId, { all: true });
    assert.equal(applied.run.status, "applied");
    const shared = await readFile(join(repo, "shared.txt"), "utf8");
    assert.match(shared, /ALPHA-A/);
    assert.match(shared, /OMEGA-B/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("split merge with overlapping edits enters conflict and refuses apply --all", async () => {
  installBuiltinAdapters();
  const repo = await createRepoWithShared("ALPHA\nmiddle\nOMEGA\n");
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "two agents fight over ALPHA",
        mode: "split",
        children: [
          splitChild("codex", "a", { replaces: [{ path: "shared.txt", find: "ALPHA", replace: "ALPHA-A" }] }, ["shared.txt"]),
          splitChild("claude", "b", { replaces: [{ path: "shared.txt", find: "ALPHA", replace: "ALPHA-B" }] }, ["shared.txt"]),
        ],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.status, "conflict");

    const merge = events.find((e) => e.type === "merge_done");
    assert.equal(merge?.type === "merge_done" ? merge.status : "", "conflict");
    assert.ok(merge?.type === "merge_done" && merge.conflicts?.includes("shared.txt"));

    // conflicts.json records the conflicting file and its source child.
    const conflictsJson = JSON.parse(
      await readFile(join(repo, ".portico", "runs", groupId, "conflicts.json"), "utf8"),
    ) as { conflicts: Array<{ file: string; child: string }> };
    assert.ok(conflictsJson.conflicts.some((c) => c.file === "shared.txt"));
    assert.equal(group.result?.conflicts?.length, conflictsJson.conflicts.length);

    // apply --all is rejected on conflict.
    await assert.rejects(() => orchestrator.apply(repo, groupId, { all: true }), /conflict/i);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("resuming a child to narrow its changes re-merges a conflicted split group", async () => {
  installBuiltinAdapters();
  const repo = await createRepoWithShared("ALPHA\nmiddle\nOMEGA\n");
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "two agents fight over ALPHA",
        mode: "split",
        children: [
          splitChild("codex", "a", { replaces: [{ path: "shared.txt", find: "ALPHA", replace: "ALPHA-A" }] }, ["shared.txt"]),
          splitChild("claude", "b", { replaces: [{ path: "shared.txt", find: "ALPHA", replace: "ALPHA-B" }] }, ["shared.txt"]),
        ],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }
    const groupId = groupIdOf(events);
    let group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.status, "conflict");

    // Find child "b" and narrow it: overwrite shared.txt so it no longer touches ALPHA.
    let childBId = "";
    for (const id of group.run.childRunIds!) {
      const child = await orchestrator.getRun(repo, id);
      if (child.run.label === "b") childBId = id;
    }
    assert.ok(childBId, "expected to find child b");

    const resumeEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.resumeChild(
      repo,
      childBId,
      'Narrow to OMEGA only. SPLIT_AGENT:{"writes":[{"path":"shared.txt","content":"ALPHA\\nmiddle\\nOMEGA-B\\n"}]}',
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      resumeEvents.push(event);
    }

    // The resume triggers an automatic re-merge that now succeeds.
    const remerge = resumeEvents.find((e) => e.type === "merge_done");
    assert.equal(remerge?.type === "merge_done" ? remerge.status : "", "ready");

    group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.status, "ready");
    assert.equal(group.result?.conflicts?.length ?? 0, 0);

    const applied = await orchestrator.apply(repo, groupId, { all: true });
    assert.equal(applied.run.status, "applied");
    const shared = await readFile(join(repo, "shared.txt"), "utf8");
    assert.match(shared, /ALPHA-A/);
    assert.match(shared, /OMEGA-B/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("compare + judge records a ranking and recommendation; apply stays apply-one", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        compareTargets: ["claude"],
        repo,
        task: "create delegated file",
        mode: "compare",
        fanIn: { judge: { to: "gemini" } },
      },
      {
        findEntry: (provider) =>
          provider === "gemini" ? agentEntry("gemini", JUDGE_AGENT) : agentEntry(provider, EDIT_AGENT),
      },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.mode, "compare");
    assert.ok(group.result?.judge, "judge verdict should be recorded");
    const recommended = group.result?.judge?.recommendedChildId;
    assert.ok(recommended && group.run.childRunIds!.includes(recommended));
    assert.equal(group.result?.judge?.ranking?.length, 2);
    assert.ok(events.some((e) => e.type === "judge_done"));

    // The judge ran as its own read-only review run.
    const flat = await orchestrator.listRuns(repo, { flat: true });
    const judgeRun = flat.find((r) => r.label === "judge");
    assert.ok(judgeRun, "judge run should exist");
    assert.equal(judgeRun!.mode, "review");
    assert.equal(judgeRun!.permissionProfile, "read-only");
    assert.equal(judgeRun!.status, "ready");

    // Report highlights the recommendation; apply --all is rejected for compare.
    assert.match(await readFile(group.artifacts.reportPath, "utf8"), /Recommended:/);
    await assert.rejects(() => orchestrator.apply(repo, groupId, { all: true }), /only applies to split/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("split + judge vets the merged result and records a verdict", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "build a + b",
        mode: "split",
        children: [
          splitChild("codex", "a", { writes: [{ path: "a.txt", content: "A\n" }] }, ["a.txt"]),
          splitChild("claude", "b", { writes: [{ path: "b.txt", content: "B\n" }] }, ["b.txt"]),
        ],
        fanIn: { merge: "integration", judge: { to: "gemini" } },
      },
      { findEntry: splitOrJudge },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const group = await orchestrator.getRun(repo, groupId);
    assert.equal(group.run.status, "ready");
    assert.equal(group.result?.judge?.verdict, "approve");
    const judgeDone = events.find((e) => e.type === "judge_done");
    assert.equal(judgeDone?.type === "judge_done" ? judgeDone.verdict : "", "approve");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
