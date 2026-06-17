import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { capture, encodeEvent, runAgent } from "@portico/core";
import type { AgentEntry, ChatRequest, RuntimeEvent } from "@portico/core";
import type {
  DelegateRequest,
  DelegationEvent,
  OrchestratorOptions,
  Run,
  RunArtifact,
  RunDetails,
  RunResult,
  TestResult,
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
      let run: Run | undefined;
      let controller: AbortController | undefined;
      let reservedRepo: string | undefined;
      try {
        validateRequest(request, maxDepth);
        const repoPath = await resolveRepo(request.repo);

        const entry = context.findEntry(request.to);
        if (!entry || !entry.available) {
          throw new DelegationError("agent_unavailable", `Target agent "${request.to}" is not available.`);
        }

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

        const now = new Date().toISOString();
        const id = `run_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
        const branchName = `portico/${id}`;
        const worktreePath = join(repoPath, ".portico", "worktrees", id);
        const artifacts = artifactPaths(repoPath, id);
        run = {
          id,
          repoPath,
          worktreePath,
          branchName,
          rootAgent: request.from ?? "unknown",
          targetAgent: request.to,
          task: request.task,
          mode: request.mode ?? "implement",
          status: "created",
          depth: request.depth ?? 0,
          createdAt: now,
          updatedAt: now,
        };

        await mkdir(dirname(artifacts.taskPath), { recursive: true });
        await writeJson(artifacts.taskPath, { ...effectiveRequest, repo: repoPath });
        await saveRun(run);
        await writeFile(artifacts.eventsPath, "");
        yield await recordEvent(artifacts.eventsPath, { type: "run_start", runId: run.id, status: run.status });

        run = await updateRun(run, { status: "planning", startedAt: new Date().toISOString() });
        await createWorktree(repoPath, worktreePath, branchName);
        yield await recordEvent(artifacts.eventsPath, {
          type: "worktree_created",
          runId: run.id,
          path: worktreePath,
          branch: branchName,
        });

        run = await updateRun(run, { status: "running" });
        yield await recordEvent(artifacts.eventsPath, { type: "agent_start", runId: run.id, agent: request.to });
        controller = new AbortController();
        activeControllers.set(run.id, controller);

        const agentEvents: RuntimeEvent[] = [];
        const chat: ChatRequest = {
          provider: request.to,
          messages: [{ role: "user", content: buildDelegationPrompt(run, effectiveRequest, defaultForbidden) }],
          options: {
            cwd: worktreePath,
            timeoutMs: request.timeoutMs,
            // Delegation runs in an isolated worktree, so let the agent edit files autonomously.
            autoEdit: true,
          },
        };

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

        const { diff, changedFiles } = await generateDiff(worktreePath);
        await writeFile(artifacts.diffPath as string, diff);
        enforcePathPolicy(changedFiles, effectiveRequest, defaultForbidden);
        yield await recordEvent(artifacts.eventsPath, {
          type: "diff_ready",
          runId: run.id,
          path: artifacts.diffPath as string,
          changedFiles,
        });

        run = await updateRun(run, { status: "testing" });
        const tests: TestResult[] = [];
        for (const command of testCommands) {
          yield await recordEvent(artifacts.eventsPath, { type: "test_start", runId: run.id, command });
          const result = await runTestCommand(worktreePath, command, request.timeoutMs);
          tests.push(result);
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
          status: failedTest ? "failed" : "ready",
          completedAt: new Date().toISOString(),
        });
        const result: RunResult = { run, artifacts, changedFiles, tests, agentEvents };
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
        if (run) {
          const artifacts = artifactPaths(run.repoPath, run.id);
          const status = controller?.signal.aborted ? "cancelled" : "failed";
          run = await updateRun(run, { status, completedAt: new Date().toISOString() });
          const result: RunResult = { run, artifacts, changedFiles: [], tests: [], agentEvents: [], error };
          await writeJson(artifacts.resultPath, result);
          await writeReport(artifacts.reportPath, result);
          yield await recordEvent(artifacts.eventsPath, { type: "run_error", runId: run.id, error, code });
        } else {
          yield { type: "run_error", error, code };
        }
      } finally {
        if (run) activeControllers.delete(run.id);
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
  if (request.mode && request.mode !== "implement") {
    throw new DelegationError(
      "mode_unsupported",
      `Mode "${request.mode}" is not available in this version yet; only "implement" is supported.`,
    );
  }
  if ((request.depth ?? 0) >= maxDepth) {
    throw new DelegationError("delegation_depth_exceeded", `Delegation depth ${request.depth ?? 0} exceeds max ${maxDepth}.`);
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

async function createWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
  await mkdir(dirname(worktreePath), { recursive: true });
  const result = await capture("git", ["-C", repoPath, "worktree", "add", "-b", branchName, worktreePath, "HEAD"]);
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
  return [
    "You are running inside a Portico delegation worktree.",
    `Run id: ${run.id}`,
    `Mode: ${run.mode}`,
    `Task: ${request.task}`,
    "",
    "Constraints:",
    "- Modify only files needed for the task.",
    `- Allowed paths: ${allowed}.`,
    `- Forbidden paths: ${forbidden.join(", ")}.`,
    "- Do not run portico delegate or delegate this task again.",
    "- Do not apply patches to the caller's main working tree.",
    "",
    "Known test commands:",
    tests,
    "",
    "Complete the requested coding work in this worktree and leave changes on disk.",
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

async function runTestCommand(cwd: string, command: string, timeoutMs?: number): Promise<TestResult> {
  const result = await capture("sh", ["-lc", command], { cwd, timeoutMs });
  return {
    command,
    status: result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    output: `${result.stdout}${result.stderr}`,
  };
}

async function assertTrackedTreeClean(repoPath: string): Promise<void> {
  const status = await capture("git", ["-C", repoPath, "status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) throw new DelegationError("git_failed", status.stderr || status.stdout);
  if (status.stdout.trim()) {
    throw new DelegationError("working_tree_dirty", "Current working tree has tracked changes; commit or stash before apply.");
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
  const testLines = tests.length
    ? tests.map((test) => `Command: ${test.command}\nStatus: ${test.status}\nExit Code: ${test.exitCode ?? "null"}`).join("\n\n")
    : "No tests configured.";
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
    `Branch: ${run.branchName}`,
    "",
    `Worktree: ${run.worktreePath}`,
    "",
    "## Changed Files",
    "",
    changedFiles.length ? changedFiles.map((file, index) => `${index + 1}. ${file}`).join("\n") : "No file changes detected.",
    "",
    "## Test Result",
    "",
    testLines,
    "",
    "## Review",
    "",
    `Decision: ${run.status === "ready" ? "approve" : "needs_attention"}`,
    "",
    error ? `Summary: ${error}` : "Summary: Review the diff before applying.",
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
  ].join("\n");
  await writeFile(path, body);
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
