import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { capture, encodeEvent, runAgent } from "@portico/core";
import type { AgentEntry, ChatRequest, RuntimeEvent } from "@portico/core";
import type {
  ChildSpec,
  CleanupOptions,
  CleanupPolicy,
  CleanupResult,
  CoverageResult,
  DelegateRequest,
  DelegationEvent,
  DelegationMode,
  DiffSummary,
  FanInPolicy,
  IntegrateResult,
  ListRunsOptions,
  OrchestratorOptions,
  PathPolicyResult,
  PermissionProfile,
  OutOfTreeChange,
  RunProgress,
  RunTelemetry,
  Run,
  RunArtifact,
  RunDetails,
  RunResult,
  RunRole,
  RunStatus,
  TestResult,
  WorkspaceIsolation,
  WorkspaceIsolationMode,
} from "./types.ts";
import { createSemaphore, mergeAsyncIterables } from "./concurrency.ts";
import type { Semaphore } from "./concurrency.ts";
import { buildRunVerdict } from "./verdict.ts";

const DEFAULT_FORBIDDEN = [".env", ".ssh/**", "node_modules/**", "dist/**", "build/**"];

/** Orchestrator-scoped state shared by every delegation run. */
interface DelegationDeps {
  activeControllers: Map<string, AbortController>;
  defaultForbidden: string[];
  /** Serializes `git worktree` metadata writes across concurrent runs. */
  worktreeMutex: Semaphore;
  /** Upper bound on candidate runs executed concurrently within one fan-out. */
  maxConcurrentAgentProcesses: number;
}

export class DelegationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DelegationError";
    this.code = code;
  }
}

export function encodeDelegationEvent(event: DelegationEvent): string {
  return JSON.stringify(event) + "\n";
}

export interface DelegationOrchestrator {
  delegate(
    request: DelegateRequest,
    context: { findEntry(provider: string): AgentEntry | undefined },
  ): AsyncIterable<DelegationEvent>;
  listRuns(repo: string, opts?: ListRunsOptions): Promise<Run[]>;
  getRun(repo: string, id: string): Promise<RunDetails>;
  readEvents(repo: string, id: string): Promise<DelegationEvent[]>;
  cancel(repo: string, id: string): Promise<RunDetails>;
  apply(repo: string, id: string, opts?: { child?: string; all?: boolean; allow?: string[] }): Promise<RunDetails>;
  /** On-demand merge of a group's ready children into an integration worktree. */
  integrate(repo: string, id: string): Promise<IntegrateResult>;
  /** Reclaim finished runs: remove worktrees (and, with purge, artifacts). */
  cleanup(repo: string, opts?: CleanupOptions): Promise<CleanupResult>;
  discard(repo: string, id: string): Promise<RunDetails>;
  resumeChild(repo: string, id: string, task: string, context: { findEntry(provider: string): AgentEntry | undefined }): AsyncIterable<DelegationEvent>;
}

export function createDelegationOrchestrator(options: OrchestratorOptions = {}): DelegationOrchestrator {
  const maxDepth = options.maxDepth ?? 1;
  const maxConcurrent = options.maxConcurrentRunsPerRepo ?? 2;
  const maxConcurrentAgentProcesses = options.maxConcurrentAgentProcesses ?? 4;
  const defaultForbidden = options.defaultForbiddenPaths ?? DEFAULT_FORBIDDEN;
  const activeByRepo = new Map<string, number>();
  const activeControllers = new Map<string, AbortController>();
  const worktreeMutex = createSemaphore(1);
  const deps: DelegationDeps = {
    activeControllers,
    defaultForbidden,
    worktreeMutex,
    maxConcurrentAgentProcesses,
  };

  return {
    async *delegate(request, context) {
      let reservedRepo: string | undefined;
      try {
        validateRequest(request, maxDepth);
        const repoPath = await resolveRepo(request.repo);

        // Reserve a concurrency slot atomically: read and write must not straddle an
        // await, or two concurrent delegates both see N and both write N+1.
        const active = activeByRepo.get(repoPath) ?? 0;
        if (active >= maxConcurrent) {
          throw new DelegationError("repo_busy", `Repo already has ${active} active delegation run(s).`);
        }
        activeByRepo.set(repoPath, active + 1);
        reservedRepo = repoPath;

        await ensurePorticoDirs(repoPath);
        await ensurePorticoExcluded(repoPath);
        const testCommands = request.testCommands?.length
          ? request.testCommands
          : await readDefaultTestCommands(repoPath);
        const effectiveRequest: DelegateRequest = { ...request, testCommands };

        // Normalize compareTargets / children into a unified children list.
        const children = normalizeChildren(effectiveRequest);
        if (children.length >= 2) {
          yield* runGroupDelegation(effectiveRequest, repoPath, context, deps, children);
        } else {
          yield* runSingleDelegation(effectiveRequest, repoPath, context, deps);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const code = err instanceof DelegationError ? err.code : "internal";
        yield { type: "run_error", error, code };
      } finally {
        if (reservedRepo) {
          const active = activeByRepo.get(reservedRepo) ?? 1;
          if (active <= 1) activeByRepo.delete(reservedRepo);
          else activeByRepo.set(reservedRepo, active - 1);
        }
      }
    },

    async listRuns(repo, opts) {
      const repoPath = await resolveRepo(repo);
      let all = await readAllRuns(repoPath);
      if (opts?.status?.length) {
        const wanted = new Set(opts.status);
        all = all.filter((run) => wanted.has(run.status));
      }
      if (opts?.sinceMs !== undefined) {
        const cutoff = Date.now() - opts.sinceMs;
        all = all.filter((run) => Date.parse(run.createdAt) >= cutoff);
      }
      const annotate = (run: Run) => annotateRun(run, activeControllers, repoPath);
      if (opts?.flat) return Promise.all(all.map(annotate));
      return Promise.all(
        foldRuns(all).map(async (group) => {
          const children = (group as unknown as Record<string, unknown>)["_children"] as Run[] | undefined;
          if (children) (group as unknown as Record<string, unknown>)["_children"] = await Promise.all(children.map(annotate));
          return annotate(group);
        }),
      );
    },

    async getRun(repo, id) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      return { ...details, progress: await computeProgress(details, activeControllers) };
    },

    async readEvents(repo, id) {
      const text = await readFile(artifactPaths(await resolveRepo(repo), id).eventsPath, "utf8");
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DelegationEvent);
    },

    async cancel(repo, id) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      const role = details.run.role ?? "single";

      if (role === "group" && details.run.childRunIds?.length) {
        for (const childId of details.run.childRunIds) {
          try {
            await cancelAndSalvage(repoPath, childId, deps);
          } catch {
            // Idempotent: already-finished children should not block the cascade.
          }
        }
        const run = await updateRun(details.run, { status: "cancelled", completedAt: new Date().toISOString() });
        await writeJson(details.artifacts.resultPath, { ...details.result, childResults: details.result?.childResults ?? details.result?.compareResults, run });
        return readRunDetails(repoPath, id);
      }

      await cancelAndSalvage(repoPath, id, deps);
      return readRunDetails(repoPath, id);
    },

    async apply(repo, id, opts) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      const role = details.run.role ?? "single";

      if (role === "group") {
        if (opts?.all) {
          return applyGroupMerged(repoPath, id);
        }
        if (opts?.child) {
          return applyChild(repoPath, id, opts.child, opts.allow);
        }
        if (details.run.mode === "split") {
          throw new DelegationError(
            "apply_requires_all",
            `Split group ${id} merges its children. Use --all to apply the merged patch (or --child to apply a single contribution).`,
          );
        }
        throw new DelegationError(
          "apply_requires_child",
          `Group run ${id} has multiple children. Use --child to select which child to apply.`,
        );
      }

      // Single run — existing behaviour, plus a user-confirmed override for runs that
      // failed solely on path policy (a good diff that only needs a wider --allow set).
      if (details.run.mode !== "implement") {
        throw new DelegationError("invalid_mode", `Run ${id} is ${details.run.mode}; only implement runs can be applied.`);
      }
      let pathPolicyOverride: string[] | undefined;
      if (details.run.status !== "ready") {
        const override = opts?.allow?.length ? resolvePathPolicyOverride(details.result, opts.allow) : undefined;
        if (!override?.ok) {
          throw new DelegationError(
            "invalid_status",
            opts?.allow?.length
              ? `Run ${id} is ${details.run.status}, not ready; --allow override does not apply (${override?.reason}).`
              : `Run ${id} is ${details.run.status}, not ready.`,
          );
        }
        pathPolicyOverride = opts!.allow;
      }
      if (!details.artifacts.diffPath || !existsSync(details.artifacts.diffPath)) {
        throw new DelegationError("missing_diff", `Run ${id} does not have a diff.patch artifact.`);
      }
      await assertTrackedTreeClean(repoPath);
      const applied = await capture("git", ["-C", repoPath, "apply", "--binary", details.artifacts.diffPath]);
      if (applied.code !== 0) {
        throw new DelegationError("apply_failed", (applied.stderr || applied.stdout || "git apply failed").trim());
      }
      const appliedAt = new Date().toISOString();
      const run = await updateRun(details.run, { status: "applied", completedAt: appliedAt });
      await writeJson(details.artifacts.resultPath, {
        ...details.result,
        run,
        ...(pathPolicyOverride ? { pathPolicyOverride: { allow: pathPolicyOverride, appliedAt } } : {}),
      });
      return readRunDetails(repoPath, id);
    },

    async integrate(repo, id) {
      return integrateGroup(await resolveRepo(repo), id, deps);
    },

    async cleanup(repo, opts) {
      return cleanupRuns(await resolveRepo(repo), opts ?? {}, deps);
    },

    async discard(repo, id) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      const role = details.run.role ?? "single";

      if (role === "group" && details.run.childRunIds?.length) {
        for (const childId of details.run.childRunIds) {
          try {
            const childDetails = await readRunDetails(repoPath, childId);
            await removeWorktree(repoPath, childDetails.run.worktreePath, worktreeMutex);
            await updateRun(childDetails.run, { status: "discarded", completedAt: new Date().toISOString() });
          } catch {
            // Idempotent: already-removed worktrees should not block the cascade.
          }
        }
        // Split groups also leave behind an integration worktree + merge branch.
        const integrationPath = join(repoPath, ".portico", "worktrees", `${id}_integration`);
        await removeWorktree(repoPath, integrationPath, worktreeMutex);
        await capture("git", ["-C", repoPath, "branch", "-D", `portico/${id}-merge`]);
        const run = await updateRun(details.run, { status: "discarded", completedAt: new Date().toISOString() });
        await writeJson(details.artifacts.resultPath, { ...details.result, childResults: details.result?.childResults ?? details.result?.compareResults, run });
        return readRunDetails(repoPath, id);
      }

      await removeWorktree(repoPath, details.run.worktreePath, worktreeMutex);
      const run = await updateRun(details.run, { status: "discarded", completedAt: new Date().toISOString() });
      await writeJson(details.artifacts.resultPath, { ...details.result, run });
      return readRunDetails(repoPath, id);
    },

    async *resumeChild(repo, id, task, ctx) {
      try {
        yield* resumeChildDelegation(await resolveRepo(repo), id, task, ctx, deps);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const code = err instanceof DelegationError ? err.code : "internal";
        yield { type: "run_error", error, code };
      }
    },
  };
}

// ---- Fan-out helpers ----------------------------------------------------------------

function normalizeChildren(request: DelegateRequest): ChildSpec[] {
  const explicit = request.children;
  if (explicit && explicit.length > 0) return explicit;

  const targets = request.compareTargets;
  if (request.mode === "compare" && targets && targets.length > 0) {
    return [request.to, ...targets].filter(Boolean).map((to) => ({ to }));
  }

  return [];
}

async function* runGroupDelegation(
  request: DelegateRequest,
  repoPath: string,
  context: { findEntry(provider: string): AgentEntry | undefined },
  deps: DelegationDeps,
  children: ChildSpec[],
): AsyncIterable<DelegationEvent> {
  if (children.length < 2) {
    throw new DelegationError("fanout_requires_children", "Fan-out requires at least two children.");
  }

  const now = new Date().toISOString();
  const runStartedMs = Date.now();

  const group = createRun(repoPath, request, {
    id: newRunId(now),
    targetAgent: children.map((c) => c.to).join(","),
    mode: request.mode ?? "compare",
    isolation: normalizeIsolation(request, "compare"),
    permissionProfile: "auto-edit",
    worktreePath: join(repoPath, ".portico", "worktrees", `group_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`),
    role: "group",
    childRunIds: [],
  });
  const artifacts = artifactPaths(repoPath, group.id);

  await mkdir(dirname(artifacts.taskPath), { recursive: true });
  await writeJson(artifacts.taskPath, { ...request, repo: repoPath, children });
  await saveRun(group);
  await writeFile(artifacts.eventsPath, "");
  yield await recordEvent(artifacts.eventsPath, { type: "run_start", runId: group.id, status: group.status });
  await updateRun(group, { status: "planning" });

  const isolation = normalizeIsolation(request, "compare");
  const groupTask = request.task;

  // Build sources: each child runs in its own worktree with lineage info.
  const childIds: string[] = [];
  const sources = children.map((spec) => {
    const childRequest = buildChildRequest(request, group.id, spec, groupTask, isolation);
    return () => runSingleDelegation(childRequest, repoPath, context, deps, {
      role: "child",
      groupId: group.id,
      parentRunId: group.id,
      label: spec.label,
    });
  });

  const concurrency = Math.min(children.length, request.maxParallel ?? deps.maxConcurrentAgentProcesses);
  for await (const event of mergeAsyncIterables(sources, { concurrency })) {
    yield event;
    // Register each child on its FIRST event (run_start), so the group's childRunIds
    // is wired while children are still in flight. Otherwise the group only learns its
    // children after the loop ends, and an in-flight `cancel <group>` / `discard <group>`
    // cannot reach them, and mid-run status queries can't aggregate.
    if (event.runId && (event.type === "run_start" || event.type === "run_done" || event.type === "run_error")) {
      if (!childIds.includes(event.runId)) {
        childIds.push(event.runId);
        await addChildToGroup(repoPath, group.id, event.runId);
      }
      await recomputeGroupStatus(repoPath, group.id);
    }
  }

  await recomputeGroupStatus(repoPath, group.id);

  const mode = request.mode ?? "compare";
  const fanIn = resolveFanInPolicy(request, mode);
  const groupArtifacts = artifactPaths(repoPath, group.id);

  // ---- Fan-in phase: converge the N child results (plan §6/§7). Runs after the
  // child loop drains and before the group's run_done, so run_done carries the
  // fan-in outcome (ready / conflict / partial).
  const fanInStartedMs = Date.now();
  let mergeOutcome: MergeOutcome | undefined;
  if (fanIn.merge !== "none" && (await allChildrenReady(repoPath, group.id, children.length))) {
    yield await recordEvent(groupArtifacts.eventsPath, { type: "fanin_start", runId: group.id, strategy: "merge" });
    mergeOutcome = await mergeSplitChildren(repoPath, group.id, deps, isolation.baseRef, fanIn.merge);
    yield await recordEvent(groupArtifacts.eventsPath, {
      type: "merge_done",
      runId: group.id,
      status: mergeOutcome.status,
      ...(mergeOutcome.conflicts?.length ? { conflicts: mergeOutcome.conflicts.map((c) => c.file) } : {}),
    });
  }

  let judgeOutcome: RunResult["judge"] | undefined;
  // compare: judge ranks the candidates. split: judge vets the merged result (only if merge succeeded).
  if (fanIn.judge && (mode === "compare" || (mode === "split" && mergeOutcome?.status === "ready"))) {
    yield await recordEvent(groupArtifacts.eventsPath, { type: "fanin_start", runId: group.id, strategy: "judge" });
    let judgeRunId: string | undefined;
    for await (const event of runJudgeChild(request, repoPath, group.id, mode, fanIn.judge, context, deps)) {
      if (event.type === "run_start") judgeRunId = event.runId;
      yield event;
    }
    judgeOutcome = await readJudgeOutcome(repoPath, group.id, fanIn.judge.to, judgeRunId);
    yield await recordEvent(groupArtifacts.eventsPath, {
      type: "judge_done",
      runId: group.id,
      ...(judgeOutcome?.recommendedChildId ? { recommendedChildId: judgeOutcome.recommendedChildId } : {}),
      ...(judgeOutcome?.verdict ? { verdict: judgeOutcome.verdict } : {}),
    });
  }

  await finalizeGroup(repoPath, group.id, {
    runStartedMs,
    expectedChildren: children.length,
    mergeOutcome,
    judgeOutcome,
    fanInMs: Date.now() - fanInStartedMs,
    deps,
  });

  const finalGroup = await readJson<Run>(join(repoPath, ".portico", "runs", group.id, "run.json"));
  yield await recordEvent(groupArtifacts.eventsPath, {
    type: "run_done",
    runId: group.id,
    status: finalGroup.status,
    reportPath: groupArtifacts.reportPath,
    resultPath: groupArtifacts.resultPath,
  });
}

function buildChildRequest(
  request: DelegateRequest,
  groupId: string,
  spec: ChildSpec,
  groupTask: string,
  isolation: WorkspaceIsolation,
): DelegateRequest {
  return {
    ...request,
    to: spec.to,
    compareTargets: undefined,
    children: undefined,
    task: spec.task ?? [
      "This is one candidate implementation for a Portico fan-out group run.",
      `Original task: ${groupTask}`,
      "Optimize for a clear, reviewable patch. Another agent may produce a competing patch.",
    ].join("\n"),
    mode: "implement",
    isolation: {
      workspace: "worktree",
      baseRef: isolation.baseRef,
      cleanup: isolation.cleanup,
    },
    permissionProfile: spec.permissionProfile ?? "auto-edit",
    allowedPaths: spec.allowedPaths ?? request.allowedPaths,
    forbiddenPaths: spec.forbiddenPaths ?? request.forbiddenPaths,
  };
}

/**
 * Derive a group run's status from its children's statuses (plan §4 table):
 * - any child still active                          -> running
 * - all ready                                       -> ready
 * - all cancelled                                   -> cancelled
 * - all unsuccessful (failed/cancelled, at least one failed) -> failed
 * - some ready, some not                            -> partial
 */
function deriveGroupStatus(statuses: Run["status"][]): Run["status"] {
  if (statuses.length === 0) return "failed";
  const active = ["created", "planning", "running", "testing", "reviewing"];
  if (statuses.some((s) => active.includes(s))) return "running";
  if (statuses.every((s) => s === "ready")) return "ready";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.every((s) => s === "failed" || s === "cancelled")) return "failed";
  if (statuses.some((s) => s === "ready")) return "partial";
  return "failed";
}

/** Append a child id to the group's childRunIds without clobbering its status. */
async function addChildToGroup(repoPath: string, groupId: string, childId: string): Promise<void> {
  const groupPath = join(repoPath, ".portico", "runs", groupId, "run.json");
  let group: Run;
  try {
    group = await readJson<Run>(groupPath);
  } catch {
    return;
  }
  const childRunIds = group.childRunIds ?? [];
  if (childRunIds.includes(childId)) return;
  await updateRun(group, { childRunIds: [...childRunIds, childId] });
}

async function recomputeGroupStatus(repoPath: string, groupId: string): Promise<void> {
  const groupPath = join(repoPath, ".portico", "runs", groupId, "run.json");
  let group: Run;
  try {
    group = await readJson<Run>(groupPath);
  } catch {
    return;
  }

  const childIds = group.childRunIds ?? [];
  if (childIds.length === 0) return;

  const children: Run[] = [];
  for (const childId of childIds) {
    try {
      children.push(await readJson<Run>(join(repoPath, ".portico", "runs", childId, "run.json")));
    } catch {
      // Child not yet persisted; skip.
    }
  }
  if (children.length === 0) return;

  const newStatus = deriveGroupStatus(children.map((c) => c.status));
  if (group.status !== newStatus) {
    await updateRun(group, { status: newStatus });
  }
}

async function finalizeGroup(
  repoPath: string,
  groupId: string,
  opts: {
    /** Fresh run: stamp telemetry from this start. A re-merge omits it to preserve the prior total. */
    runStartedMs?: number;
    expectedChildren: number;
    mergeOutcome?: MergeOutcome;
    judgeOutcome?: RunResult["judge"];
    /** Wall time spent in the fan-in phase (merge + judge); preserved across a re-merge when omitted. */
    fanInMs?: number;
    /** Orchestrator deps; enables the per-child apply-check against the group base. */
    deps?: DelegationDeps;
  },
): Promise<void> {
  const groupPath = join(repoPath, ".portico", "runs", groupId, "run.json");
  let group: Run;
  try {
    group = await readJson<Run>(groupPath);
  } catch {
    return;
  }

  const childIds = group.childRunIds ?? [];
  const childResults: RunResult[] = [];
  for (const childId of childIds) {
    try {
      childResults.push(await readJson<RunResult>(artifactPaths(repoPath, childId).resultPath));
    } catch {
      // Child may not have produced a result; skip.
    }
  }
  childResults.sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));

  // Account for children that never produced a result (e.g. agent unavailable): count
  // each missing candidate as a failure so the group can't appear "ready" when a
  // candidate never ran. This preserves the Phase 1 gate (childResults vs targets).
  const statuses = childResults.map((r) => r.run.status);
  while (statuses.length < opts.expectedChildren) statuses.push("failed");

  const groupSummary = {
    total: opts.expectedChildren,
    ready: statuses.filter((s) => s === "ready").length,
    failed: statuses.filter((s) => s === "failed").length,
    cancelled: statuses.filter((s) => s === "cancelled").length,
  };

  // A merge conflict overrides the child-derived status; otherwise the group reflects
  // its children (ready / partial / failed). A clean merge keeps the derived "ready".
  const baseStatus = deriveGroupStatus(statuses);
  const finalStatus: RunStatus = opts.mergeOutcome?.status === "conflict" ? "conflict" : baseStatus;

  // Preserve previously-recorded fan-in fields/telemetry across a re-merge.
  const existing = await readResultMaybe(repoPath, groupId);
  const totalDurationMs =
    opts.runStartedMs !== undefined ? Date.now() - opts.runStartedMs : existing?.telemetry?.totalDurationMs ?? 0;
  const merge = opts.mergeOutcome
    ? {
        strategy: opts.mergeOutcome.strategy,
        status: opts.mergeOutcome.status,
        integrationWorktree: opts.mergeOutcome.integrationWorktree,
        ...(opts.mergeOutcome.conflictKind ? { conflictKind: opts.mergeOutcome.conflictKind } : {}),
        ...(opts.mergeOutcome.conflictReason ? { conflictReason: opts.mergeOutcome.conflictReason } : {}),
      }
    : existing?.merge;
  // On a clean merge `conflicts` is undefined → cleared; on conflict it carries the list.
  const conflicts = opts.mergeOutcome ? opts.mergeOutcome.conflicts : existing?.conflicts;
  const judge = opts.judgeOutcome ?? existing?.judge;

  const artifacts = artifactPaths(repoPath, groupId);
  group = await updateRun(group, { status: finalStatus, completedAt: new Date().toISOString() });

  // Proactively record, per child, whether its own patch applies to the group base — the
  // signal `overlap` can't give. Best-effort: only when deps are available (skipped on the
  // status-only refresh path), and attached to each child's embedded result for `review`.
  if (opts.deps) {
    const applyChecks = await computeApplyChecks(repoPath, group, childResults, opts.deps);
    for (const child of childResults) {
      const check = applyChecks.get(child.run.id);
      if (check) child.applyCheck = check;
    }
  }

  const result: RunResult = {
    run: group,
    artifacts,
    changedFiles: [...new Set(childResults.flatMap((r) => r.changedFiles))],
    tests: childResults.flatMap((r) => r.tests),
    agentEvents: [],
    childResults,
    compareResults: childResults,
    groupSummary,
    ...(merge ? { merge } : {}),
    ...(conflicts?.length ? { conflicts } : {}),
    ...(judge ? { judge } : {}),
    telemetry: {
      totalDurationMs,
      agentDurationMs: childResults.reduce((sum, r) => sum + (r.telemetry?.agentDurationMs ?? 0), 0),
      testDurationMs: childResults.reduce((sum, r) => sum + (r.telemetry?.testDurationMs ?? 0), 0),
      ...(childResults.some((r) => r.telemetry?.verifyMs !== undefined)
        ? { verifyMs: childResults.reduce((sum, r) => sum + (r.telemetry?.verifyMs ?? 0), 0) }
        : {}),
      // Fresh run records the measured fan-in time; a re-merge preserves the prior value.
      ...(opts.fanInMs !== undefined
        ? { fanInMs: opts.fanInMs }
        : existing?.telemetry?.fanInMs !== undefined
          ? { fanInMs: existing.telemetry.fanInMs }
          : {}),
      usage: aggregateUsageTelemetry(childResults),
    },
  };
  await writeJson(artifacts.resultPath, result);
  await writeReport(artifacts.reportPath, result);
}

async function readResultMaybe(repoPath: string, id: string): Promise<RunResult | undefined> {
  try {
    return await readJson<RunResult>(artifactPaths(repoPath, id).resultPath);
  } catch {
    return undefined;
  }
}

// ---- Fan-in (merge + judge) ---------------------------------------------------------

interface MergeOutcome {
  strategy: "sequential" | "integration";
  status: "ready" | "conflict";
  conflicts?: Array<{ file: string; child: string; kind?: "overlap" | "apply_failure"; line?: number }>;
  /** Whether the conflict was an inter-child overlap or a single child's patch failing to apply. */
  conflictKind?: "overlap" | "apply_failure";
  /** First meaningful `git apply` stderr line, explaining *why* the merge stopped. */
  conflictReason?: string;
  /** Integration worktree the merge ran in (kept for inspection). */
  integrationWorktree: string;
  /** Path of the merged group diff (only on a clean merge). */
  mergedDiffPath?: string;
}

/**
 * Parse `git apply` stderr into the specific files (and line, when given) that failed to
 * apply, so a plain apply failure reports the real hunk instead of dumping the child's whole
 * file set. Recognizes the common forms git emits:
 *   error: patch failed: path/to/file:42
 *   error: path/to/file: patch does not apply
 *   error: path/to/file: already exists in working directory
 */
function parseApplyFailures(stderr: string): Array<{ file: string; line?: number }> {
  const out: Array<{ file: string; line?: number }> = [];
  const seen = new Set<string>();
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    const failed = /^error: patch failed: (.+):(\d+)$/.exec(line);
    if (failed) {
      const file = failed[1];
      if (file && !seen.has(file)) {
        seen.add(file);
        out.push({ file, line: Number(failed[2]) });
      }
      continue;
    }
    const noApply = /^error: (.+?): (?:patch does not apply|already exists in working directory|does not exist in index|No such file or directory)$/.exec(line);
    const file = noApply?.[1];
    if (file && !seen.has(file)) {
      seen.add(file);
      out.push({ file });
    }
  }
  return out;
}

/** First non-empty `error:`/`fatal:` line of `git apply` stderr — the human-facing reason. */
function firstGitErrorLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith("error:") || l.startsWith("fatal:")) ?? lines[0];
}

function resolveFanInPolicy(
  request: DelegateRequest,
  mode: DelegationMode,
): { merge: "none" | "sequential" | "integration"; judge?: FanInPolicy["judge"] } {
  const merge = request.fanIn?.merge ?? (mode === "split" ? "integration" : "none");
  return { merge, judge: request.fanIn?.judge };
}

/** True only when every expected child has produced a `ready` run. */
async function allChildrenReady(repoPath: string, groupId: string, expected: number): Promise<boolean> {
  let group: Run;
  try {
    group = await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"));
  } catch {
    return false;
  }
  const ids = group.childRunIds ?? [];
  if (ids.length < expected) return false;
  for (const id of ids) {
    try {
      const child = await readJson<Run>(join(repoPath, ".portico", "runs", id, "run.json"));
      if (child.status !== "ready") return false;
    } catch {
      return false;
    }
  }
  return true;
}

function groupConflictsPath(repoPath: string, groupId: string): string {
  return join(repoPath, ".portico", "runs", groupId, "conflicts.json");
}

/**
 * Merge each ready child's diff into a fresh integration worktree from baseRef.
 *
 * All children derive from the same baseRef, so `git apply --3way` can fall back to a
 * three-way merge: mutually-exclusive files stack cleanly; overlapping regions either
 * merge or surface a conflict (non-zero exit + unmerged entries). On conflict we stop,
 * record `conflicts.json`, and leave the markers in the integration worktree for
 * inspection — we never produce a possibly-broken merged patch.
 */
async function mergeSplitChildren(
  repoPath: string,
  groupId: string,
  deps: DelegationDeps,
  baseRefRaw: string | undefined,
  strategy: "sequential" | "integration",
): Promise<MergeOutcome> {
  let group: Run;
  try {
    group = await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"));
  } catch {
    throw new DelegationError("group_missing", `Group run ${groupId} not found for merge.`);
  }

  const contributions: Array<{ run: Run; diffPath: string; changedFiles: string[] }> = [];
  for (const id of group.childRunIds ?? []) {
    try {
      const run = await readJson<Run>(join(repoPath, ".portico", "runs", id, "run.json"));
      const result = await readJson<RunResult>(artifactPaths(repoPath, id).resultPath);
      const diffPath = artifactPaths(repoPath, id).diffPath as string;
      if (run.status === "ready" && existsSync(diffPath)) {
        contributions.push({ run, diffPath, changedFiles: result.changedFiles });
      }
    } catch {
      // Skip children without a usable result.
    }
  }
  contributions.sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));

  const integrationPath = join(repoPath, ".portico", "worktrees", `${groupId}_integration`);
  const branch = `portico/${groupId}-merge`;
  const baseRef = await resolveBaseRef(repoPath, baseRefRaw);

  // Fresh integration worktree every time so a re-merge after a resume starts clean.
  // Removing the worktree leaves the branch behind, so drop it too (no-op on first run)
  // or `git worktree add -b` would fail with "branch already exists".
  await removeWorktree(repoPath, integrationPath, deps.worktreeMutex);
  await capture("git", ["-C", repoPath, "branch", "-D", branch]);
  await createWorktree(repoPath, integrationPath, branch, baseRef, deps.worktreeMutex);

  let conflicts: Array<{ file: string; child: string; kind?: "overlap" | "apply_failure"; line?: number }> = [];
  let conflictKind: "overlap" | "apply_failure" | undefined;
  let conflictReason: string | undefined;
  let failingChild: string | undefined;
  let failingChildBaseRef: string | undefined;
  for (const child of contributions) {
    if (!child.changedFiles.length) continue;
    const applied = await capture("git", ["-C", integrationPath, "apply", "--3way", "--binary", child.diffPath]);
    if (applied.code !== 0) {
      failingChild = child.run.id;
      failingChildBaseRef = child.run.isolation?.baseRef;
      conflictReason = firstGitErrorLine(applied.stderr) ?? `git apply exited ${applied.code}`;
      // Unmerged index entries mean a real three-way overlap; their absence means the child's
      // own patch never applied (drifted context / malformed diff), which we must not report
      // as if every file the child touched conflicted.
      const unmerged = await listUnmergedFiles(integrationPath);
      if (unmerged.length) {
        conflictKind = "overlap";
        conflicts = unmerged.map((file) => ({ file, child: child.run.id, kind: "overlap" as const }));
      } else {
        conflictKind = "apply_failure";
        const failures = parseApplyFailures(applied.stderr);
        const located: Array<{ file: string; line?: number }> = failures.length
          ? failures
          : child.changedFiles[0]
            ? [{ file: child.changedFiles[0] }]
            : [];
        conflicts = located.map((f) => ({ file: f.file, child: child.run.id, kind: "apply_failure" as const, ...(f.line !== undefined ? { line: f.line } : {}) }));
      }
      break; // stop at the first conflicting child; leave markers in place to inspect
    }
  }

  const conflictsPath = groupConflictsPath(repoPath, groupId);
  const groupDiffPath = artifactPaths(repoPath, groupId).diffPath as string;

  if (conflicts.length) {
    await writeJson(conflictsPath, {
      groupId,
      strategy,
      kind: conflictKind,
      failingChild,
      reason: conflictReason,
      groupBaseRef: baseRef,
      childBaseRef: failingChildBaseRef,
      conflicts,
    });
    // Never leave a stale merged patch behind — apply --all must be impossible on conflict.
    if (existsSync(groupDiffPath)) await rm(groupDiffPath, { force: true });
    return { strategy, status: "conflict", conflicts, conflictKind, conflictReason, integrationWorktree: integrationPath };
  }

  const merged = await generateDiff(integrationPath);
  await writeFile(groupDiffPath, merged.diff);
  if (existsSync(conflictsPath)) await rm(conflictsPath, { force: true });
  return { strategy, status: "ready", integrationWorktree: integrationPath, mergedDiffPath: groupDiffPath };
}

/**
 * Per-child "does this child's own patch apply cleanly to the group base?" — the proactive
 * signal that file-name `overlap` can't give: a child can fail to apply on a file only it
 * touched (drifted context / malformed diff), which `overlap: []` never reveals. Each child is
 * checked *independently* against a pristine base worktree (`git apply --check` mutates nothing,
 * so one worktree serves all children). Read-only and best-effort — a check hiccup leaves the
 * child without an applyCheck rather than failing the group.
 */
async function computeApplyChecks(
  repoPath: string,
  group: Run,
  childResults: RunResult[],
  deps: DelegationDeps,
): Promise<Map<string, NonNullable<RunResult["applyCheck"]>>> {
  const out = new Map<string, NonNullable<RunResult["applyCheck"]>>();
  const checkable = childResults.filter(
    (r) => r.changedFiles.length && existsSync(artifactPaths(repoPath, r.run.id).diffPath as string),
  );
  if (!checkable.length) return out;

  const checkPath = join(repoPath, ".portico", "worktrees", `${group.id}_applycheck`);
  const branch = `portico/${group.id}-applycheck`;
  const baseRef = await resolveBaseRef(repoPath, group.isolation.baseRef);
  try {
    // Fresh base worktree (drop any stale one + its branch first, mirroring mergeSplitChildren).
    await removeWorktree(repoPath, checkPath, deps.worktreeMutex);
    await capture("git", ["-C", repoPath, "branch", "-D", branch]);
    await createWorktree(repoPath, checkPath, branch, baseRef, deps.worktreeMutex);
    for (const r of checkable) {
      const diffPath = artifactPaths(repoPath, r.run.id).diffPath as string;
      const res = await capture("git", ["-C", checkPath, "apply", "--check", "--binary", diffPath]);
      if (res.code === 0) {
        out.set(r.run.id, { applies: true });
      } else {
        const failures = parseApplyFailures(res.stderr);
        out.set(r.run.id, {
          applies: false,
          reason: firstGitErrorLine(res.stderr) ?? `git apply --check exited ${res.code}`,
          ...(failures.length ? { failures } : {}),
        });
      }
    }
  } catch {
    // Worktree setup failed — leave applyCheck unset; the group still finalizes.
  } finally {
    await removeWorktree(repoPath, checkPath, deps.worktreeMutex);
    await capture("git", ["-C", repoPath, "branch", "-D", branch]);
  }
  return out;
}

async function listUnmergedFiles(worktreePath: string): Promise<string[]> {
  const result = await capture("git", ["-C", worktreePath, "diff", "--name-only", "--diff-filter=U"]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Re-run the split merge for a group (used after a child resume narrows its changes). */
async function* remergeSplitGroupIfNeeded(
  repoPath: string,
  groupId: string,
  deps: DelegationDeps,
): AsyncIterable<DelegationEvent> {
  let group: Run;
  let task: DelegateRequest;
  try {
    group = await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"));
    task = await readJson<DelegateRequest>(artifactPaths(repoPath, groupId).taskPath);
  } catch {
    return;
  }
  const fanIn = resolveFanInPolicy(task, group.mode);
  if (fanIn.merge === "none") return;

  const expected = group.childRunIds?.length ?? 0;
  const eventsPath = artifactPaths(repoPath, groupId).eventsPath;
  if (!(await allChildrenReady(repoPath, groupId, expected))) {
    // Still incomplete — refresh the group result/status without merging.
    await finalizeGroup(repoPath, groupId, { expectedChildren: expected, deps });
    return;
  }

  yield await recordEvent(eventsPath, { type: "fanin_start", runId: groupId, strategy: "merge" });
  const outcome = await mergeSplitChildren(repoPath, groupId, deps, group.isolation.baseRef, fanIn.merge);
  yield await recordEvent(eventsPath, {
    type: "merge_done",
    runId: groupId,
    status: outcome.status,
    ...(outcome.conflicts?.length ? { conflicts: outcome.conflicts.map((c) => c.file) } : {}),
  });
  await finalizeGroup(repoPath, groupId, { expectedChildren: expected, mergeOutcome: outcome, deps });
}

/** Ready children of a group, in apply order (createdAt), with a usable diff. */
async function readyChildrenInOrder(repoPath: string, groupId: string): Promise<Run[]> {
  let group: Run;
  try {
    group = await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"));
  } catch {
    return [];
  }
  const ready: Run[] = [];
  for (const id of group.childRunIds ?? []) {
    try {
      const child = await readJson<Run>(join(repoPath, ".portico", "runs", id, "run.json"));
      const diffPath = artifactPaths(repoPath, id).diffPath as string;
      if (child.status === "ready" && existsSync(diffPath)) ready.push(child);
    } catch {
      // Skip unreadable children.
    }
  }
  return ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * On-demand merge of a group's *ready* children into a fresh integration worktree.
 *
 * Reuses the split fan-in three-way merge (`mergeSplitChildren`), but unlike the
 * automatic fan-in it does not require every child to be ready — so a partial group
 * (some children failed/cancelled, some resumed to ready) can still be combined. Compare
 * groups are rejected: their children are competing implementations of the same task, so
 * merging them conflicts by design (review with `portico review`, apply one with --child).
 */
async function integrateGroup(repoPath: string, groupId: string, deps: DelegationDeps): Promise<IntegrateResult> {
  const details = await readRunDetails(repoPath, groupId);
  if ((details.run.role ?? "single") !== "group") {
    throw new DelegationError("not_a_group", `Run ${groupId} is not a group run; nothing to integrate.`);
  }
  if (details.run.mode === "compare") {
    throw new DelegationError(
      "integrate_unsupported",
      `Group ${groupId} is a compare group — its children are competing implementations of one task and overlap by design. Review with \`portico review ${groupId}\` and apply one with \`portico apply ${groupId} --child <child_id>\`.`,
    );
  }

  const ready = await readyChildrenInOrder(repoPath, groupId);
  if (ready.length === 0) {
    throw new DelegationError("no_ready_children", `Group ${groupId} has no ready children to integrate.`);
  }

  const eventsPath = artifactPaths(repoPath, groupId).eventsPath;
  await recordEvent(eventsPath, { type: "fanin_start", runId: groupId, strategy: "merge" });
  const outcome = await mergeSplitChildren(repoPath, groupId, deps, details.run.isolation.baseRef, "integration");
  await recordEvent(eventsPath, {
    type: "merge_done",
    runId: groupId,
    status: outcome.status,
    ...(outcome.conflicts?.length ? { conflicts: outcome.conflicts.map((c) => c.file) } : {}),
  });

  const expected = details.run.childRunIds?.length ?? ready.length;
  await finalizeGroup(repoPath, groupId, { expectedChildren: expected, mergeOutcome: outcome, deps });

  const order = ready.map((child) => ({ id: child.id, ...(child.label ? { label: child.label } : {}) }));
  return {
    details: await readRunDetails(repoPath, groupId),
    status: outcome.status,
    order,
    ...(outcome.conflicts?.length ? { conflicts: outcome.conflicts } : {}),
    ...(outcome.mergedDiffPath ? { mergedDiffPath: outcome.mergedDiffPath } : {}),
  };
}

/** Statuses cleanup must never touch — a clean, applicable, or in-flight run. */
const CLEANUP_PROTECTED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "ready",
  "applied",
  "created",
  "planning",
  "running",
  "testing",
  "reviewing",
]);

/**
 * Reclaim finished runs. By default this removes only the worktree and keeps artifacts
 * (report/diff/events) for post-hoc inspection; `purge` removes the whole run directory.
 * ready/applied runs and anything still in-flight are always skipped.
 */
async function cleanupRuns(repoPath: string, opts: CleanupOptions, deps: DelegationDeps): Promise<CleanupResult> {
  const all = await readAllRuns(repoPath);
  const wanted = new Set<RunStatus>(opts.status?.length ? opts.status : ["failed", "cancelled"]);
  const cutoff = opts.olderThanMs !== undefined ? Date.now() - opts.olderThanMs : undefined;

  const cleaned: CleanupResult["cleaned"] = [];
  for (const run of all) {
    if (CLEANUP_PROTECTED.has(run.status)) continue;
    if (!wanted.has(run.status)) continue;
    if (isRunActive(run, deps.activeControllers)) continue;
    if (cutoff !== undefined) {
      const ts = Date.parse(run.completedAt ?? run.updatedAt ?? run.createdAt);
      if (Number.isNaN(ts) || ts > cutoff) continue;
    }

    let worktreeRemoved = false;
    if (run.worktreePath && existsSync(run.worktreePath)) {
      await removeWorktree(repoPath, run.worktreePath, deps.worktreeMutex);
      worktreeRemoved = true;
    }
    if (opts.purge) {
      await rm(join(repoPath, ".portico", "runs", run.id), { recursive: true, force: true });
    } else if (worktreeRemoved) {
      await updateRun(run, { worktreeRemovedAt: new Date().toISOString() });
    }
    cleaned.push({ id: run.id, status: run.status, worktreeRemoved, purged: !!opts.purge });
  }
  return { cleaned, skipped: all.length - cleaned.length };
}

/** Run the judge as a read-only review run over the candidate / merged diffs. */
async function* runJudgeChild(
  request: DelegateRequest,
  repoPath: string,
  groupId: string,
  mode: DelegationMode,
  judge: NonNullable<FanInPolicy["judge"]>,
  context: { findEntry(provider: string): AgentEntry | undefined },
  deps: DelegationDeps,
): AsyncIterable<DelegationEvent> {
  const prompt = await buildJudgePrompt(repoPath, groupId, mode, request.task, judge.instruction);
  const judgeRequest: DelegateRequest = {
    ...request,
    to: judge.to,
    from: "portico-judge",
    compareTargets: undefined,
    children: undefined,
    fanIn: undefined,
    mode: "review",
    isolation: "shared",
    permissionProfile: "read-only",
    task: prompt,
    testCommands: [],
    allowedPaths: undefined,
    forbiddenPaths: undefined,
  };
  // No lineage role/groupId: keep the judge out of the group's childRunIds so it does
  // not skew groupSummary or the folded listing. label only, for navigation.
  yield* runSingleDelegation(judgeRequest, repoPath, context, deps, { label: "judge" });
}

async function buildJudgePrompt(
  repoPath: string,
  groupId: string,
  mode: DelegationMode,
  groupTask: string,
  instruction: string | undefined,
): Promise<string> {
  const lines: string[] = [
    "You are acting as a Portico fan-in judge. This is a read-only review — do not modify any files.",
    `Original task: ${groupTask}`,
    "",
  ];

  if (mode === "split") {
    lines.push(
      "The following is the merged result of complementary sub-tasks. Review it as a whole.",
      `  merged diff: ${artifactPaths(repoPath, groupId).diffPath}`,
      "",
      instruction ?? "Assess whether the merged change correctly and completely implements the task.",
      "",
      'End your response with one line of machine-readable JSON prefixed by `PORTICO_JUDGE:` of the form {"verdict": "approve" | "needs_attention", "ranking": [{"childId": "<id>", "note": "<assessment>"}]}.',
    );
    return lines.join("\n");
  }

  lines.push("Below are competing candidate implementations of the same task. Read each candidate's diff.");
  try {
    const group = await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"));
    for (const id of group.childRunIds ?? []) {
      try {
        const run = await readJson<Run>(join(repoPath, ".portico", "runs", id, "run.json"));
        const result = await readJson<RunResult>(artifactPaths(repoPath, id).resultPath);
        lines.push(
          `candidate ${id} (agent ${run.targetAgent}, status ${run.status}): ${result.changedFiles.length} changed file(s)`,
          `  diff: ${artifactPaths(repoPath, id).diffPath}`,
          `  files: ${result.changedFiles.join(", ") || "none"}`,
        );
      } catch {
        // Skip candidates without a result.
      }
    }
  } catch {
    // No children listed — fall through to the instruction.
  }
  lines.push(
    "",
    instruction ?? "Rank the candidates by task fit, correctness, and maintainability, and recommend exactly one to apply.",
    "",
    'End your response with one line of machine-readable JSON prefixed by `PORTICO_JUDGE:` of the form {"recommendedChildId": "<candidate id>", "ranking": [{"childId": "<id>", "note": "<why>"}], "verdict": "approve"}.',
  );
  return lines.join("\n");
}

async function readJudgeOutcome(
  repoPath: string,
  groupId: string,
  to: string,
  judgeRunId: string | undefined,
): Promise<RunResult["judge"]> {
  if (!judgeRunId) return { to };
  let events: RuntimeEvent[] = [];
  try {
    const result = await readJson<RunResult>(artifactPaths(repoPath, judgeRunId).resultPath);
    events = result.agentEvents ?? [];
  } catch {
    return { to, runId: judgeRunId };
  }
  let validIds: string[] = [];
  try {
    validIds = (await readJson<Run>(join(repoPath, ".portico", "runs", groupId, "run.json"))).childRunIds ?? [];
  } catch {
    // No child id validation available.
  }
  return { to, runId: judgeRunId, ...parseJudgeVerdict(events, validIds) };
}

function parseJudgeVerdict(
  events: RuntimeEvent[],
  validChildIds: string[],
): Pick<NonNullable<RunResult["judge"]>, "recommendedChildId" | "ranking" | "verdict"> {
  const text = events
    .map((event) => (event.type === "content" ? event.delta : event.type === "done" ? event.message ?? "" : ""))
    .join("");
  const marker = text.lastIndexOf("PORTICO_JUDGE:");
  if (marker === -1) return {};
  const json = extractFirstJsonObject(text.slice(marker + "PORTICO_JUDGE:".length));
  if (!json) return {};
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: Pick<NonNullable<RunResult["judge"]>, "recommendedChildId" | "ranking" | "verdict"> = {};
  if (
    typeof obj.recommendedChildId === "string" &&
    (validChildIds.length === 0 || validChildIds.includes(obj.recommendedChildId))
  ) {
    out.recommendedChildId = obj.recommendedChildId;
  }
  if (Array.isArray(obj.ranking)) {
    out.ranking = obj.ranking
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .filter((entry) => typeof entry.childId === "string")
      .map((entry) => ({
        childId: entry.childId as string,
        ...(typeof entry.score === "number" ? { score: entry.score } : {}),
        note: typeof entry.note === "string" ? entry.note : "",
      }));
  }
  if (obj.verdict === "approve" || obj.verdict === "needs_attention") out.verdict = obj.verdict;
  return out;
}

/** Extract the first balanced {...} JSON object from text (tolerant of trailing prose). */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

async function applyChild(repoPath: string, groupId: string, childId: string, allow?: string[]): Promise<RunDetails> {
  const group = await readRunDetails(repoPath, groupId);
  if (!group.run.childRunIds?.includes(childId)) {
    throw new DelegationError("child_not_in_group", `Child run ${childId} does not belong to group ${groupId}.`);
  }

  const child = await readRunDetails(repoPath, childId);
  let pathPolicyOverride: string[] | undefined;
  if (child.run.status !== "ready") {
    const override = allow?.length ? resolvePathPolicyOverride(child.result, allow) : undefined;
    if (!override?.ok) {
      throw new DelegationError(
        "invalid_status",
        allow?.length
          ? `Child run ${childId} is ${child.run.status}, not ready; --allow override does not apply (${override?.reason}).`
          : `Child run ${childId} is ${child.run.status}, not ready.`,
      );
    }
    pathPolicyOverride = allow;
  }
  if (!child.artifacts.diffPath || !existsSync(child.artifacts.diffPath)) {
    throw new DelegationError("missing_diff", `Child run ${childId} does not have a diff.patch artifact.`);
  }

  await assertTrackedTreeClean(repoPath);
  const applied = await capture("git", ["-C", repoPath, "apply", "--binary", child.artifacts.diffPath]);
  if (applied.code !== 0) {
    throw new DelegationError("apply_failed", (applied.stderr || applied.stdout || "git apply failed").trim());
  }

  const now = new Date().toISOString();
  await updateRun(child.run, { status: "applied", completedAt: now });
  await updateRun(group.run, { status: "applied", completedAt: now });
  if (pathPolicyOverride) {
    await writeJson(child.artifacts.resultPath, {
      ...child.result,
      run: { ...child.run, status: "applied", completedAt: now },
      pathPolicyOverride: { allow: pathPolicyOverride, appliedAt: now },
    });
  }

  return readRunDetails(repoPath, childId);
}

/** Apply a group's merged patch (apply-all): lands every ready child's contribution.
 *  Works for split groups (auto-merged at fan-in) and any group merged on demand via
 *  `portico integrate`. Compare groups are rejected — pick one candidate with --child. */
async function applyGroupMerged(repoPath: string, groupId: string): Promise<RunDetails> {
  const group = await readRunDetails(repoPath, groupId);
  if (group.run.mode === "compare") {
    throw new DelegationError(
      "invalid_mode",
      `apply --all does not apply to compare groups; group ${groupId}'s children are competing implementations. Use --child to apply one candidate.`,
    );
  }
  const mergeReady = group.result?.merge?.status === "ready";
  if (group.run.status === "conflict" || group.result?.merge?.status === "conflict") {
    throw new DelegationError(
      "merge_conflict",
      `Group ${groupId} has unresolved merge conflicts. Resolve them (resume a child to shrink its changes, then re-run \`portico integrate ${groupId}\`) before apply --all.`,
    );
  }
  if (group.run.status !== "ready" && !mergeReady) {
    throw new DelegationError(
      "invalid_status",
      `Group ${groupId} is ${group.run.status} and has no merged patch. Run \`portico integrate ${groupId}\` to merge its ready children first.`,
    );
  }
  const diffPath = group.artifacts.diffPath;
  if (!diffPath || !existsSync(diffPath)) {
    throw new DelegationError(
      "missing_diff",
      `Group ${groupId} does not have a merged diff.patch artifact. Run \`portico integrate ${groupId}\` first.`,
    );
  }

  await assertTrackedTreeClean(repoPath);
  const applied = await capture("git", ["-C", repoPath, "apply", "--binary", diffPath]);
  if (applied.code !== 0) {
    throw new DelegationError("apply_failed", (applied.stderr || applied.stdout || "git apply failed").trim());
  }

  const now = new Date().toISOString();
  await updateRun(group.run, { status: "applied", completedAt: now });
  for (const childId of group.run.childRunIds ?? []) {
    try {
      const child = await readRunDetails(repoPath, childId);
      if (child.run.status === "ready") await updateRun(child.run, { status: "applied", completedAt: now });
    } catch {
      // A missing child should not block recording the group as applied.
    }
  }
  return readRunDetails(repoPath, groupId);
}

/** Statuses a run can already be in when cancel is requested — nothing left to salvage. */
const TERMINAL_RUN_STATUSES: RunStatus[] = ["ready", "failed", "applied", "discarded", "cancelled"];

/**
 * Cancel one run: abort its agent process and, if it was still active, salvage whatever
 * diff sits in its worktree right now — same artifact shape (result.json + report.md) the
 * error/timeout path already produces, so a stopped run isn't a total loss. Idempotent:
 * safe to call on an already-terminal run (just re-confirms "cancelled"). Used both for the
 * top-level `cancel(id)` RPC and for each child during a group cancel cascade.
 */
async function cancelAndSalvage(repoPath: string, id: string, deps: DelegationDeps): Promise<Run> {
  deps.activeControllers.get(id)?.abort();
  const details = await readRunDetails(repoPath, id);

  if (TERMINAL_RUN_STATUSES.includes(details.run.status)) {
    if (details.run.status === "cancelled") return details.run;
    const run = await updateRun(details.run, { status: "cancelled", completedAt: new Date().toISOString() });
    await writeJson(details.artifacts.resultPath, { ...details.result, run });
    return run;
  }

  let changedFiles = details.result?.changedFiles ?? [];
  let diffSummary = details.result?.diffSummary;
  if (details.run.mode !== "review") {
    try {
      const workDir = details.run.isolation.workspace === "worktree" ? details.run.worktreePath : repoPath;
      const diffResult = await generateDiff(workDir);
      changedFiles = diffResult.changedFiles;
      diffSummary = diffResult.summary;
      await writeFile(details.artifacts.diffPath as string, diffResult.diff);
    } catch {
      // Worktree may already be gone (or never created yet) — nothing to salvage.
    }
  }

  const run = await updateRun(details.run, { status: "cancelled", completedAt: new Date().toISOString() });
  const task = await readJson<DelegateRequest>(details.artifacts.taskPath);
  const telemetry = buildTelemetry({
    runStartedMs: Date.parse(run.startedAt ?? run.createdAt),
    agentEvents: [],
    testDurationMs: 0,
  });
  const result = attachReviewArtifacts(
    buildRunResult(run, details.artifacts, changedFiles, details.result?.tests ?? [], [], [], telemetry, "Run cancelled by caller."),
    changedFiles,
    task,
    deps.defaultForbidden,
    diffSummary,
    details.result?.verify ?? [],
  );
  await writeJson(details.artifacts.resultPath, result);
  await writeReport(details.artifacts.reportPath, result);
  return run;
}

async function* resumeChildDelegation(
  repoPath: string,
  childId: string,
  task: string,
  context: { findEntry(provider: string): AgentEntry | undefined },
  deps: DelegationDeps,
): AsyncIterable<DelegationEvent> {
  const details = await readRunDetails(repoPath, childId);
  if (!details.run.agentSessionId) {
    throw new DelegationError("resume_unsupported", `Child run ${childId} does not have a stored agent session; the adapter may not support resume.`);
  }
  if (details.run.isolation.workspace === "worktree" && details.run.worktreePath && !existsSync(details.run.worktreePath)) {
    throw new DelegationError("worktree_missing", `Child run ${childId}'s worktree has been cleaned up and cannot be resumed.`);
  }

  const entry = context.findEntry(details.run.targetAgent);
  if (!entry || !entry.available) {
    throw new DelegationError("agent_unavailable", `Target agent "${details.run.targetAgent}" is not available.`);
  }

  // Build a new request from the stored task plus the resume task.
  const taskJson = await readJson<DelegateRequest>(details.artifacts.taskPath);
  const request: DelegateRequest = {
    ...taskJson,
    to: details.run.targetAgent,
    task: `${taskJson.task}\n\n[resume] ${task}`,
    depth: (taskJson.depth ?? 0) + 1,
  };

  const workDir = details.run.isolation.workspace === "worktree" ? details.run.worktreePath : repoPath;

  // Re-run agent in the existing worktree, capturing new events.
  const controller = new AbortController();
  deps.activeControllers.set(childId, controller);
  let agentEvents: RuntimeEvent[] = [];
  let tests: TestResult[] = [];
  let verify: TestResult[] = [];
  let changedFiles: string[] = [];
  let diffSummary: DiffSummary | undefined;
  let runStartedMs = Date.now();
  let agentDurationMs: number | undefined;
  let diffMs: number | undefined;
  let testDurationMs = 0;
  let verifyDurationMs = 0;

  try {
    yield await recordEvent(details.artifacts.eventsPath, { type: "agent_start", runId: childId, agent: details.run.targetAgent });

    const chat: ChatRequest = {
      provider: details.run.targetAgent,
      messages: [{ role: "user", content: buildDelegationPrompt(details.run, request, deps.defaultForbidden) }],
      options: {
        cwd: workDir,
        timeoutMs: request.timeoutMs,
        autoEdit: details.run.permissionProfile === "auto-edit",
      },
    };

    const agentStartedMs = Date.now();
    let capturedSessionId: string | undefined;
    const agentIterable = withIdleWatchdog(
      runAgent(chat, {
        entry,
        signal: controller.signal,
        env: { ...process.env, PORTICO_DELEGATION_DEPTH: String((details.run.depth ?? 0) + 1) },
        resumeSessionId: details.run.agentSessionId,
        onAgentSession: (id) => {
          capturedSessionId = id;
        },
      }),
      request.idleTimeoutMs
    );
    for await (const event of agentIterable) {
      if (capturedSessionId && capturedSessionId !== details.run.agentSessionId) {
        details.run = await updateRun(details.run, { agentSessionId: capturedSessionId });
        capturedSessionId = undefined;
      }
      agentEvents.push(event);
      await appendFile(details.artifacts.agentLogPath, encodeEvent(event));
      yield await recordEvent(details.artifacts.eventsPath, { type: "agent_event", runId: childId, event });
      if (event.type === "error") throw new DelegationError(event.code ?? "agent_failed", event.error);
    }
    agentDurationMs = Date.now() - agentStartedMs;

    if (details.run.mode !== "review") {
      const diffStartedMs = Date.now();
      const diffResult = await generateDiff(workDir);
      diffMs = Date.now() - diffStartedMs;
      changedFiles = diffResult.changedFiles;
      diffSummary = diffResult.summary;
      await writeFile(details.artifacts.diffPath as string, diffResult.diff);
      enforcePathPolicy(changedFiles, request, deps.defaultForbidden);
      yield await recordEvent(details.artifacts.eventsPath, {
        type: "diff_ready",
        runId: childId,
        path: details.artifacts.diffPath as string,
        changedFiles,
      });

      for (const command of request.testCommands ?? []) {
        yield await recordEvent(details.artifacts.eventsPath, { type: "test_start", runId: childId, command });
        const result = await runTestCommand(workDir, command, request.testTimeoutMs);
        tests.push(result);
        testDurationMs += result.durationMs ?? 0;
        await appendFile(
          details.artifacts.testLogPath as string,
          `$ ${command}\n${result.output}\n[exit ${result.exitCode ?? "null"}]\n\n`,
        );
        yield await recordEvent(details.artifacts.eventsPath, {
          type: "test_done",
          runId: childId,
          command,
          status: result.status,
          exitCode: result.exitCode,
        });
      }
      for (const command of request.verifyCommands ?? []) {
        yield await recordEvent(details.artifacts.eventsPath, { type: "test_start", runId: childId, command });
        const result = await runTestCommand(workDir, command, request.testTimeoutMs);
        verify.push(result);
        verifyDurationMs += result.durationMs ?? 0;
        await appendFile(
          details.artifacts.testLogPath as string,
          `$ [verify] ${command}\n${result.output}\n[exit ${result.exitCode ?? "null"}]\n\n`,
        );
        yield await recordEvent(details.artifacts.eventsPath, {
          type: "test_done",
          runId: childId,
          command,
          status: result.status,
          exitCode: result.exitCode,
        });
      }
    }

    const failedTest = [...tests, ...verify].find((check) => check.status === "failed");
    const newStatus = failedTest ? "failed" : "ready";
    const updatedRun = await updateRun(details.run, {
      status: newStatus,
      completedAt: new Date().toISOString(),
    });

    const result = attachReviewArtifacts(
      buildRunResult(
        updatedRun,
        details.artifacts,
        changedFiles,
        tests,
        agentEvents,
        [],
        buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, diffMs, testDurationMs, verifyDurationMs }),
      ),
      changedFiles,
      request,
      deps.defaultForbidden,
      diffSummary,
      verify,
    );
    await writeJson(details.artifacts.resultPath, result);
    await writeReport(details.artifacts.reportPath, result);
    yield await recordEvent(details.artifacts.eventsPath, {
      type: "run_done",
      runId: childId,
      status: newStatus,
      reportPath: details.artifacts.reportPath,
      resultPath: details.artifacts.resultPath,
      verdict: buildRunVerdict(updatedRun, result),
    });

    // Recompute parent group, then re-run the split fan-in merge so a narrowed child
    // can close a prior conflict (plan §6.3.4 / §12.2.4). A re-merge hiccup must not
    // fail the (already successful) child, so it is guarded.
    if (details.run.groupId) {
      await recomputeGroupStatus(repoPath, details.run.groupId);
      try {
        yield* remergeSplitGroupIfNeeded(repoPath, details.run.groupId, deps);
      } catch {
        // Leave the child ready; the group keeps its child-derived status.
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = err instanceof DelegationError ? err.code : "internal";
    if (details.run.mode !== "review") {
      try {
        const diffStartedMs = Date.now();
        const diffResult = await generateDiff(workDir);
        diffMs = Date.now() - diffStartedMs;
        changedFiles = diffResult.changedFiles;
        diffSummary = diffResult.summary;
        await writeFile(details.artifacts.diffPath as string, diffResult.diff);
      } catch (diffErr) {
        // ignore diff error on failure path
      }
    }
    details.run = await updateRun(details.run, {
      status: controller.signal.aborted ? "cancelled" : "failed",
      completedAt: new Date().toISOString(),
    });
    const result = attachReviewArtifacts(
      buildRunResult(
        details.run,
        details.artifacts,
        changedFiles,
        tests,
        agentEvents,
        [],
        buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, diffMs, testDurationMs, verifyDurationMs }),
        error,
      ),
      changedFiles,
      request,
      deps.defaultForbidden,
      diffSummary,
      verify,
    );
    await writeJson(details.artifacts.resultPath, result);
    await writeReport(details.artifacts.reportPath, result);
    yield await recordEvent(details.artifacts.eventsPath, { type: "run_error", runId: childId, error, code });
    if (details.run.groupId) {
      await recomputeGroupStatus(repoPath, details.run.groupId);
    }
  } finally {
    controller.abort();
    deps.activeControllers.delete(childId);
  }
}

// ---- Run helpers (shared) -----------------------------------------------------------

/** Read and date-sort every persisted run.json under .portico/runs. */
async function readAllRuns(repoPath: string): Promise<Run[]> {
  const dir = join(repoPath, ".portico", "runs");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson<Run>(join(dir, entry.name, "run.json")).catch(() => undefined)),
  );
  return runs.filter((run): run is Run => !!run).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "created",
  "planning",
  "running",
  "testing",
  "reviewing",
]);

/** True when a run has a live agent controller (or, for a group, any child does). */
function isRunActive(run: Run, controllers: Map<string, AbortController>): boolean {
  if (controllers.has(run.id)) return true;
  return (run.childRunIds ?? []).some((childId) => controllers.has(childId));
}

/** Attach transient listing fields (parallels foldRuns' `_children`): `_active`, plus — for an
 *  in-flight run — `_lastEventAt` (the event log's mtime) so `watch` can surface silence/staleness
 *  without each row needing a getRun. The stat is bounded to active runs to keep listing cheap. */
async function annotateRun(run: Run, controllers: Map<string, AbortController>, repoPath: string): Promise<Run> {
  const rec = run as unknown as Record<string, unknown>;
  const active = isRunActive(run, controllers);
  rec["_active"] = active;
  if (active || ACTIVE_STATUSES.has(run.status)) {
    try {
      rec["_lastEventAt"] = (await stat(artifactPaths(repoPath, run.id).eventsPath)).mtime.toISOString();
    } catch {
      // No event log yet — omit; the board falls back to updatedAt.
    }
  }
  return run;
}

/** Compute live progress (phase, active, last event) for a single run details record. */
async function computeProgress(
  details: RunDetails,
  controllers: Map<string, AbortController>,
): Promise<RunProgress> {
  const { run, artifacts } = details;
  const active = isRunActive(run, controllers) || ACTIVE_STATUSES.has(run.status);
  let lastEvent: RunProgress["lastEvent"];
  try {
    const text = await readFile(artifacts.eventsPath, "utf8");
    const last = text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    if (last) {
      const parsed = JSON.parse(last) as DelegationEvent;
      const at = (await stat(artifacts.eventsPath)).mtime.toISOString();
      lastEvent = { type: parsed.type, at };
    }
  } catch {
    // No event log yet (or unreadable) — omit lastEvent.
  }
  return { phase: run.status, active, ...(lastEvent ? { lastEvent } : {}) };
}

function foldRuns(runs: Run[]): Run[] {
  const groupMap = new Map<string, Run>();
  const childMap = new Map<string, Run[]>();
  const singles: Run[] = [];

  for (const run of runs) {
    const role = run.role ?? "single";
    if (role === "group") {
      groupMap.set(run.id, run);
      if (!childMap.has(run.id)) childMap.set(run.id, []);
    } else {
      singles.push(run);
    }
  }

  // Attach children to their groups.
  for (const run of singles) {
    if (run.groupId && groupMap.has(run.groupId)) {
      childMap.get(run.groupId)?.push(run);
    }
  }

  // Produce folded output: groups first (with children inline), then orphan singles.
  const result: Run[] = [];
  for (const group of groupMap.values()) {
    const children = childMap.get(group.id) ?? [];
    children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    (group as unknown as Record<string, unknown>)["_children"] = children;
    result.push(group);
  }
  for (const run of singles) {
    if (!run.groupId || !groupMap.has(run.groupId)) {
      result.push(run);
    }
  }
  result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

// Legacy alias — old code path kept for comparison.


async function* runSingleDelegation(
  request: DelegateRequest,
  repoPath: string,
  context: { findEntry(provider: string): AgentEntry | undefined },
  deps: DelegationDeps,
  lineage?: {
    role?: RunRole;
    groupId?: string;
    parentRunId?: string;
    label?: string;
  },
): AsyncIterable<DelegationEvent> {
  let run: Run | undefined;
  let controller: AbortController | undefined;
  let artifacts: RunArtifact | undefined;
  let worktreeCreated = false;
  let outOfTreeChanges: OutOfTreeChange[] = [];
  let agentEvents: RuntimeEvent[] = [];
  let tests: TestResult[] = [];
  let verify: TestResult[] = [];
  let changedFiles: string[] = [];
  let diffSummary: DiffSummary | undefined;
  let runStartedMs = Date.now();
  let agentDurationMs: number | undefined;
  let worktreeSetupMs: number | undefined;
  let diffMs: number | undefined;
  let testDurationMs = 0;
  let verifyDurationMs = 0;

  try {
    const mode = request.mode ?? "implement";
    if (mode === "compare") throw new DelegationError("bad_request", "runSingleDelegation cannot run compare mode.");
    const entry = context.findEntry(request.to);
    if (!entry || !entry.available) {
      throw new DelegationError("agent_unavailable", `Target agent "${request.to}" is not available.`);
    }

    const isolation = normalizeIsolation(request, mode);
    const permissionProfile = normalizePermissionProfile(request, mode, isolation.workspace);
    validateExecutionPolicy(mode, isolation, permissionProfile);

    const now = new Date().toISOString();
    runStartedMs = Date.now();
    const id = newRunId(now);
    const worktreePath =
      isolation.workspace === "worktree" ? join(repoPath, ".portico", "worktrees", id) : repoPath;
    run = createRun(repoPath, request, {
      id,
      targetAgent: request.to,
      mode,
      isolation,
      permissionProfile,
      worktreePath,
      ...(lineage?.role ? { role: lineage.role } : {}),
      ...(lineage?.groupId ? { groupId: lineage.groupId } : {}),
      ...(lineage?.parentRunId ? { parentRunId: lineage.parentRunId } : {}),
      ...(lineage?.label ? { label: lineage.label } : {}),
    });
    artifacts = artifactPaths(repoPath, id);

    await mkdir(dirname(artifacts.taskPath), { recursive: true });
    await writeJson(artifacts.taskPath, { ...request, repo: repoPath, isolation, permissionProfile });
    await saveRun(run);
    await writeFile(artifacts.eventsPath, "");
    yield await recordEvent(artifacts.eventsPath, { type: "run_start", runId: run.id, status: run.status });

    run = await updateRun(run, { status: "planning", startedAt: new Date().toISOString() });
    const workspaceSnapshot = isolation.workspace === "shared" ? await captureStatus(repoPath) : undefined;
    if (isolation.workspace === "worktree") {
      const worktreeStartedMs = Date.now();
      const baseRef = await resolveBaseRef(repoPath, isolation.baseRef);
      await createWorktree(repoPath, worktreePath, run.branchName, baseRef, deps.worktreeMutex);
      worktreeSetupMs = Date.now() - worktreeStartedMs;
      worktreeCreated = true;
      yield await recordEvent(artifacts.eventsPath, {
        type: "worktree_created",
        runId: run.id,
        path: worktreePath,
        branch: run.branchName,
      });
    } else if (mode === "implement" && permissionProfile === "auto-edit") {
      await assertWorkspaceClean(repoPath);
    }
    const mainWorkspaceSnapshot =
      isolation.workspace === "worktree" ? await captureMainWorkspaceSnapshot(repoPath) : undefined;

    run = await updateRun(run, { status: mode === "review" ? "reviewing" : "running" });
    yield await recordEvent(artifacts.eventsPath, { type: "agent_start", runId: run.id, agent: request.to });
    controller = new AbortController();
    deps.activeControllers.set(run.id, controller);

    const workDir = isolation.workspace === "worktree" ? worktreePath : repoPath;
    const chat: ChatRequest = {
      provider: request.to,
      messages: [{ role: "user", content: buildDelegationPrompt(run, request, deps.defaultForbidden) }],
      options: {
        cwd: workDir,
        timeoutMs: request.timeoutMs,
        autoEdit: permissionProfile === "auto-edit",
      },
    };

    const agentStartedMs = Date.now();
    let capturedSessionId: string | undefined;
    const agentIterable = withIdleWatchdog(
      runAgent(chat, {
        entry,
        signal: controller.signal,
        env: { ...process.env, PORTICO_DELEGATION_DEPTH: String(run.depth + 1) },
        onAgentSession: (id) => {
          capturedSessionId = id;
        },
      }),
      request.idleTimeoutMs
    );
    for await (const event of agentIterable) {
      if (capturedSessionId && !run.agentSessionId) {
        run = await updateRun(run, { agentSessionId: capturedSessionId });
        capturedSessionId = undefined;
      }
      agentEvents.push(event);
      await appendFile(artifacts.agentLogPath, encodeEvent(event));
      yield await recordEvent(artifacts.eventsPath, { type: "agent_event", runId: run.id, event });
      if (event.type === "error") throw new DelegationError(event.code ?? "agent_failed", event.error);
    }
    agentDurationMs = Date.now() - agentStartedMs;

    if (mainWorkspaceSnapshot) {
      const mainWorkspaceAfter = await captureMainWorkspaceSnapshot(repoPath);
      outOfTreeChanges = diffMainWorkspaceSnapshot(mainWorkspaceSnapshot, mainWorkspaceAfter);
      if (outOfTreeChanges.length) {
        yield await recordEvent(artifacts.eventsPath, {
          type: "sandbox_escape_detected",
          runId: run.id,
          changes: outOfTreeChanges,
        });
      }
    }

    if (mode === "review") {
      if (workspaceSnapshot !== undefined) await assertStatusUnchanged(repoPath, workspaceSnapshot);
      await writeFile(artifacts.diffPath as string, "");
      run = await updateRun(run, { status: "ready", completedAt: new Date().toISOString() });
      const result: RunResult = buildRunResult(
        run,
        artifacts,
        [],
        [],
        agentEvents,
        outOfTreeChanges,
        buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, worktreeSetupMs, diffMs, testDurationMs, verifyDurationMs }),
      );
      await writeJson(artifacts.resultPath, result);
      await writeReport(artifacts.reportPath, result);
      yield await recordEvent(artifacts.eventsPath, {
        type: "run_done",
        runId: run.id,
        status: run.status,
        reportPath: artifacts.reportPath,
        resultPath: artifacts.resultPath,
        verdict: buildRunVerdict(run, result),
      });
      return;
    }

    const diffStartedMs = Date.now();
    const diffResult = await generateDiff(workDir);
    diffMs = Date.now() - diffStartedMs;
    changedFiles = diffResult.changedFiles;
    diffSummary = diffResult.summary;
    await writeFile(artifacts.diffPath as string, diffResult.diff);
    enforcePathPolicy(changedFiles, request, deps.defaultForbidden);
    yield await recordEvent(artifacts.eventsPath, {
      type: "diff_ready",
      runId: run.id,
      path: artifacts.diffPath as string,
      changedFiles,
    });
    if ((run.role ?? "single") === "single") {
      const interimResult = attachReviewArtifacts(
        buildRunResult(
          run,
          artifacts,
          changedFiles,
          [],
          agentEvents,
          outOfTreeChanges,
          buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, worktreeSetupMs, diffMs, testDurationMs: 0, verifyDurationMs: 0 }),
        ),
        changedFiles,
        request,
        deps.defaultForbidden,
        diffSummary,
        [],
      );
      yield await recordEvent(artifacts.eventsPath, {
        type: "verdict_update",
        runId: run.id,
        verdict: buildRunVerdict(run, interimResult),
      });
    }

    run = await updateRun(run, { status: "testing" });
    for (const command of request.testCommands ?? []) {
      yield await recordEvent(artifacts.eventsPath, { type: "test_start", runId: run.id, command });
      const result = await runTestCommand(workDir, command, request.testTimeoutMs);
      tests.push(result);
      testDurationMs += result.durationMs ?? 0;
      await appendFile(
        artifacts.testLogPath as string,
        `$ ${command}\n${result.output}\n[exit ${result.exitCode ?? "null"}]\n\n`,
      );
      yield await recordEvent(artifacts.eventsPath, {
        type: "test_done",
        runId: run.id,
        command,
        status: result.status,
        exitCode: result.exitCode,
      });
    }
    for (const command of request.verifyCommands ?? []) {
      yield await recordEvent(artifacts.eventsPath, { type: "test_start", runId: run.id, command });
      const result = await runTestCommand(workDir, command, request.timeoutMs);
      verify.push(result);
      verifyDurationMs += result.durationMs ?? 0;
      await appendFile(
        artifacts.testLogPath as string,
        `$ [verify] ${command}\n${result.output}\n[exit ${result.exitCode ?? "null"}]\n\n`,
      );
      yield await recordEvent(artifacts.eventsPath, {
        type: "test_done",
        runId: run.id,
        command,
        status: result.status,
        exitCode: result.exitCode,
      });
    }

    const failedCheck = [...tests, ...verify].find((check) => check.status === "failed");
    run = await updateRun(run, {
      status: failedCheck || outOfTreeChanges.length ? "failed" : "ready",
      completedAt: new Date().toISOString(),
    });
    if (worktreeCreated && shouldCleanupWorktree(isolation.cleanup, run.status, changedFiles)) {
      await removeWorktree(repoPath, worktreePath, deps.worktreeMutex);
      run = await updateRun(run, { worktreeRemovedAt: new Date().toISOString() });
    }
    const result = attachReviewArtifacts(
      buildRunResult(
        run,
        artifacts,
        changedFiles,
        tests,
        agentEvents,
        outOfTreeChanges,
        buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, worktreeSetupMs, diffMs, testDurationMs, verifyDurationMs }),
      ),
      changedFiles,
      request,
      deps.defaultForbidden,
      diffSummary,
      verify,
    );
    await writeJson(artifacts.resultPath, result);
    await writeReport(artifacts.reportPath, result);
    yield await recordEvent(artifacts.eventsPath, {
      type: "run_done",
      runId: run.id,
      status: run.status,
      reportPath: artifacts.reportPath,
      resultPath: artifacts.resultPath,
      verdict: buildRunVerdict(run, result),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = err instanceof DelegationError ? err.code : "internal";
    if (run && artifacts) {
      const status = controller?.signal.aborted ? "cancelled" : "failed";
      run = await updateRun(run, { status, completedAt: new Date().toISOString() });
      if (run.mode !== "review") {
        try {
          const diffStartedMs = Date.now();
          const workDir = run.isolation.workspace === "worktree" ? run.worktreePath : repoPath;
          const diffResult = await generateDiff(workDir);
          diffMs = Date.now() - diffStartedMs;
          changedFiles = diffResult.changedFiles;
          diffSummary = diffResult.summary;
          await writeFile(artifacts.diffPath as string, diffResult.diff);
        } catch (diffErr) {
          // ignore diff error on failure path
        }
      }
      if (worktreeCreated && shouldCleanupWorktree(run.isolation.cleanup, run.status, changedFiles)) {
        await removeWorktree(repoPath, run.worktreePath, deps.worktreeMutex);
        run = await updateRun(run, { worktreeRemovedAt: new Date().toISOString() });
      }
      const result = attachReviewArtifacts(
        buildRunResult(
          run,
          artifacts,
          changedFiles,
          tests,
          agentEvents,
          outOfTreeChanges,
          buildTelemetry({ runStartedMs, agentEvents, agentDurationMs, worktreeSetupMs, diffMs, testDurationMs, verifyDurationMs }),
          error,
        ),
        changedFiles,
        request,
        deps.defaultForbidden,
        diffSummary,
        verify,
      );
      await writeJson(artifacts.resultPath, result);
      await writeReport(artifacts.reportPath, result);
      yield await recordEvent(artifacts.eventsPath, {
        type: "run_error",
        runId: run.id,
        error,
        code,
        status: run.status,
        reportPath: artifacts.reportPath,
        resultPath: artifacts.resultPath,
        verdict: buildRunVerdict(run, result),
      });
    } else {
      yield { type: "run_error", error, code };
    }
  } finally {
    // If a consumer breaks out of the merged stream (cancellation), this generator
    // is returned mid-run: abort defensively so the agent process is terminated
    // instead of orphaned. On the normal path the run is already done, so this is a no-op.
    controller?.abort();
    if (run) deps.activeControllers.delete(run.id);
  }
}

function buildRunResult(
  run: Run,
  artifacts: RunArtifact,
  changedFiles: string[],
  tests: TestResult[],
  agentEvents: RuntimeEvent[],
  outOfTreeChanges: OutOfTreeChange[],
  telemetry: RunTelemetry,
  error?: string,
): RunResult {
  const sandboxEscaped = outOfTreeChanges.length > 0;
  const agentGateMismatch = run.status === "failed" && agentClaimedSuccess(agentEvents);
  const gateWarnings: string[] = [];
  if (sandboxEscaped) {
    gateWarnings.push("Sandbox escape detected: the delegate changed files outside the Portico worktree.");
  }
  if (agentGateMismatch) {
    gateWarnings.push(
      sandboxEscaped
        ? "Agent claimed success but Portico gate failed; it likely wrote outside the sandbox."
        : "Agent claimed success but Portico gate failed.",
    );
  }
  // No-change in implement mode is usually a non-result for an edit task — flag it unless the
  // caller declared it acceptable (`--expect-no-changes`) or this is a review/check run. Gating
  // on the structured `mode`, never on sniffing task verbs (free-text, multi-line, often Chinese).
  const noChangeNeedsAttention =
    run.mode === "implement" && run.status === "ready" && changedFiles.length === 0 && !run.expectNoChanges;
  if (noChangeNeedsAttention) {
    gateWarnings.push("Agent completed successfully but produced no file changes.");
  }
  // Coverage: path policy guards the boundary (no out-of-scope edits); coverage guards
  // completeness (every declared path was actually changed). A gap on a ready implement run
  // is suspect — the run may have skipped part of the task.
  const coverage = evaluateCoverage(changedFiles, run.expectedChangePaths);
  const coverageGap = !!coverage && run.mode === "implement" && run.status === "ready" && coverage.untouched.length > 0;
  if (coverageGap) {
    gateWarnings.push(`Coverage gap: expected path(s) not changed: ${coverage.untouched.join(", ")}.`);
  }
  if (error && changedFiles.length > 0) {
    const reason = run.status === "cancelled" ? "was cancelled" : "errored/timed out";
    gateWarnings.push(`Agent ${reason} but left ${changedFiles.length} uncommitted file(s) in the worktree (partial work — review or resume).`);
  }
  // Portico's own verdict, derived from observed facts rather than the agent's self-report:
  // not-ready or ready-but-suspect (a flagged no-change run / coverage gap) → needs_attention.
  const reviewDecision: "approve" | "needs_attention" =
    run.status === "ready" && !noChangeNeedsAttention && !coverageGap ? "approve" : "needs_attention";
  return {
    run,
    artifacts,
    changedFiles,
    tests,
    agentEvents,
    ...(sandboxEscaped ? { sandboxEscaped, outOfTreeChanges } : {}),
    ...(agentGateMismatch ? { agentGateMismatch } : {}),
    ...(gateWarnings.length ? { gateWarnings } : {}),
    reviewDecision,
    ...(coverage ? { coverage } : {}),
    telemetry,
    ...(error ? { error } : {}),
  };
}

/** Attach review artifacts (path-policy outcome + grouped diff views) to a result.
 *  Kept out of buildRunResult so the policy config doesn't have to thread through it. */
function attachReviewArtifacts(
  result: RunResult,
  changedFiles: string[],
  request: DelegateRequest,
  defaultForbidden: string[],
  diffSummary: DiffSummary | undefined,
  verify: TestResult[],
): RunResult {
  result.pathPolicy = evaluatePathPolicy(changedFiles, request, defaultForbidden);
  if (diffSummary) result.diffSummary = diffSummary;
  if (verify.length) result.verify = verify;
  return result;
}

/** Assemble a RunTelemetry from captured phase timers, omitting buckets that weren't measured
 *  (e.g. worktree setup on a resume, verify when no `--verify` ran). Keeps the ~6 call sites
 *  in the single/child run paths consistent. */
function buildTelemetry(opts: {
  runStartedMs: number;
  agentEvents: RuntimeEvent[];
  agentDurationMs?: number;
  worktreeSetupMs?: number;
  diffMs?: number;
  testDurationMs: number;
  verifyDurationMs?: number;
}): RunTelemetry {
  return {
    totalDurationMs: Date.now() - opts.runStartedMs,
    ...(opts.agentDurationMs !== undefined ? { agentDurationMs: opts.agentDurationMs } : {}),
    ...(opts.worktreeSetupMs !== undefined ? { worktreeSetupMs: opts.worktreeSetupMs } : {}),
    ...(opts.diffMs !== undefined ? { diffMs: opts.diffMs } : {}),
    testDurationMs: opts.testDurationMs,
    ...(opts.verifyDurationMs ? { verifyMs: opts.verifyDurationMs } : {}),
    usage: extractUsageTelemetry(opts.agentEvents),
  };
}

function extractUsageTelemetry(events: RuntimeEvent[]): RunTelemetry["usage"] {
  const done = [...events].reverse().find((event) => event.type === "done" && event.usage !== undefined);
  if (!done || done.type !== "done" || done.usage === undefined) {
    return {
      available: false,
      unavailableReason: "agent did not report token or cost usage",
    };
  }

  const raw = done.usage;
  return {
    available: true,
    raw,
    ...extractTokenAndCostFields(raw),
  };
}

function aggregateUsageTelemetry(results: RunResult[]): RunTelemetry["usage"] {
  const usages = results.map((result) => result.telemetry?.usage).filter((usage) => usage?.available);
  if (!usages.length) {
    return {
      available: false,
      unavailableReason: "child agents did not report token or cost usage",
    };
  }
  const sum = (key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd") =>
    usages.some((usage) => usage?.[key] !== undefined)
      ? usages.reduce((total, usage) => total + (usage?.[key] ?? 0), 0)
      : undefined;
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const totalTokens = sum("totalTokens");
  const costUsd = sum("costUsd");
  return {
    available: true,
    raw: usages.map((usage) => usage?.raw),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function extractTokenAndCostFields(value: unknown): Omit<RunTelemetry["usage"], "available" | "raw" | "unavailableReason"> {
  const fields = flattenNumericUsageFields(value);
  const firstNumber = (...keys: string[]) => {
    for (const key of keys) {
      const found = fields.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const inputTokens = firstNumber("input_tokens", "prompt_tokens", "inputtokens", "prompttokens");
  const outputTokens = firstNumber(
    "output_tokens",
    "completion_tokens",
    "outputtokens",
    "completiontokens",
    "generated_tokens",
  );
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(firstNumber("total_tokens", "totaltokens") !== undefined
      ? { totalTokens: firstNumber("total_tokens", "totaltokens") }
      : inputTokens !== undefined || outputTokens !== undefined
        ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
        : {}),
    ...(firstNumber("cost_usd", "total_cost_usd", "costusd", "totalcostusd") !== undefined
      ? { costUsd: firstNumber("cost_usd", "total_cost_usd", "costusd", "totalcostusd") }
      : {}),
  };
}

function flattenNumericUsageFields(value: unknown, prefix = "", out = new Map<string, number>()): Map<string, number> {
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeUsageKey(prefix ? `${prefix}_${key}` : key);
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out.set(normalized, raw);
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      flattenNumericUsageFields(raw, normalized, out);
    }
  }
  return out;
}

function normalizeUsageKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

/** The agent's final assistant message — the `done` event's message, else trailing content
 *  deltas. Used to surface a no-change run's stated reason (clearly labeled unverified). */
function extractAgentFinalMessage(events: RuntimeEvent[]): string | undefined {
  const done = [...events].reverse().find((event) => event.type === "done");
  if (done && done.type === "done" && done.message?.trim()) {
    const message = done.message.trim();
    return message.length > 600 ? `${message.slice(0, 597)}...` : message;
  }
  const content = events
    .map((event) => (event.type === "content" ? event.delta : ""))
    .join("")
    .trim();
  if (!content) return undefined;
  return content.length > 600 ? `${content.slice(0, 597)}...` : content;
}

function agentClaimedSuccess(events: RuntimeEvent[]): boolean {
  const text = events
    .map((event) => {
      if (event.type === "content") return event.delta;
      if (event.type === "done") return event.message;
      return "";
    })
    .join("\n")
    .toLowerCase();
  return /\b(success|succeeded|successful|complete|completed|done|all[_ -]?[a-z0-9_ -]*present)\b/.test(text)
    || /成功|完成|已完成|就位|均已|全部/.test(text);
}

async function readDefaultTestCommands(repoPath: string): Promise<string[]> {
  try {
    const config = JSON.parse(await readFile(join(repoPath, ".portico", "config.json"), "utf8")) as {
      testCommands?: unknown;
    };
    if (Array.isArray(config.testCommands)) {
      return config.testCommands.filter((command): command is string => typeof command === "string" && command.length > 0);
    }
  } catch {
    return [];
  }
  return [];
}

/** Pure evaluation of the path boundary — used both to gate the run and to record
 *  the outcome (with retry paths) in the result/report. */
function evaluatePathPolicy(
  changedFiles: string[],
  request: DelegateRequest,
  defaultForbidden: string[],
): PathPolicyResult {
  const forbiddenPatterns = [...defaultForbidden, ...(request.forbiddenPaths ?? [])];
  const forbidden = changedFiles.filter((file) => forbiddenPatterns.some((pattern) => matchesPathPattern(file, pattern)));
  const notAllowed = request.allowedPaths?.length
    ? changedFiles.filter((file) => !request.allowedPaths?.some((pattern) => matchesPathPattern(file, pattern)))
    : [];
  const retryAllowed = [...new Set([...forbidden, ...notAllowed])];
  return {
    status: retryAllowed.length ? "failed" : "passed",
    allowed: request.allowedPaths ?? [],
    forbidden,
    notAllowed,
    ...(retryAllowed.length ? { retryAllowed } : {}),
  };
}

/** Pure evaluation of `--expected-change` coverage: which declared patterns were touched, which
 *  were left untouched (gaps), and which changed files were unexpected. Returns undefined when
 *  the caller declared no expectations (coverage is opt-in). */
function evaluateCoverage(changedFiles: string[], expected: string[] | undefined): CoverageResult | undefined {
  if (!expected?.length) return undefined;
  const touched = expected.filter((pattern) => changedFiles.some((file) => matchesPathPattern(file, pattern)));
  const untouched = expected.filter((pattern) => !touched.includes(pattern));
  const unexpected = changedFiles.filter((file) => !expected.some((pattern) => matchesPathPattern(file, pattern)));
  return { expected, touched, untouched, unexpected };
}

function enforcePathPolicy(changedFiles: string[], request: DelegateRequest, defaultForbidden: string[]): void {
  const policy = evaluatePathPolicy(changedFiles, request, defaultForbidden);
  if (policy.status === "passed") return;
  if (policy.forbidden.length) {
    throw new DelegationError("path_forbidden", `Run changed forbidden path(s): ${policy.forbidden.join(", ")}.`);
  }
  // Out-of-allowed: hand back a copy-paste retry that pre-fills the missing --allowed flags.
  const retryFlags = policy.notAllowed.map((path) => `--allowed ${path}`).join(" ");
  const fixtureHint = policy.notAllowed.some(isLikelyTestPath)
    ? " (test/fixture paths usually need to be allowed explicitly)"
    : "";
  throw new DelegationError(
    "path_not_allowed",
    `Run changed non-allowed path(s): ${policy.notAllowed.join(", ")}.${fixtureHint} Retry allowing them: re-run with ${retryFlags}. ` +
      `Or, if the diff is otherwise good, land it as-is: \`portico apply <id> --allow ${policy.notAllowed.join(" --allow ")}\`.`,
  );
}

/** Whether a run that failed solely on path policy can be landed via `apply --allow`: the
 *  failure must be path-policy-only (a `forbidden` hit never overrides — that boundary stays
 *  hard), and every out-of-scope file must be covered by a user-confirmed `--allow` pattern. */
function resolvePathPolicyOverride(
  result: RunResult | undefined,
  allow: string[],
): { ok: true } | { ok: false; reason: string } {
  const pathPolicy = result?.pathPolicy;
  if (!pathPolicy || pathPolicy.status !== "failed") {
    return { ok: false, reason: "run did not fail on path policy" };
  }
  if (pathPolicy.forbidden.length) {
    return { ok: false, reason: `touches forbidden path(s): ${pathPolicy.forbidden.join(", ")} (not overridable)` };
  }
  const uncovered = pathPolicy.notAllowed.filter((file) => !allow.some((pattern) => matchesPathPattern(file, pattern)));
  if (uncovered.length) {
    return { ok: false, reason: `--allow does not cover: ${uncovered.join(", ")}` };
  }
  return { ok: true };
}

function isLikelyTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures?|__fixtures__)(\/|$)/.test(path) || /\.(test|spec)\./.test(path);
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.?\//, "");
  if (normalized.endsWith("/**")) return file === normalized.slice(0, -3) || file.startsWith(normalized.slice(0, -2));
  if (!normalized.includes("*")) return file === normalized || file.startsWith(`${normalized}/`);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(file);
}

function validateRequest(request: DelegateRequest, maxDepth: number): void {
  if (!request || typeof request !== "object") throw new DelegationError("bad_request", "Request body is required.");
  if (!request.to) throw new DelegationError("bad_request", "Body must include `to`.");
  if (!request.repo) throw new DelegationError("bad_request", "Body must include `repo`.");
  if (!request.task) throw new DelegationError("bad_request", "Body must include `task`.");
  if (request.mode && !["implement", "review", "compare", "split"].includes(request.mode)) {
    throw new DelegationError("mode_unsupported", `Mode "${request.mode}" is not supported.`);
  }
  if (request.mode === "split") {
    const children = request.children ?? [];
    if (children.length < 2) {
      throw new DelegationError("split_requires_children", "Split mode requires at least two children.");
    }
    const missing = children.find((child) => !child.task || !child.task.trim());
    if (missing) {
      throw new DelegationError(
        "split_child_task_required",
        "Split mode requires every child to declare its own `task` (the complementary sub-task).",
      );
    }
  }
  if ((request.depth ?? 0) >= maxDepth) {
    throw new DelegationError("delegation_depth_exceeded", `Delegation depth ${request.depth ?? 0} exceeds max ${maxDepth}.`);
  }
}

function newRunId(now: string): string {
  return `run_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

/** Derive a short, scannable run name from a task: first few words, kebab-cased.
 *  Zero-cost (pure truncation, no model call) — the plan's chosen naming strategy. */
export function slugifyTask(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const slug = words.join("-").slice(0, 48).replace(/-+$/, "");
  return slug || "task";
}

function createRun(
  repoPath: string,
  request: DelegateRequest,
  options: {
    id: string;
    targetAgent: string;
    mode: Run["mode"];
    isolation: WorkspaceIsolation;
    permissionProfile: PermissionProfile;
    worktreePath: string;
    role?: RunRole;
    groupId?: string;
    parentRunId?: string;
    label?: string;
    childRunIds?: string[];
  },
): Run {
  const now = new Date().toISOString();
  return {
    id: options.id,
    repoPath,
    worktreePath: options.worktreePath,
    branchName: `portico/${options.id}`,
    rootAgent: request.from ?? "unknown",
    targetAgent: options.targetAgent,
    task: request.task,
    name: request.name?.trim() || options.label || slugifyTask(request.task),
    mode: options.mode,
    isolation: options.isolation,
    permissionProfile: options.permissionProfile,
    status: "created",
    depth: request.depth ?? 0,
    createdAt: now,
    updatedAt: now,
    ...(request.expectNoChanges ? { expectNoChanges: true } : {}),
    ...(request.expectedChangePaths?.length ? { expectedChangePaths: request.expectedChangePaths } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.groupId ? { groupId: options.groupId } : {}),
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(options.childRunIds ? { childRunIds: options.childRunIds } : {}),
  };
}

function normalizeIsolation(request: DelegateRequest, mode: Run["mode"]): WorkspaceIsolation {
  const raw = request.isolation;
  const workspace: WorkspaceIsolationMode =
    typeof raw === "string" ? raw : raw?.workspace ?? (mode === "review" ? "shared" : "worktree");
  const baseRef = request.baseRef ?? (typeof raw === "object" ? raw.baseRef : undefined) ?? "HEAD";
  const cleanup = request.cleanup ?? (typeof raw === "object" ? raw.cleanup : undefined) ?? "manual";
  if (!["worktree", "shared"].includes(workspace)) {
    throw new DelegationError("bad_request", `Unsupported workspace isolation "${workspace}".`);
  }
  if (!["manual", "onNoChanges", "onSuccess", "always"].includes(cleanup)) {
    throw new DelegationError("bad_request", `Unsupported cleanup policy "${cleanup}".`);
  }
  return { workspace, baseRef, cleanup };
}

function normalizePermissionProfile(
  request: DelegateRequest,
  mode: Run["mode"],
  workspace: WorkspaceIsolationMode,
): PermissionProfile {
  if (request.permissionProfile) return request.permissionProfile;
  if (mode === "review") return "read-only";
  if (mode === "implement" && workspace === "worktree") return "auto-edit";
  return "default";
}

function validateExecutionPolicy(
  mode: Run["mode"],
  isolation: WorkspaceIsolation,
  permissionProfile: PermissionProfile,
): void {
  if (!["default", "read-only", "auto-edit"].includes(permissionProfile)) {
    throw new DelegationError("bad_request", `Unsupported permission profile "${permissionProfile}".`);
  }
  if (mode === "review" && permissionProfile !== "read-only") {
    throw new DelegationError("bad_request", "Review mode must use the read-only permission profile.");
  }
  if (mode === "implement" && isolation.workspace === "shared" && permissionProfile === "auto-edit") {
    // Allowed, but intentionally explicit: callers must opt into both shared workspace and auto-edit.
    return;
  }
}

function shouldCleanupWorktree(cleanup: CleanupPolicy | undefined, status: Run["status"], changedFiles: string[]): boolean {
  switch (cleanup ?? "manual") {
    case "always":
      return true;
    case "onNoChanges":
      return changedFiles.length === 0;
    case "onSuccess":
      return status === "ready";
    case "manual":
      return false;
  }
}

async function resolveRepo(repo: string): Promise<string> {
  const full = resolve(repo);
  const result = await capture("git", ["-C", full, "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new DelegationError("repo_invalid", `${full} is not inside a git repo.`);
  return result.stdout.trim();
}

async function ensurePorticoDirs(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, ".portico", "runs"), { recursive: true });
  await mkdir(join(repoPath, ".portico", "worktrees"), { recursive: true });
}

async function ensurePorticoExcluded(repoPath: string): Promise<void> {
  const gitPath = await capture("git", ["-C", repoPath, "rev-parse", "--git-path", "info/exclude"]);
  if (gitPath.code !== 0) return;
  const rawPath = gitPath.stdout.trim();
  const excludePath = isAbsolute(rawPath) ? rawPath : join(repoPath, rawPath);
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    await mkdir(dirname(excludePath), { recursive: true });
  }
  if (!existing.split("\n").some((line) => line.trim() === "/.portico/")) {
    await appendFile(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}/.portico/\n`);
  }
}

function artifactPaths(repoPath: string, id: string): RunArtifact {
  const root = join(repoPath, ".portico", "runs", id);
  return {
    runId: id,
    taskPath: join(root, "task.json"),
    eventsPath: join(root, "events.ndjson"),
    agentLogPath: join(root, "agent.ndjson"),
    testLogPath: join(root, "test.log"),
    diffPath: join(root, "diff.patch"),
    reportPath: join(root, "report.md"),
    resultPath: join(root, "result.json"),
  };
}

async function resolveBaseRef(repoPath: string, baseRef = "HEAD"): Promise<string> {
  if (baseRef !== "defaultBranch") return baseRef;
  const originHead = await capture("git", ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.code === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim();
  }
  const currentBranch = await capture("git", ["-C", repoPath, "symbolic-ref", "--short", "HEAD"]);
  if (currentBranch.code === 0 && currentBranch.stdout.trim()) {
    return currentBranch.stdout.trim();
  }
  return "HEAD";
}

async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
  mutex: Semaphore,
): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  // Serialize git worktree metadata writes: concurrent `git worktree add` can
  // contend on .git/worktrees and fail. Agent execution still runs in parallel.
  await mutex.acquire();
  try {
    const result = await capture("git", ["-C", repoPath, "worktree", "add", "-b", branchName, worktreePath, baseRef]);
    if (result.code !== 0) {
      throw new DelegationError("worktree_failed", (result.stderr || result.stdout || "git worktree add failed").trim());
    }
  } finally {
    mutex.release();
  }
}

async function removeWorktree(repoPath: string, worktreePath: string, mutex: Semaphore): Promise<void> {
  if (!existsSync(worktreePath)) return;
  // Serialize worktree metadata writes alongside createWorktree (see above).
  await mutex.acquire();
  try {
    // Must run from inside the repo, else git can't resolve the worktree registration.
    const result = await capture("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
    if (result.code !== 0) {
      // Fall back to a raw delete, then prune the now-stale .git/worktrees/<id> metadata.
      await rm(worktreePath, { recursive: true, force: true });
      await capture("git", ["-C", repoPath, "worktree", "prune"]);
    }
  } finally {
    mutex.release();
  }
}

function buildDelegationPrompt(run: Run, request: DelegateRequest, defaultForbidden: string[]): string {
  const forbidden = [...defaultForbidden, ...(request.forbiddenPaths ?? [])];
  const allowed = request.allowedPaths?.length ? request.allowedPaths.join(", ") : "repo files required by the task";
  const tests = request.testCommands?.length ? request.testCommands.join("\n") : "No test command was provided.";
  const workspace =
    run.isolation.workspace === "worktree"
      ? `an isolated Portico worktree at ${run.worktreePath}`
      : "the caller's shared working tree";
  const writeRule =
    run.permissionProfile === "read-only"
      ? "- Do not modify files. This is a read-only run."
      : "- Modify only files needed for the task.";
  return [
    `You are running inside ${workspace}.`,
    `Run id: ${run.id}`,
    `Mode: ${run.mode}`,
    `Workspace isolation: ${run.isolation.workspace}`,
    `Base ref: ${run.isolation.baseRef ?? "HEAD"}`,
    `Cleanup policy: ${run.isolation.cleanup ?? "manual"}`,
    `Permission profile: ${run.permissionProfile}`,
    `Task: ${request.task}`,
    "",
    "Constraints:",
    writeRule,
    `- Allowed paths: ${allowed}.`,
    `- Forbidden paths: ${forbidden.join(", ")}.`,
    "- Do not run portico delegate or delegate this task again.",
    "- Do not apply patches to the caller's main working tree.",
    "",
    "Known test commands:",
    tests,
    "",
    run.mode === "review"
      ? "Complete the review and report findings in your final response."
      : "Complete the requested coding work and leave changes on disk.",
  ].join("\n");
}

async function generateDiff(worktreePath: string): Promise<{ diff: string; changedFiles: string[]; summary: DiffSummary }> {
  await capture("git", ["-C", worktreePath, "add", "-N", "."]);
  const nameOnly = await capture("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"]);
  const nameStatus = await capture("git", ["-C", worktreePath, "diff", "--name-status", "HEAD"]);
  const stat = await capture("git", ["-C", worktreePath, "diff", "--stat", "HEAD"]);
  // `--check` exits non-zero when it finds whitespace errors / conflict markers; that
  // is informational here, so we keep stdout regardless of exit code.
  const check = await capture("git", ["-C", worktreePath, "diff", "--check", "HEAD"]);
  const diff = await capture("git", ["-C", worktreePath, "diff", "--binary", "HEAD"]);
  if (diff.code !== 0) {
    throw new DelegationError("diff_failed", (diff.stderr || diff.stdout || "git diff failed").trim());
  }
  return {
    diff: diff.stdout,
    changedFiles: nameOnly.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    summary: {
      nameStatus: nameStatus.stdout.trim(),
      stat: stat.stdout.trim(),
      check: check.stdout.trim(),
    },
  };
}

async function captureStatus(repoPath: string): Promise<string> {
  const status = await capture("git", ["-C", repoPath, "status", "--porcelain"]);
  if (status.code !== 0) throw new DelegationError("git_failed", status.stderr || status.stdout);
  return status.stdout;
}

async function captureMainWorkspaceSnapshot(repoPath: string): Promise<OutOfTreeChange[]> {
  const status = await capture("git", ["-C", repoPath, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.code !== 0) throw new DelegationError("git_failed", status.stderr || status.stdout);
  return parseStatusSnapshot(status.stdout).filter((entry) => entry.path !== ".portico" && !entry.path.startsWith(".portico/"));
}

function parseStatusSnapshot(stdout: string): OutOfTreeChange[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((raw) => {
      const status = raw.slice(0, 2).trim() || raw.slice(0, 2);
      const body = raw.slice(3);
      const path = body.includes(" -> ") ? body.slice(body.lastIndexOf(" -> ") + 4) : body;
      return { path, status, raw };
    });
}

function diffMainWorkspaceSnapshot(before: OutOfTreeChange[], after: OutOfTreeChange[]): OutOfTreeChange[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.raw]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.raw]));
  const changes = after.filter((entry) => beforeByPath.get(entry.path) !== entry.raw);
  for (const entry of before) {
    if (!afterByPath.has(entry.path)) {
      changes.push({
        path: entry.path,
        status: "cleared",
        raw: `cleared: ${entry.raw}`,
      });
    }
  }
  return changes;
}

async function assertStatusUnchanged(repoPath: string, before: string): Promise<void> {
  const after = await captureStatus(repoPath);
  if (after !== before) {
    throw new DelegationError("read_only_modified", "Read-only run changed the shared working tree.");
  }
}

async function* withIdleWatchdog<T>(
  iterable: AsyncIterable<T>,
  idleMs: number | undefined,
): AsyncIterable<T> {
  if (!idleMs || idleMs <= 0) {
    yield* iterable;
    return;
  }
  const iterator = iterable[Symbol.asyncIterator]();
  let timer: NodeJS.Timeout | undefined;
  try {
    for (;;) {
      const idlePromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DelegationError("agent_stalled", `agent idle for ${Math.round(idleMs / 1000)}s with no output — treated as stalled`)), idleMs);
      });
      const result = await Promise.race([iterator.next(), idlePromise]);
      clearTimeout(timer);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    if (timer) clearTimeout(timer);
    await iterator.return?.();
  }
}

async function runTestCommand(cwd: string, command: string, timeoutMs?: number): Promise<TestResult> {
  const started = Date.now();
  const result = await capture("sh", ["-lc", command], { cwd, timeoutMs });
  return {
    command,
    status: result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    output: `${result.stdout}${result.stderr}`,
    durationMs: Date.now() - started,
  };
}

async function assertTrackedTreeClean(repoPath: string): Promise<void> {
  const status = await capture("git", ["-C", repoPath, "status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new DelegationError("git_failed", status.stderr || status.stdout);
  if (status.stdout.trim()) {
    throw new DelegationError("working_tree_dirty", "Current working tree has tracked changes; commit or stash before apply.");
  }
}

async function assertWorkspaceClean(repoPath: string): Promise<void> {
  const status = await captureStatus(repoPath);
  if (status.trim()) {
    throw new DelegationError(
      "working_tree_dirty",
      "Shared auto-edit runs require a clean working tree so Portico can attribute the resulting diff.",
    );
  }
}

async function saveRun(run: Run): Promise<void> {
  await writeJson(join(run.repoPath, ".portico", "runs", run.id, "run.json"), run);
}

async function updateRun(run: Run, patch: Partial<Run>): Promise<Run> {
  const next: Run = { ...run, ...patch, updatedAt: new Date().toISOString() };
  await saveRun(next);
  return next;
}

async function readRunDetails(repoPath: string, id: string): Promise<RunDetails> {
  const run = await readJson<Run>(join(repoPath, ".portico", "runs", id, "run.json"));
  const artifacts = artifactPaths(repoPath, id);
  let result: RunResult | undefined;
  try {
    result = await readJson<RunResult>(artifacts.resultPath);
    // Backward compat: if the stored result has compareResults but not childResults, copy.
    if (result && !result.childResults && result.compareResults) {
      result.childResults = result.compareResults;
    }
  } catch {
    result = undefined;
  }
  return { run, artifacts, result };
}

async function writeReport(path: string, result: RunResult): Promise<void> {
  const { run, artifacts, changedFiles, tests, error } = result;
  const outOfTreeChanges = result.outOfTreeChanges ?? [];
  const formatChecks = (checks: TestResult[]) =>
    checks.map((c) => `Command: ${c.command}\nStatus: ${c.status}\nExit Code: ${c.exitCode ?? "null"}`).join("\n\n");
  const testLines = tests.length ? formatChecks(tests) : "No tests configured.";
  const verifyChecks = result.verify ?? [];
  const warningLines = result.gateWarnings?.length
    ? result.gateWarnings.map((warning) => `- ${warning}`).join("\n")
    : "No gate warnings.";
  const telemetryLines = formatTelemetry(result.telemetry);

  // Use childResults if present, fall back to compareResults for backward compat.
  const childResults = result.childResults ?? result.compareResults;
  const groupSummary = result.groupSummary;
  const isSplit = run.mode === "split";
  // Portico's own verdict. Prefer the structured field; fall back to status for older results.
  const reviewDecision = result.reviewDecision ?? (run.status === "ready" ? "approve" : "needs_attention");
  // For a no-change implement run, the agent's own final message often explains why it made no
  // edits; surface it (truncated, unverified) so the reviewer doesn't have to read the agent log.
  const noChangeReason =
    run.role !== "group" && run.mode === "implement" && run.status === "ready" && changedFiles.length === 0
      ? extractAgentFinalMessage(result.agentEvents)
      : undefined;

  let nextActions: string;
  if (run.role === "group" && isSplit) {
    if (run.status === "conflict") {
      nextActions = [
        `1. Inspect conflicts: conflicts.json${result.merge?.integrationWorktree ? ` / ${result.merge.integrationWorktree}` : ""}`,
        `2. Narrow a child then re-merge: \`portico delegate --resume <child_id> --task "..."\``,
      ].join("\n");
    } else if (run.status === "ready") {
      nextActions = `1. Apply merged: \`portico apply ${run.id} --all\``;
    } else {
      nextActions = `1. Inspect: \`portico status ${run.id}\``;
    }
  } else if (run.role === "group" && childResults?.length) {
    // Partial/mixed group: separate ready children (apply) from failed ones (resume),
    // and surface each failure reason so the reviewer doesn't treat the whole group as lost.
    const ready = childResults.filter((c) => c.run.status === "ready");
    const failed = childResults.filter((c) => c.run.status === "failed" || c.run.status === "cancelled");
    const other = childResults.filter((c) => !ready.includes(c) && !failed.includes(c));
    const lines: string[] = [];
    for (const c of ready) {
      const recommended = result.judge?.recommendedChildId === c.run.id ? " (recommended)" : "";
      const label = c.run.label ? ` [${c.run.label}]` : "";
      lines.push(`Apply ready${recommended}${label}: \`portico apply ${run.id} --child ${c.run.id}\``);
    }
    for (const c of failed) {
      const label = c.run.label ? ` [${c.run.label}]` : "";
      const reason = c.error ? ` (${firstLine(c.error)})` : "";
      lines.push(`Re-run failed${label}${reason}: \`portico delegate --resume ${c.run.id} --task "..."\``);
    }
    for (const c of other) lines.push(`Inspect: \`portico status ${c.run.id}\``);
    nextActions = lines.join("\n");
  } else if (run.status === "ready" && reviewDecision === "needs_attention") {
    // Ready by gate, but Portico flagged it (e.g. no file changes) — don't lead with Apply.
    nextActions = `1. Needs attention before apply — inspect: \`portico status ${run.id}\``;
  } else {
    nextActions = `1. Apply: \`portico apply ${run.id}\``;
  }

  const body = [
    "# Portico Run Report",
    "",
    "## Summary",
    "",
    `Task: ${run.task}`,
    "",
    `Status: ${run.status}`,
    "",
    `Target Agent: ${run.targetAgent}`,
    "",
    `Mode: ${run.mode}`,
    "",
    `Workspace Isolation: ${run.isolation.workspace}`,
    "",
    `Base Ref: ${run.isolation.baseRef ?? "HEAD"}`,
    "",
    `Cleanup Policy: ${run.isolation.cleanup ?? "manual"}`,
    "",
    `Permission Profile: ${run.permissionProfile}`,
    "",
    `Branch: ${run.branchName}`,
    "",
    `Worktree: ${run.worktreePath}`,
    "",
    run.worktreeRemovedAt ? `Worktree Removed At: ${run.worktreeRemovedAt}` : undefined,
    run.worktreeRemovedAt ? "" : undefined,
    run.role !== "group" ? "## Portico Observations" : undefined,
    run.role !== "group" ? "" : undefined,
    run.role !== "group" ? formatObservations(result, changedFiles, reviewDecision) : undefined,
    run.role !== "group" ? "" : undefined,
    childResults?.length ? (isSplit ? "## Split Contributions" : "## Compare Candidates") : undefined,
    childResults?.length ? "" : undefined,
    groupSummary
      ? `Children: ${groupSummary.total} total, ${groupSummary.ready} ready, ${groupSummary.failed} failed, ${groupSummary.cancelled} cancelled${
          (childResults?.filter((c) => c.run.status === "ready" && c.changedFiles.length === 0).length ?? 0)
            ? `, ${childResults?.filter((c) => c.run.status === "ready" && c.changedFiles.length === 0).length} no-change`
            : ""
        }`
      : undefined,
    groupSummary ? "" : undefined,
    childResults?.length
      ? childResults
          .map((candidate, index) => {
            const agentMs = candidate.telemetry?.agentDurationMs !== undefined ? ` — ${candidate.telemetry.agentDurationMs} ms agent` : "";
            const apply = candidate.applyCheck
              ? candidate.applyCheck.applies
                ? " — apply: ok"
                : ` — apply: FAILS (${candidate.applyCheck.reason ?? "does not apply to base"})`
              : "";
            return `${index + 1}. ${candidate.run.targetAgent} — ${candidate.run.status} — ${candidate.changedFiles.length} changed file(s)${agentMs}${apply} — ${candidate.artifacts.reportPath}`;
          })
          .join("\n")
      : undefined,
    childResults?.length ? "" : undefined,
    result.merge ? "## Fan-in Merge" : undefined,
    result.merge ? "" : undefined,
    result.merge ? `Strategy: ${result.merge.strategy}` : undefined,
    result.merge ? `Merge Status: ${result.merge.status}` : undefined,
    result.merge?.conflictKind
      ? `Conflict Kind: ${result.merge.conflictKind === "overlap" ? "overlap (two children edited the same region)" : "apply_failure (a child's own patch did not apply to the group base)"}`
      : undefined,
    result.merge?.conflictReason ? `Git Reason: ${result.merge.conflictReason}` : undefined,
    result.merge?.integrationWorktree ? `Integration Worktree: ${result.merge.integrationWorktree}` : undefined,
    result.conflicts?.length ? "" : undefined,
    result.conflicts?.length ? "Conflicts:" : undefined,
    result.conflicts?.length
      ? result.conflicts.map((c, index) => `${index + 1}. ${c.file}${c.line !== undefined ? `:${c.line}` : ""} (from ${c.child})`).join("\n")
      : undefined,
    result.merge ? "" : undefined,
    result.judge ? "## Judge" : undefined,
    result.judge ? "" : undefined,
    result.judge ? `Judge Agent: ${result.judge.to}` : undefined,
    result.judge?.verdict ? `Verdict: ${result.judge.verdict}` : undefined,
    result.judge?.recommendedChildId ? `Recommended: ${result.judge.recommendedChildId}` : undefined,
    result.judge?.ranking?.length ? "Ranking:" : undefined,
    result.judge?.ranking?.length
      ? result.judge.ranking
          .map((r, index) => `${index + 1}. ${r.childId}${r.score !== undefined ? ` (score ${r.score})` : ""} — ${r.note}`)
          .join("\n")
      : undefined,
    result.judge ? "" : undefined,
    "## Gate Warnings",
    "",
    warningLines,
    "",
    "## Path Policy",
    "",
    formatPathPolicy(result.pathPolicy),
    "",
    result.coverage ? "## Coverage" : undefined,
    result.coverage ? "" : undefined,
    result.coverage ? formatCoverage(result.coverage) : undefined,
    result.coverage ? "" : undefined,
    "## Worktree Changes",
    "",
    result.diffSummary
      ? formatDiffSummary(result.diffSummary, changedFiles)
      : changedFiles.length
        ? changedFiles.map((file, index) => `${index + 1}. ${file}`).join("\n")
        : "No file changes detected.",
    "",
    "## Out-of-Tree Changes",
    "",
    outOfTreeChanges.length
      ? outOfTreeChanges.map((change, index) => `${index + 1}. ${change.status} ${change.path}`).join("\n")
      : "No out-of-tree changes detected.",
    "",
    "## Telemetry",
    "",
    telemetryLines,
    "",
    "## Code Tests",
    "",
    testLines,
    "",
    verifyChecks.length ? "## Verify Checks" : undefined,
    verifyChecks.length ? "" : undefined,
    verifyChecks.length ? formatChecks(verifyChecks) : undefined,
    verifyChecks.length ? "" : undefined,
    // For a no-change implement run, surface the agent's own explanation (clearly unverified) so
    // a reviewer can judge "why nothing changed" without scraping the agent log.
    noChangeReason ? "## Agent's Stated Reason (unverified — for a no-change run)" : undefined,
    noChangeReason ? "" : undefined,
    noChangeReason ?? undefined,
    noChangeReason ? "" : undefined,
    "## Review",
    "",
    `Decision: ${reviewDecision}`,
    run.role !== "group" ? `Readiness: ${formatReadiness(run, reviewDecision)}` : undefined,
    "",
    error
      ? `Summary: ${error}`
      : result.gateWarnings?.length
        ? `Summary: ${result.gateWarnings.join(" ")}`
        : "Summary: Review the diff before applying.",
    "",
    "## Artifacts",
    "",
    `1. ${basename(artifacts.diffPath ?? "diff.patch")}`,
    `2. ${basename(artifacts.testLogPath ?? "test.log")}`,
    `3. ${basename(artifacts.eventsPath)}`,
    `4. ${basename(artifacts.agentLogPath)} (raw agent log — narration, not an authoritative status source)`,
    `5. ${basename(artifacts.resultPath)}`,
    "",
    "## Next Actions",
    "",
    nextActions,
    "",
    `2. Discard: \`portico discard ${run.id}\``,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  await writeFile(path, body);
}

/** Distinguish "ready to review" from "ready to apply" so `ready` (a gate-passed flag) is not
 *  mistaken for "safe to apply". Review/check runs are never applied; an implement run that
 *  Portico flagged (no-change, coverage gap) is review-only until a human looks. */
function formatReadiness(run: Run, reviewDecision: "approve" | "needs_attention"): string {
  if (run.mode !== "implement") return "Ready to review (read-only run; nothing to apply)";
  if (run.status !== "ready") return `Not ready (${run.status})`;
  if (reviewDecision === "needs_attention") return "Ready to review only — needs attention before apply (see Gate Warnings)";
  return "Ready to apply";
}

/** Portico's own measured facts about a run — what Portico observed, independent of the agent's
 *  narration. Foregrounds changed files, diff check, tests/verify, path policy and sandbox so a
 *  reviewer never has to trust the (often noisy) agent log to judge whether the result is sound. */
function formatObservations(
  result: RunResult,
  changedFiles: string[],
  reviewDecision: "approve" | "needs_attention",
): string {
  const tests = result.tests ?? [];
  const verify = result.verify ?? [];
  const tally = (checks: TestResult[]) => `${checks.filter((c) => c.status === "passed").length}/${checks.length} passed`;
  const diffCheck = result.diffSummary
    ? result.diffSummary.check.trim()
      ? "issues found — see Worktree Changes"
      : "clean"
    : "not evaluated";
  const lines = [
    `Changed Files: ${changedFiles.length ? `${changedFiles.length} file(s)` : "none"}`,
    `Diff Check (whitespace/conflict markers): ${diffCheck}`,
    `Tests: ${tests.length ? tally(tests) : "none configured"}`,
    `Verify: ${verify.length ? tally(verify) : "none configured"}`,
    `Path Policy: ${result.pathPolicy ? result.pathPolicy.status : "not evaluated"}`,
    result.coverage ? `Coverage: ${result.coverage.untouched.length ? `gap (${result.coverage.untouched.length} expected path(s) untouched)` : "expected paths all touched"}` : undefined,
    `Sandbox Escape: ${result.sandboxEscaped ? `DETECTED (${result.outOfTreeChanges?.length ?? 0} out-of-tree change(s))` : "none"}`,
    `Review Decision: ${reviewDecision}`,
    "",
    "These are the checks Portico ran — a boundary, not a quality guarantee. Portico does not judge",
    "semantic correctness, prose quality, or link validity; use --verify for those. The agent's",
    "narration in agent.ndjson is a log, not an authoritative status source.",
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

/** First non-empty line of a (possibly multi-line) message, truncated for inline use. */
function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? text.trim();
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Render the path-policy outcome, including a copy-paste retry when it failed. */
function formatPathPolicy(policy: PathPolicyResult | undefined): string {
  if (!policy) return "Not evaluated (no diff produced).";
  const lines = [`Allowed Policy: ${policy.status}`, `Allowed Paths: ${policy.allowed.length ? policy.allowed.join(", ") : "(none — all repo paths permitted)"}`];
  if (policy.forbidden.length) lines.push(`Forbidden Hits: ${policy.forbidden.join(", ")}`);
  if (policy.notAllowed.length) lines.push(`Out-of-Scope Changes: ${policy.notAllowed.join(", ")}`);
  if (policy.retryAllowed?.length) {
    lines.push("", `Retry allowing them: ${policy.retryAllowed.map((p) => `--allowed ${p}`).join(" ")}`);
  }
  return lines.join("\n");
}

/** Render the coverage of `--expected-change`: which declared paths were touched, which are
 *  still gaps, and which changed files were unexpected. Boundary (path policy) vs completeness. */
function formatCoverage(coverage: CoverageResult): string {
  const list = (items: string[]) => (items.length ? items.join(", ") : "(none)");
  const lines = [
    `Status: ${coverage.untouched.length ? "gap" : "complete"}`,
    `Expected: ${list(coverage.expected)}`,
    `Touched: ${list(coverage.touched)}`,
    `Untouched (gaps): ${list(coverage.untouched)}`,
    `Unexpected (changed, not expected): ${list(coverage.unexpected)}`,
  ];
  return lines.join("\n");
}

/** Render grouped `git diff --name-status` + diffstat + whitespace check so the report
 *  is a single source of truth (no need to re-run git diff by hand). */
function formatDiffSummary(summary: DiffSummary, changedFiles: string[]): string {
  if (!summary.nameStatus && !changedFiles.length) return "No file changes detected.";
  const groups: Record<"Added (new)" | "Modified" | "Deleted" | "Renamed" | "Other", string[]> = {
    "Added (new)": [],
    Modified: [],
    Deleted: [],
    Renamed: [],
    Other: [],
  };
  for (const line of summary.nameStatus.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const file = parts[parts.length - 1] ?? "";
    if (code.startsWith("A")) groups["Added (new)"].push(file);
    else if (code.startsWith("M")) groups.Modified.push(file);
    else if (code.startsWith("D")) groups.Deleted.push(file);
    else if (code.startsWith("R")) groups.Renamed.push(`${parts[1] ?? ""} → ${file}`);
    else groups.Other.push(`${code} ${file}`);
  }
  const sections: string[] = [];
  for (const [label, files] of Object.entries(groups)) {
    if (files.length) sections.push(`${label}:\n${files.map((f) => `- ${f}`).join("\n")}`);
  }
  // Fall back to the raw changed-files list when name-status was empty but files changed.
  const changes = sections.length ? sections.join("\n\n") : changedFiles.map((f) => `- ${f}`).join("\n");
  const blocks = [changes];
  if (summary.stat) blocks.push(`Diffstat:\n\`\`\`\n${summary.stat}\n\`\`\``);
  blocks.push(`Whitespace/Conflict Check (\`git diff --check\`):\n${summary.check ? `\`\`\`\n${summary.check}\n\`\`\`` : "clean"}`);
  return blocks.join("\n\n");
}

function formatTelemetry(telemetry: RunTelemetry | undefined): string {
  if (!telemetry) return "No telemetry recorded.";
  const usage = telemetry.usage;
  const lines = [
    `Total Duration: ${telemetry.totalDurationMs} ms`,
    telemetry.worktreeSetupMs !== undefined ? `Worktree Setup: ${telemetry.worktreeSetupMs} ms` : undefined,
    telemetry.agentDurationMs !== undefined ? `Agent Duration: ${telemetry.agentDurationMs} ms` : undefined,
    telemetry.diffMs !== undefined ? `Diff Generation: ${telemetry.diffMs} ms` : undefined,
    `Test Duration: ${telemetry.testDurationMs} ms`,
    telemetry.verifyMs !== undefined ? `Verify Duration: ${telemetry.verifyMs} ms` : undefined,
    telemetry.fanInMs !== undefined ? `Fan-in Duration: ${telemetry.fanInMs} ms` : undefined,
    usage.available ? `Usage Available: yes` : `Usage Available: no (${usage.unavailableReason ?? "not reported"})`,
    usage.inputTokens !== undefined ? `Input Tokens: ${usage.inputTokens}` : undefined,
    usage.outputTokens !== undefined ? `Output Tokens: ${usage.outputTokens}` : undefined,
    usage.totalTokens !== undefined ? `Total Tokens: ${usage.totalTokens}` : undefined,
    usage.costUsd !== undefined ? `Cost USD: ${usage.costUsd}` : "Cost USD: not reported",
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

async function recordEvent(path: string, event: DelegationEvent): Promise<DelegationEvent> {
  await appendFile(path, encodeDelegationEvent(event));
  return event;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
