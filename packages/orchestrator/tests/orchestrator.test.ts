import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const CANCEL_AGENT = join(here, "../../../test/fixtures/cancel-agent.mjs");

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
    const diffReadyIndex = events.findIndex((event) => event.type === "diff_ready");
    const verdictUpdateIndex = events.findIndex((event) => event.type === "verdict_update");
    const runDoneIndex = events.findIndex((event) => event.type === "run_done");
    assert.ok(diffReadyIndex >= 0, "single run should emit diff_ready");
    assert.ok(verdictUpdateIndex > diffReadyIndex, "single run should emit verdict_update after diff_ready");
    assert.ok(runDoneIndex > verdictUpdateIndex, "single run should emit run_done after verdict_update");
    const diffReady = events[diffReadyIndex];
    const verdictUpdate = events[verdictUpdateIndex];
    assert.equal(verdictUpdate?.type === "verdict_update" ? verdictUpdate.verdict.readiness : "", "not_ready");
    assert.deepEqual(
      verdictUpdate?.type === "verdict_update" ? verdictUpdate.verdict.changedFiles : [],
      diffReady?.type === "diff_ready" ? diffReady.changedFiles : [],
    );
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "ready");
    // No --name given → run name is a slug derived from the task.
    assert.equal(details.run.name, "create-delegated-file");
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
    // Path policy + grouped diff views land in the report so review needs no manual git diff.
    assert.match(report, /## Path Policy/);
    assert.match(report, /Allowed Policy: passed/);
    assert.match(report, /Added \(new\):/);
    assert.match(report, /- delegated\.txt/);
    assert.match(report, /Whitespace\/Conflict Check/);
    assert.equal(details.result?.pathPolicy?.status, "passed");
    assert.ok(details.result?.diffSummary?.nameStatus.includes("delegated.txt"));
    // Portico Observations foregrounds Portico's own measured facts over the agent's narration.
    assert.equal(details.result?.reviewDecision, "approve");
    assert.match(report, /## Portico Observations/);
    assert.match(report, /Changed Files: 1 file\(s\)/);
    assert.match(report, /Review Decision: approve/);
    assert.match(report, /not an authoritative status source/);

    // The run finished computing at `completedAt`; apply/discard must not overwrite it (that
    // would inflate the duration by the decision wait). They record their own `decidedAt`.
    const finishedAt = details.run.completedAt;
    assert.ok(finishedAt, "ready run records completedAt");

    const applied = await orchestrator.apply(repo, runId);
    assert.equal(applied.run.status, "applied");
    assert.equal(applied.run.completedAt, finishedAt, "apply preserves the finish time");
    assert.ok(applied.run.decidedAt, "apply records the decision time");
    assert.match(await readFile(join(repo, "delegated.txt"), "utf8"), /created by edit-agent/);

    const discarded = await orchestrator.discard(repo, runId);
    assert.equal(discarded.run.status, "discarded");
    assert.equal(discarded.run.completedAt, finishedAt, "discard preserves the finish time");
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

test("implement-mode no-change run is flagged needs_attention, not approve", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", FAKE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "update the docs" },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "ready");
    assert.deepEqual(details.result?.changedFiles, []);
    // No-change in implement mode is a non-result: Portico's review verdict is needs_attention.
    assert.equal(details.result?.reviewDecision, "needs_attention");
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Decision: needs_attention/);
    assert.match(report, /Review Decision: needs_attention/);
    assert.match(report, /Needs attention before apply/);
    // A no-change result must not lead the reviewer straight to apply.
    assert.doesNotMatch(report, /1\. Apply: `portico apply/);
    // Readiness distinguishes review-only from apply; a no-change run is review-only.
    assert.match(report, /Readiness: Ready to review only/);
    // The agent's own explanation is surfaced (clearly unverified) for a no-change run.
    assert.match(report, /## Agent's Stated Reason \(unverified/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("expectNoChanges keeps a no-change run approve and suppresses the warning", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", FAKE_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "verify nothing needs changing", expectNoChanges: true },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "ready");
    assert.deepEqual(details.result?.changedFiles, []);
    assert.equal(details.run.expectNoChanges, true);
    // Declared no-change: review verdict stays approve and the no-change warning is suppressed.
    assert.equal(details.result?.reviewDecision, "approve");
    assert.doesNotMatch(details.result?.gateWarnings?.join("\n") ?? "", /produced no file changes/);
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Decision: approve/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("--expected-change reports coverage and flags an untouched expected path", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", expectedChangePaths: ["delegated.txt", "missing.txt"] },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    // delegated.txt was changed (touched); missing.txt is an untouched expected path (a gap).
    assert.ok(details.result?.coverage?.touched.includes("delegated.txt"));
    assert.deepEqual(details.result?.coverage?.untouched, ["missing.txt"]);
    // A coverage gap on a ready implement run is suspect → needs_attention + a gate warning.
    assert.equal(details.result?.reviewDecision, "needs_attention");
    assert.match(details.result?.gateWarnings?.join("\n") ?? "", /Coverage gap.*missing\.txt/);
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /## Coverage/);
    assert.match(report, /Status: gap/);
    assert.match(report, /Untouched \(gaps\): missing\.txt/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("--expected-change with every expected path touched has no coverage gap", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", expectedChangePaths: ["delegated.txt"] },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.deepEqual(details.result?.coverage?.untouched, []);
    assert.equal(details.result?.reviewDecision, "approve");
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Status: complete/);
    assert.match(report, /Readiness: Ready to apply/);
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
    // Group telemetry records the fan-in phase so a reviewer can see time spent converging.
    assert.ok((details.result?.telemetry?.fanInMs ?? -1) >= 0);
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Compare Candidates/);
    assert.match(report, /Fan-in Duration: \d+ ms/);
    // Per-child agent duration shows where group time went (retry-cost view).
    assert.match(report, /ms agent/);
    // applyCheck: each candidate's patch applies independently to the group base.
    assert.ok(details.result?.childResults?.every((c) => c.applyCheck?.applies === true));
    assert.match(report, /apply: ok/);
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

async function createContinueAgent(repo: string): Promise<string> {
  const agentPath = join(repo, "continue-agent.mjs");
  await writeFile(agentPath, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

let previous = "";
try {
  previous = await readFile(join(process.cwd(), "delegated.txt"), "utf8");
} catch {
  previous = "";
}

const phase = prompt.includes("[continue]") ? "continue" : "initial";
await writeFile(join(process.cwd(), "delegated.txt"), previous + phase + "\\n");
await writeFile(join(process.cwd(), "agent-args.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write("ran " + phase + "\\n");
`);
  await chmod(agentPath, 0o755);
  return agentPath;
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
    assert.equal(events.some((event) => event.type === "verdict_update"), false);
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
    // Partial group report gives concrete next actions: apply the ready child, resume the failed one.
    const report = await readFile(group.artifacts.reportPath, "utf8");
    assert.match(report, /Apply ready.*--child/);
    assert.match(report, /Re-run failed.*--resume/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("path policy failure records out-of-scope paths and a copy-paste retry", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    // edit-agent writes delegated.txt, which is outside the allowed src/** boundary.
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", allowedPaths: ["src/**"] },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const last = events.at(-1);
    assert.equal(last?.type, "run_error");
    const error = last?.type === "run_error" ? last.error : "";
    assert.match(error, /non-allowed path\(s\): delegated\.txt/);
    assert.match(error, /--allowed delegated\.txt/);
    assert.equal(last?.type === "run_error" ? last.code : "", "path_not_allowed");

    const runId = events.find((e) => "runId" in e && e.runId)?.runId as string;
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.result?.pathPolicy?.status, "failed");
    assert.deepEqual(details.result?.pathPolicy?.notAllowed, ["delegated.txt"]);
    assert.deepEqual(details.result?.pathPolicy?.retryAllowed, ["delegated.txt"]);
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /Allowed Policy: failed/);
    assert.match(report, /Retry allowing them: --allowed delegated\.txt/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply --allow lands a diff that only failed path policy", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", allowedPaths: ["src/**"] },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const runId = events.find((e) => "runId" in e && e.runId)?.runId as string;

    const details = await orchestrator.apply(repo, runId, { allow: ["delegated.txt"] });
    assert.equal(details.run.status, "applied");
    assert.ok(existsSync(join(repo, "delegated.txt")), "diff should be applied onto the repo working tree");
    assert.deepEqual(details.result?.pathPolicyOverride?.allow, ["delegated.txt"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply --allow does not override a forbidden-path violation", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", forbiddenPaths: ["delegated.txt"] },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const runId = events.find((e) => "runId" in e && e.runId)?.runId as string;

    await assert.rejects(
      orchestrator.apply(repo, runId, { allow: ["delegated.txt"] }),
      (err: Error) => /not overridable/.test(err.message),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("apply --allow rejects when it does not cover every out-of-scope path", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", allowedPaths: ["src/**"] },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const runId = events.find((e) => "runId" in e && e.runId)?.runId as string;

    await assert.rejects(
      orchestrator.apply(repo, runId, { allow: ["other/path.txt"] }),
      (err: Error) => /--allow does not cover: delegated\.txt/.test(err.message),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("--verify checks run separately from tests and report under Verify Checks", async () => {
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
        testCommands: ["test -f delegated.txt"],
        verifyCommands: ["test -f delegated.txt", "grep -q edit-agent delegated.txt"],
      },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done?.type === "run_done" ? done.status : "", "ready");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.result?.verify?.length, 2);
    assert.ok(details.result?.verify?.every((v) => v.status === "passed"));
    // Telemetry buckets each phase: worktree setup, diff generation, and verify split out of tests.
    const tel = details.result?.telemetry;
    assert.ok((tel?.worktreeSetupMs ?? -1) >= 0);
    assert.ok((tel?.diffMs ?? -1) >= 0);
    assert.ok((tel?.verifyMs ?? -1) >= 0, "verify duration is tracked separately");
    assert.equal(tel?.fanInMs, undefined, "single runs have no fan-in phase");
    const report = await readFile(details.artifacts.reportPath, "utf8");
    assert.match(report, /## Code Tests/);
    assert.match(report, /## Verify Checks/);
    assert.match(report, /Worktree Setup: \d+ ms/);
    assert.match(report, /Diff Generation: \d+ ms/);
    assert.match(report, /Verify Duration: \d+ ms/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a failing --verify check fails the run", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];

  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file", verifyCommands: ["test -f never-created.txt"] },
      { findEntry: () => agentEntry("codex", EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = await orchestrator.getRun(repo, runId);
    assert.equal(details.run.status, "failed");
    assert.equal(details.result?.verify?.[0]?.status, "failed");
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

test("cancel mid-flight salvages the worktree diff", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", CANCEL_AGENT);

  try {
    const iterator = orchestrator.delegate(
      { to: "codex", repo, task: "make a change then hang" },
      { findEntry: () => entry },
    )[Symbol.asyncIterator]();

    const first = await iterator.next();
    assert.equal(first.value?.type, "run_start");
    const runId = first.value?.type === "run_start" ? first.value.runId : "";

    // Drain the generator in the background so its own (slower) catch-path salvage
    // also runs to completion — cancel() below should not need to race it.
    const drain = (async () => {
      while (!(await iterator.next()).done) {
        // keep pumping
      }
    })();
    drain.catch(() => {});

    const marker = join(repo, ".portico", "worktrees", runId, "delegated.txt");
    const deadline = Date.now() + 5000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("cancel-agent never wrote its marker file");
      await new Promise((r) => setTimeout(r, 20));
    }

    const cancelled = await orchestrator.cancel(repo, runId);
    assert.equal(cancelled.run.status, "cancelled");
    assert.ok(cancelled.result?.changedFiles?.includes("delegated.txt"));
    assert.ok(cancelled.result?.diffSummary?.stat.includes("delegated.txt"));
    assert.ok(existsSync(cancelled.artifacts.diffPath as string));
    assert.match(await readFile(cancelled.artifacts.diffPath as string, "utf8"), /delegated.txt/);
    assert.match(await readFile(cancelled.artifacts.reportPath, "utf8"), /delegated\.txt/);

    await drain;
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

test("generic adapters do not capture session id and yield resume_unsupported", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const runDetails = await orchestrator.getRun(repo, runId);
    assert.equal(runDetails.run.agentSessionId, undefined);

    const resumeEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.resumeChild(
      repo, runId, "continue",
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      resumeEvents.push(event);
    }
    const errorEvent = resumeEvents.at(-1);
    assert.equal(errorEvent?.type, "run_error");
    assert.equal(errorEvent?.type === "run_error" ? errorEvent.code : "", "resume_unsupported");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("continue re-runs a no-session run in its existing worktree", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const agentPath = await createContinueAgent(repo);
    const entry = agentEntry("codex", agentPath);
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create initial delegated file", testCommands: ["test -f delegated.txt"] },
      { findEntry: () => entry },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const runDetails = await orchestrator.getRun(repo, runId);
    assert.equal(runDetails.run.agentSessionId, undefined);

    const continueEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.continueRun(
      repo, runId, "append the continue marker",
      { findEntry: () => entry },
    )) {
      continueEvents.push(event);
    }
    const continueDone = continueEvents.at(-1);
    assert.equal(continueDone?.type, "run_done");
    assert.equal(continueDone?.type === "run_done" ? continueDone.status : "", "ready");
    assert.ok(continueEvents.some((event) => event.type === "test_done" && event.command === "test -f delegated.txt"));

    const continued = await orchestrator.getRun(repo, runId);
    const file = await readFile(join(continued.run.worktreePath, "delegated.txt"), "utf8");
    assert.match(file, /initial/);
    assert.match(file, /continue/);
    assert.ok(continued.result?.changedFiles.includes("delegated.txt"));

    const argv = JSON.parse(await readFile(join(continued.run.worktreePath, "agent-args.json"), "utf8")) as string[];
    assert.equal(argv.includes("--resume"), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("stream-json adapter captures native session id and passes resume args on resume", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "claude", repo, task: "hello", mode: "review" },
      { findEntry: (provider) => agentEntry(provider, FAKE_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const child = await orchestrator.getRun(repo, runId);
    assert.equal(child.run.agentSessionId, "fake-1");

    const resumeEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.resumeChild(
      repo, runId, "continue",
      { findEntry: (provider) => agentEntry(provider, FAKE_AGENT) },
    )) {
      resumeEvents.push(event);
    }
    const resumeDone = resumeEvents.at(-1);
    assert.equal(resumeDone?.type, "run_done");

    const resumedChild = await orchestrator.getRun(repo, runId);
    const text = (resumedChild.result?.agentEvents ?? [])
      .filter((event) => event.type === "content")
      .map((event) => (event.type === "content" ? event.delta : ""))
      .join("");
    assert.match(text, /\(resumed fake-1\)/);
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

test("continue with a cleaned worktree errors", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();

  try {
    const events: DelegationEvent[] = [];
    for await (const event of orchestrator.delegate(
      { to: "codex", repo, task: "create delegated file" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const runDetails = await orchestrator.getRun(repo, runId);

    if (runDetails.run.isolation.workspace === "worktree") {
      await rm(runDetails.run.worktreePath, { recursive: true, force: true });
    }

    const continueEvents: DelegationEvent[] = [];
    for await (const event of orchestrator.continueRun(
      repo, runId, "continue anyway",
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      continueEvents.push(event);
    }
    const errorEvent = continueEvents.at(-1);
    assert.equal(errorEvent?.type, "run_error");
    assert.equal(errorEvent?.type === "run_error" ? errorEvent.code : "", "worktree_missing");
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

    // Two children editing the same region is an overlap conflict, classified as such with a
    // git reason (not a bare patch-apply failure).
    assert.equal(group.result?.merge?.conflictKind, "overlap");
    assert.ok((group.result?.merge?.conflictReason?.length ?? 0) > 0);

    // conflicts.json records the conflicting file, its source child, the kind, the failing
    // child, and the underlying git reason.
    const conflictsJson = JSON.parse(
      await readFile(join(repo, ".portico", "runs", groupId, "conflicts.json"), "utf8"),
    ) as {
      kind: string;
      failingChild: string;
      reason: string;
      conflicts: Array<{ file: string; child: string; kind?: string }>;
    };
    assert.equal(conflictsJson.kind, "overlap");
    assert.ok(conflictsJson.failingChild.length > 0);
    assert.ok(conflictsJson.reason.length > 0);
    assert.ok(conflictsJson.conflicts.some((c) => c.file === "shared.txt" && c.kind === "overlap"));
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
    await assert.rejects(() => orchestrator.apply(repo, groupId, { all: true }), /does not apply to compare groups/);
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

// ---- Feedback P2/P3: integrate, cleanup, listRuns filters, progress ------------------

test("integrate merges a split group's ready children when fan-in merge was disabled", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "two complementary parts",
        mode: "split",
        fanIn: { merge: "none" },
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
    // merge=none: the group is ready but never auto-merged, so apply --all has no patch yet.
    assert.ok(!events.some((e) => e.type === "merge_done"));
    await assert.rejects(() => orchestrator.apply(repo, groupId, { all: true }), /integrate/);

    // On-demand integrate merges the ready children and records the apply order.
    const result = await orchestrator.integrate(repo, groupId);
    assert.equal(result.status, "ready");
    assert.equal(result.order.length, 2);
    assert.ok(result.mergedDiffPath && existsSync(result.mergedDiffPath));

    const applied = await orchestrator.apply(repo, groupId, { all: true });
    assert.equal(applied.run.status, "applied");
    assert.match(await readFile(join(repo, "a.txt"), "utf8"), /A/);
    assert.match(await readFile(join(repo, "b.txt"), "utf8"), /B/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("integrate reports conflicts with source child and a review order", async () => {
  installBuiltinAdapters();
  const repo = await createRepoWithShared("ALPHA\nmiddle\nOMEGA\n");
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      {
        to: "codex",
        repo,
        task: "two overlapping edits",
        mode: "split",
        fanIn: { merge: "none" },
        children: [
          splitChild("codex", "a", { replaces: [{ path: "shared.txt", find: "middle", replace: "MIDDLE-A" }] }, ["shared.txt"]),
          splitChild("claude", "b", { replaces: [{ path: "shared.txt", find: "middle", replace: "MIDDLE-B" }] }, ["shared.txt"]),
        ],
      },
      { findEntry: (provider) => agentEntry(provider, SPLIT_AGENT) },
    )) {
      events.push(event);
    }

    const groupId = groupIdOf(events);
    const result = await orchestrator.integrate(repo, groupId);
    assert.equal(result.status, "conflict");
    assert.ok((result.conflicts?.length ?? 0) >= 1);
    assert.ok(result.conflicts?.every((c) => typeof c.child === "string" && c.child.length > 0));
    assert.equal(result.order.length, 2);
    // A conflicted integration must not leave an appliable merged patch behind.
    await assert.rejects(() => orchestrator.apply(repo, groupId, { all: true }), /conflict/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("integrate rejects compare groups", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const events: DelegationEvent[] = [];
  try {
    for await (const event of orchestrator.delegate(
      { to: "codex", compareTargets: ["claude"], repo, task: "build a file", mode: "compare" },
      { findEntry: (provider) => agentEntry(provider, EDIT_AGENT) },
    )) {
      events.push(event);
    }
    const groupId = groupIdOf(events);
    await assert.rejects(() => orchestrator.integrate(repo, groupId), /compare group/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("cleanup reclaims failed worktrees, keeps artifacts, and skips ready runs", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  try {
    // A ready run (passing test) and a failed run (failing test) in the same repo.
    const readyEvents: DelegationEvent[] = [];
    for await (const e of orchestrator.delegate(
      { to: "codex", repo, task: "create file", testCommands: ["test -f delegated.txt"] },
      { findEntry: () => entry },
    )) {
      readyEvents.push(e);
    }
    const readyId = groupIdOf(readyEvents);

    const failedEvents: DelegationEvent[] = [];
    for await (const e of orchestrator.delegate(
      { to: "codex", repo, task: "create file", testCommands: ["false"] },
      { findEntry: () => entry },
    )) {
      failedEvents.push(e);
    }
    const failedId = groupIdOf(failedEvents);

    const failed = await orchestrator.getRun(repo, failedId);
    assert.equal(failed.run.status, "failed");
    assert.ok(existsSync(failed.run.worktreePath));

    // --older-than guards against reclaiming a just-finished run.
    const noop = await orchestrator.cleanup(repo, { failed: true, olderThanMs: 3_600_000 });
    assert.equal(noop.cleaned.length, 0);

    // Default cleanup removes the worktree but keeps the artifacts for inspection.
    const result = await orchestrator.cleanup(repo, { failed: true });
    assert.equal(result.cleaned.length, 1);
    assert.equal(result.cleaned[0]?.id, failedId);
    assert.equal(result.cleaned[0]?.worktreeRemoved, true);
    assert.equal(result.cleaned[0]?.purged, false);
    assert.ok(!existsSync(failed.run.worktreePath));
    assert.ok(existsSync(failed.artifacts.resultPath));

    // The ready run is never touched.
    const ready = await orchestrator.getRun(repo, readyId);
    assert.equal(ready.run.status, "ready");
    assert.ok(existsSync(ready.run.worktreePath));

    // --purge deletes the whole run directory.
    const purged = await orchestrator.cleanup(repo, { failed: true, purge: true });
    assert.equal(purged.cleaned.length, 1);
    assert.ok(!existsSync(dirname(failed.artifacts.resultPath)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("listRuns filters by status and since", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  try {
    for await (const _ of orchestrator.delegate(
      { to: "codex", repo, task: "ok", testCommands: ["test -f delegated.txt"] },
      { findEntry: () => entry },
    )) {
      // drain
    }
    for await (const _ of orchestrator.delegate(
      { to: "codex", repo, task: "bad", testCommands: ["false"] },
      { findEntry: () => entry },
    )) {
      // drain
    }

    const failedOnly = await orchestrator.listRuns(repo, { flat: true, status: ["failed"] });
    assert.ok(failedOnly.length >= 1);
    assert.ok(failedOnly.every((r) => r.status === "failed"));

    const recent = await orchestrator.listRuns(repo, { flat: true, sinceMs: 60_000 });
    assert.ok(recent.length >= 2);

    const ancient = await orchestrator.listRuns(repo, { flat: true, sinceMs: 1 });
    assert.equal(ancient.length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("getRun attaches progress (phase, inactive, last event) for a finished run", async () => {
  installBuiltinAdapters();
  const repo = await createRepo();
  const orchestrator = createDelegationOrchestrator();
  const entry = agentEntry("codex", EDIT_AGENT);
  const events: DelegationEvent[] = [];
  try {
    for await (const e of orchestrator.delegate(
      { to: "codex", repo, task: "create file" },
      { findEntry: () => entry },
    )) {
      events.push(e);
    }
    const id = groupIdOf(events);
    const details = await orchestrator.getRun(repo, id);
    assert.equal(details.progress?.phase, details.run.status);
    assert.equal(details.progress?.active, false);
    assert.equal(details.progress?.lastEvent?.type, "run_done");
    assert.ok(details.progress?.lastEvent?.at);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
