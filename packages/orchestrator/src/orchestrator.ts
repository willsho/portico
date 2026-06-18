import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { capture, encodeEvent, runAgent } from "@portico/core";
import type { AgentEntry, ChatRequest, RuntimeEvent } from "@portico/core";
import type {
  CleanupPolicy,
  DelegateRequest,
  DelegationEvent,
  OrchestratorOptions,
  PermissionProfile,
  OutOfTreeChange,
  RunTelemetry,
  Run,
  RunArtifact,
  RunDetails,
  RunResult,
  TestResult,
  WorkspaceIsolation,
  WorkspaceIsolationMode,
} from "./types.ts";

const DEFAULT_FORBIDDEN = [".env", ".ssh/**", "node_modules/**", "dist/**", "build/**"];

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
  listRuns(repo: string): Promise<Run[]>;
  getRun(repo: string, id: string): Promise<RunDetails>;
  readEvents(repo: string, id: string): Promise<DelegationEvent[]>;
  cancel(repo: string, id: string): Promise<RunDetails>;
  apply(repo: string, id: string): Promise<RunDetails>;
  discard(repo: string, id: string): Promise<RunDetails>;
}

export function createDelegationOrchestrator(options: OrchestratorOptions = {}): DelegationOrchestrator {
  const maxDepth = options.maxDepth ?? 1;
  const maxConcurrent = options.maxConcurrentRunsPerRepo ?? 2;
  const defaultForbidden = options.defaultForbiddenPaths ?? DEFAULT_FORBIDDEN;
  const activeByRepo = new Map<string, number>();
  const activeControllers = new Map<string, AbortController>();

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

        if ((effectiveRequest.mode ?? "implement") === "compare") {
          yield* runCompareDelegation(effectiveRequest, repoPath, context, activeControllers, defaultForbidden);
        } else {
          yield* runSingleDelegation(effectiveRequest, repoPath, context, activeControllers, defaultForbidden);
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

    async listRuns(repo) {
      const repoPath = await resolveRepo(repo);
      const dir = join(repoPath, ".portico", "runs");
      if (!existsSync(dir)) return [];
      const entries = await readdir(dir, { withFileTypes: true });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => readJson<Run>(join(dir, entry.name, "run.json")).catch(() => undefined)),
      );
      return runs.filter((run): run is Run => !!run).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async getRun(repo, id) {
      return readRunDetails(await resolveRepo(repo), id);
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
      activeControllers.get(id)?.abort();
      const run = await updateRun(details.run, { status: "cancelled", completedAt: new Date().toISOString() });
      await writeJson(details.artifacts.resultPath, { ...details.result, run });
      return readRunDetails(repoPath, id);
    },

    async apply(repo, id) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      if (details.run.mode !== "implement") {
        throw new DelegationError("invalid_mode", `Run ${id} is ${details.run.mode}; only implement runs can be applied.`);
      }
      if (details.run.status !== "ready") {
        throw new DelegationError("invalid_status", `Run ${id} is ${details.run.status}, not ready.`);
      }
      if (!details.artifacts.diffPath || !existsSync(details.artifacts.diffPath)) {
        throw new DelegationError("missing_diff", `Run ${id} does not have a diff.patch artifact.`);
      }
      await assertTrackedTreeClean(repoPath);
      const applied = await capture("git", ["-C", repoPath, "apply", "--binary", details.artifacts.diffPath]);
      if (applied.code !== 0) {
        throw new DelegationError("apply_failed", (applied.stderr || applied.stdout || "git apply failed").trim());
      }
      const run = await updateRun(details.run, { status: "applied", completedAt: new Date().toISOString() });
      await writeJson(details.artifacts.resultPath, { ...details.result, run });
      return readRunDetails(repoPath, id);
    },

    async discard(repo, id) {
      const repoPath = await resolveRepo(repo);
      const details = await readRunDetails(repoPath, id);
      await removeWorktree(repoPath, details.run.worktreePath);
      const run = await updateRun(details.run, { status: "discarded", completedAt: new Date().toISOString() });
      await writeJson(details.artifacts.resultPath, { ...details.result, run });
      return readRunDetails(repoPath, id);
    },
  };
}

async function* runCompareDelegation(
  request: DelegateRequest,
  repoPath: string,
  context: { findEntry(provider: string): AgentEntry | undefined },
  activeControllers: Map<string, AbortController>,
  defaultForbidden: string[],
): AsyncIterable<DelegationEvent> {
  const targets = [request.to, ...(request.compareTargets ?? [])].filter(Boolean);
  if (targets.length < 2) {
    throw new DelegationError("compare_requires_targets", "Compare mode requires `to` plus at least one `compareTargets` entry.");
  }

  const now = new Date().toISOString();
  const runStartedMs = Date.now();
  let run = createRun(repoPath, request, {
    id: newRunId(now),
    targetAgent: targets.join(","),
    mode: "compare",
    isolation: normalizeIsolation(request, "compare"),
    permissionProfile: "auto-edit",
    worktreePath: join(repoPath, ".portico", "worktrees", `compare_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`),
  });
  const artifacts = artifactPaths(repoPath, run.id);
  const childResults: RunResult[] = [];

  await mkdir(dirname(artifacts.taskPath), { recursive: true });
  await writeJson(artifacts.taskPath, { ...request, repo: repoPath, compareTargets: targets });
  await saveRun(run);
  await writeFile(artifacts.eventsPath, "");
  yield await recordEvent(artifacts.eventsPath, { type: "run_start", runId: run.id, status: run.status });
  run = await updateRun(run, { status: "planning", startedAt: new Date().toISOString() });

  for (const target of targets) {
    const candidateRequest: DelegateRequest = {
      ...request,
      to: target,
      compareTargets: undefined,
      mode: "implement",
      isolation: {
        workspace: "worktree",
        baseRef: normalizeIsolation(request, "compare").baseRef,
        cleanup: normalizeIsolation(request, "compare").cleanup,
      },
      permissionProfile: "auto-edit",
      task: [
        "This is one candidate implementation for a Portico compare run.",
        `Original task: ${request.task}`,
        "Optimize for a clear, reviewable patch. Another agent may produce a competing patch.",
      ].join("\n"),
    };

    let childDone: Extract<DelegationEvent, { type: "run_done" }> | undefined;
    let childError: Extract<DelegationEvent, { type: "run_error" }> | undefined;
    for await (const event of runSingleDelegation(candidateRequest, repoPath, context, activeControllers, defaultForbidden)) {
      yield event;
      if (event.type === "run_done") childDone = event;
      if (event.type === "run_error") childError = event;
    }
    const childId = childDone?.runId ?? childError?.runId;
    if (childId) {
      try {
        const child = await readJson<RunResult>(artifactPaths(repoPath, childId).resultPath);
        childResults.push(child);
      } catch {
        // The child already emitted its own error event; keep the compare parent going.
      }
    }
  }

  const failed = childResults.length !== targets.length || childResults.some((result) => result.run.status !== "ready");
  run = await updateRun(run, { status: failed ? "failed" : "ready", completedAt: new Date().toISOString() });
  const result: RunResult = {
    run,
    artifacts,
    changedFiles: [...new Set(childResults.flatMap((result) => result.changedFiles))],
    tests: childResults.flatMap((result) => result.tests),
    agentEvents: [],
    compareResults: childResults,
    telemetry: {
      totalDurationMs: Date.now() - runStartedMs,
      agentDurationMs: childResults.reduce((sum, result) => sum + (result.telemetry?.agentDurationMs ?? 0), 0),
      testDurationMs: childResults.reduce((sum, result) => sum + (result.telemetry?.testDurationMs ?? 0), 0),
      usage: aggregateUsageTelemetry(childResults),
    },
  };
  await writeJson(artifacts.resultPath, result);
  await writeReport(artifacts.reportPath, result);
  yield await recordEvent(artifacts.eventsPath, {
    type: "run_done",
    runId: run.id,
    status: run.status,
    reportPath: artifacts.reportPath,
    resultPath: artifacts.resultPath,
  });
}

async function* runSingleDelegation(
  request: DelegateRequest,
  repoPath: string,
  context: { findEntry(provider: string): AgentEntry | undefined },
  activeControllers: Map<string, AbortController>,
  defaultForbidden: string[],
): AsyncIterable<DelegationEvent> {
  let run: Run | undefined;
  let controller: AbortController | undefined;
  let artifacts: RunArtifact | undefined;
  let worktreeCreated = false;
  let outOfTreeChanges: OutOfTreeChange[] = [];
  let agentEvents: RuntimeEvent[] = [];
  let tests: TestResult[] = [];
  let changedFiles: string[] = [];
  let runStartedMs = Date.now();
  let agentDurationMs: number | undefined;
  let testDurationMs = 0;

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
      const baseRef = await resolveBaseRef(repoPath, isolation.baseRef);
      await createWorktree(repoPath, worktreePath, run.branchName, baseRef);
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
    activeControllers.set(run.id, controller);

    const workDir = isolation.workspace === "worktree" ? worktreePath : repoPath;
    const chat: ChatRequest = {
      provider: request.to,
      messages: [{ role: "user", content: buildDelegationPrompt(run, request, defaultForbidden) }],
      options: {
        cwd: workDir,
        timeoutMs: request.timeoutMs,
        autoEdit: permissionProfile === "auto-edit",
      },
    };

    const agentStartedMs = Date.now();
    for await (const event of runAgent(chat, {
      entry,
      signal: controller.signal,
      env: { ...process.env, PORTICO_DELEGATION_DEPTH: String(run.depth + 1) },
    })) {
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
      const result: RunResult = buildRunResult(run, artifacts, [], [], agentEvents, outOfTreeChanges, {
        totalDurationMs: Date.now() - runStartedMs,
        agentDurationMs,
        testDurationMs,
        usage: extractUsageTelemetry(agentEvents),
      });
      await writeJson(artifacts.resultPath, result);
      await writeReport(artifacts.reportPath, result);
      yield await recordEvent(artifacts.eventsPath, {
        type: "run_done",
        runId: run.id,
        status: run.status,
        reportPath: artifacts.reportPath,
        resultPath: artifacts.resultPath,
      });
      return;
    }

    const diffResult = await generateDiff(workDir);
    changedFiles = diffResult.changedFiles;
    await writeFile(artifacts.diffPath as string, diffResult.diff);
    enforcePathPolicy(changedFiles, request, defaultForbidden);
    yield await recordEvent(artifacts.eventsPath, {
      type: "diff_ready",
      runId: run.id,
      path: artifacts.diffPath as string,
      changedFiles,
    });

    run = await updateRun(run, { status: "testing" });
    for (const command of request.testCommands ?? []) {
      yield await recordEvent(artifacts.eventsPath, { type: "test_start", runId: run.id, command });
      const result = await runTestCommand(workDir, command, request.timeoutMs);
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

    const failedTest = tests.find((test) => test.status === "failed");
    run = await updateRun(run, {
      status: failedTest || outOfTreeChanges.length ? "failed" : "ready",
      completedAt: new Date().toISOString(),
    });
    if (worktreeCreated && shouldCleanupWorktree(isolation.cleanup, run.status, changedFiles)) {
      await removeWorktree(repoPath, worktreePath);
      run = await updateRun(run, { worktreeRemovedAt: new Date().toISOString() });
    }
    const result = buildRunResult(run, artifacts, changedFiles, tests, agentEvents, outOfTreeChanges, {
      totalDurationMs: Date.now() - runStartedMs,
      agentDurationMs,
      testDurationMs,
      usage: extractUsageTelemetry(agentEvents),
    });
    await writeJson(artifacts.resultPath, result);
    await writeReport(artifacts.reportPath, result);
    yield await recordEvent(artifacts.eventsPath, {
      type: "run_done",
      runId: run.id,
      status: run.status,
      reportPath: artifacts.reportPath,
      resultPath: artifacts.resultPath,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const code = err instanceof DelegationError ? err.code : "internal";
    if (run && artifacts) {
      const status = controller?.signal.aborted ? "cancelled" : "failed";
      run = await updateRun(run, { status, completedAt: new Date().toISOString() });
      if (worktreeCreated && shouldCleanupWorktree(run.isolation.cleanup, run.status, [])) {
        await removeWorktree(repoPath, run.worktreePath);
        run = await updateRun(run, { worktreeRemovedAt: new Date().toISOString() });
      }
      const result = buildRunResult(
        run,
        artifacts,
        changedFiles,
        tests,
        agentEvents,
        outOfTreeChanges,
        {
          totalDurationMs: Date.now() - runStartedMs,
          agentDurationMs,
          testDurationMs,
          usage: extractUsageTelemetry(agentEvents),
        },
        error,
      );
      await writeJson(artifacts.resultPath, result);
      await writeReport(artifacts.reportPath, result);
      yield await recordEvent(artifacts.eventsPath, { type: "run_error", runId: run.id, error, code });
    } else {
      yield { type: "run_error", error, code };
    }
  } finally {
    if (run) activeControllers.delete(run.id);
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
  return {
    run,
    artifacts,
    changedFiles,
    tests,
    agentEvents,
    ...(sandboxEscaped ? { sandboxEscaped, outOfTreeChanges } : {}),
    ...(agentGateMismatch ? { agentGateMismatch } : {}),
    ...(gateWarnings.length ? { gateWarnings } : {}),
    telemetry,
    ...(error ? { error } : {}),
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

function enforcePathPolicy(changedFiles: string[], request: DelegateRequest, defaultForbidden: string[]): void {
  const forbidden = [...defaultForbidden, ...(request.forbiddenPaths ?? [])];
  const forbiddenHit = changedFiles.find((file) => forbidden.some((pattern) => matchesPathPattern(file, pattern)));
  if (forbiddenHit) {
    throw new DelegationError("path_forbidden", `Run changed forbidden path "${forbiddenHit}".`);
  }
  if (request.allowedPaths?.length) {
    const outsideAllowed = changedFiles.find(
      (file) => !request.allowedPaths?.some((pattern) => matchesPathPattern(file, pattern)),
    );
    if (outsideAllowed) throw new DelegationError("path_not_allowed", `Run changed non-allowed path "${outsideAllowed}".`);
  }
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
  if (request.mode && !["implement", "review", "compare"].includes(request.mode)) {
    throw new DelegationError("mode_unsupported", `Mode "${request.mode}" is not supported.`);
  }
  if ((request.depth ?? 0) >= maxDepth) {
    throw new DelegationError("delegation_depth_exceeded", `Delegation depth ${request.depth ?? 0} exceeds max ${maxDepth}.`);
  }
}

function newRunId(now: string): string {
  return `run_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
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
    mode: options.mode,
    isolation: options.isolation,
    permissionProfile: options.permissionProfile,
    status: "created",
    depth: request.depth ?? 0,
    createdAt: now,
    updatedAt: now,
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

async function createWorktree(repoPath: string, worktreePath: string, branchName: string, baseRef: string): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  const result = await capture("git", ["-C", repoPath, "worktree", "add", "-b", branchName, worktreePath, baseRef]);
  if (result.code !== 0) {
    throw new DelegationError("worktree_failed", (result.stderr || result.stdout || "git worktree add failed").trim());
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  // Must run from inside the repo, else git can't resolve the worktree registration.
  const result = await capture("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath]);
  if (result.code !== 0) {
    // Fall back to a raw delete, then prune the now-stale .git/worktrees/<id> metadata.
    await rm(worktreePath, { recursive: true, force: true });
    await capture("git", ["-C", repoPath, "worktree", "prune"]);
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

async function generateDiff(worktreePath: string): Promise<{ diff: string; changedFiles: string[] }> {
  await capture("git", ["-C", worktreePath, "add", "-N", "."]);
  const nameOnly = await capture("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"]);
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
  } catch {
    result = undefined;
  }
  return { run, artifacts, result };
}

async function writeReport(path: string, result: RunResult): Promise<void> {
  const { run, artifacts, changedFiles, tests, error } = result;
  const outOfTreeChanges = result.outOfTreeChanges ?? [];
  const testLines = tests.length
    ? tests.map((test) => `Command: ${test.command}\nStatus: ${test.status}\nExit Code: ${test.exitCode ?? "null"}`).join("\n\n")
    : "No tests configured.";
  const warningLines = result.gateWarnings?.length
    ? result.gateWarnings.map((warning) => `- ${warning}`).join("\n")
    : "No gate warnings.";
  const telemetryLines = formatTelemetry(result.telemetry);
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
    result.compareResults?.length ? "## Compare Candidates" : undefined,
    result.compareResults?.length ? "" : undefined,
    result.compareResults?.length
      ? result.compareResults
          .map(
            (candidate, index) =>
              `${index + 1}. ${candidate.run.targetAgent} — ${candidate.run.status} — ${candidate.changedFiles.length} changed file(s) — ${candidate.artifacts.reportPath}`,
          )
          .join("\n")
      : undefined,
    result.compareResults?.length ? "" : undefined,
    "## Gate Warnings",
    "",
    warningLines,
    "",
    "## Worktree Changes",
    "",
    changedFiles.length ? changedFiles.map((file, index) => `${index + 1}. ${file}`).join("\n") : "No file changes detected.",
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
    "## Test Result",
    "",
    testLines,
    "",
    "## Review",
    "",
    `Decision: ${run.status === "ready" ? "approve" : "needs_attention"}`,
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
    `4. ${basename(artifacts.resultPath)}`,
    "",
    "## Next Actions",
    "",
    `1. Apply: \`portico apply ${run.id}\``,
    `2. Discard: \`portico discard ${run.id}\``,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  await writeFile(path, body);
}

function formatTelemetry(telemetry: RunTelemetry | undefined): string {
  if (!telemetry) return "No telemetry recorded.";
  const usage = telemetry.usage;
  const lines = [
    `Total Duration: ${telemetry.totalDurationMs} ms`,
    telemetry.agentDurationMs !== undefined ? `Agent Duration: ${telemetry.agentDurationMs} ms` : undefined,
    `Test Duration: ${telemetry.testDurationMs} ms`,
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
