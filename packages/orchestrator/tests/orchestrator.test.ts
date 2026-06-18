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
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");
const ESCAPE_AGENT = join(here, "../../../test/fixtures/escape-agent.mjs");

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
    await assert.rejects(() => orchestrator.apply(repo, runId), /only implement runs can be applied/);
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
