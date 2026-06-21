import type { RuntimeEvent } from "@portico/core";

export type DelegationMode = "implement" | "review" | "compare" | "split";

export type WorkspaceIsolationMode = "worktree" | "shared";

export type CleanupPolicy = "manual" | "onNoChanges" | "onSuccess" | "always";

export type PermissionProfile = "default" | "read-only" | "auto-edit";

export interface WorkspaceIsolation {
  workspace: WorkspaceIsolationMode;
  /** Git ref used when creating an isolated worktree. Defaults to HEAD. */
  baseRef?: string;
  /** When Portico may remove the isolated worktree automatically. */
  cleanup?: CleanupPolicy;
}

export type RunStatus =
  | "created"
  | "planning"
  | "running"
  | "testing"
  | "reviewing"
  | "ready"
  | "partial"
  | "conflict"
  | "failed"
  | "cancelled"
  | "applied"
  | "discarded";

export type RunRole = "single" | "group" | "child";

export interface ChildSpec {
  /** Target agent provider. */
  to: string;
  /** Child run task. In compare mode omitted (inherits group task). */
  task?: string;
  /** Override permission profile; omitted to derive from mode/isolation. */
  permissionProfile?: PermissionProfile;
  /** Model override (adapter-supporting passthrough, e.g. Claude). */
  model?: string;
  /** Reasoning effort override (adapter-supporting passthrough). */
  effort?: string;
  /** Per-child path policy, overrides group-level defaults. */
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  /** Display label for distinguishing children in concurrent views. */
  label?: string;
}

/** Optional judge: a review child that ranks compare candidates / vets a split merge. */
export interface FanInJudge {
  /** Judge agent provider. */
  to: string;
  /** Review instruction (defaults to: rank by task fit, correctness, maintainability). */
  instruction?: string;
}

/** Phase 3 fan-in behaviour: how N child results are converged. */
export interface FanInPolicy {
  /** Patch merge strategy. Defaults by mode: compare → "none", split → "integration". */
  merge?: "none" | "sequential" | "integration";
  /** Optional judge: a review child that evaluates / ranks the candidate diffs. */
  judge?: FanInJudge;
}

export interface DelegateRequest {
  from?: string;
  to: string;
  /** Additional target agents for compare mode. */
  compareTargets?: string[];
  /** Explicit fan-out: each ChildSpec produces one child run. */
  children?: ChildSpec[];
  /** Fan-out concurrency cap (overrides orchestrator default). */
  maxParallel?: number;
  /** Phase 3: fan-in behaviour (merge strategy + optional judge). */
  fanIn?: FanInPolicy;
  repo: string;
  task: string;
  /** Human-readable run name shown in listings; defaults to a slug of the task. */
  name?: string;
  mode?: DelegationMode;
  isolation?: WorkspaceIsolationMode | WorkspaceIsolation;
  /** Shorthand for `isolation.baseRef`. */
  baseRef?: string;
  /** Shorthand for `isolation.cleanup`. */
  cleanup?: CleanupPolicy;
  permissionProfile?: PermissionProfile;
  testCommands?: string[];
  /** Verification commands, semantically distinct from tests (e.g. doc/policy checks).
   *  Run through the same pipeline; a failure fails the run, but reported separately. */
  verifyCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  timeoutMs?: number;
  maxAutoFixAttempts?: number;
  depth?: number;
  /** Declare that producing no file changes is an expected, acceptable outcome.
   *  Suppresses the implement-mode no-change warning and keeps the review decision `approve`. */
  expectNoChanges?: boolean;
  /** Paths/patterns the caller expects this run to change. Drives the report's Coverage section
   *  and a coverage-gap warning when an expected path is left untouched. */
  expectedChangePaths?: string[];
}

export interface Run {
  id: string;
  repoPath: string;
  worktreePath: string;
  branchName: string;
  rootAgent: string;
  targetAgent: string;
  task: string;
  mode: DelegationMode;
  isolation: WorkspaceIsolation;
  permissionProfile: PermissionProfile;
  status: RunStatus;
  depth: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  worktreeRemovedAt?: string;
  /** Role in the fan-out structure. Defaults to "single" when absent (backward compat). */
  role?: RunRole;
  /** Child run points to its group run id; empty for group/single. */
  groupId?: string;
  /** Alias for groupId — group's id for a child. Equals groupId on child runs. */
  parentRunId?: string;
  /** Group run lists all of its child run ids; empty for child/single. */
  childRunIds?: string[];
  /** Display label (from ChildSpec.label) for distinguishing children. */
  label?: string;
  /** Human-readable name (from DelegateRequest.name, else a slug of the task). */
  name?: string;
  /** Target agent's native session id, captured from adapter start event. */
  agentSessionId?: string;
  /** Caller declared no file changes is an acceptable outcome (from DelegateRequest). */
  expectNoChanges?: boolean;
  /** Paths/patterns the caller expects this run to change (from DelegateRequest). */
  expectedChangePaths?: string[];
}

export interface RunArtifact {
  runId: string;
  taskPath: string;
  eventsPath: string;
  agentLogPath: string;
  testLogPath?: string;
  diffPath?: string;
  reportPath: string;
  resultPath: string;
}

export interface TestResult {
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationMs?: number;
}

export interface OutOfTreeChange {
  path: string;
  status: string;
  raw: string;
}

/** Raw `git diff` views captured at diff time so the report is a single source of
 *  truth — no need to re-run `git diff --name-status / --stat / --check` by hand. */
export interface DiffSummary {
  /** `git diff --name-status HEAD` — distinguishes added(new) / modified / deleted / renamed. */
  nameStatus: string;
  /** `git diff --stat HEAD`. */
  stat: string;
  /** `git diff --check HEAD` — trailing whitespace and conflict markers (empty when clean). */
  check: string;
}

/** Coverage of the caller's `--expected-change` declaration: which expected paths were actually
 *  changed (touched), which were left untouched (gaps), and which changed files were unexpected.
 *  Path policy guards the *boundary* (no out-of-scope edits); coverage guards *completeness*. */
export interface CoverageResult {
  /** The expected patterns the caller declared. */
  expected: string[];
  /** Expected patterns matched by at least one changed file. */
  touched: string[];
  /** Expected patterns with no matching changed file — the coverage gaps. */
  untouched: string[];
  /** Changed files matching none of the expected patterns. */
  unexpected: string[];
}

/** Whether the run's changed files stayed within the `--allowed` / `--forbidden` boundary. */
export interface PathPolicyResult {
  status: "passed" | "failed";
  /** The allowed patterns in effect ([] means all repo paths permitted). */
  allowed: string[];
  /** Changed files that hit a forbidden pattern. */
  forbidden: string[];
  /** Changed files outside the allowed set. */
  notAllowed: string[];
  /** Paths to add to `--allowed` to make a retry pass (forbidden ∪ notAllowed). */
  retryAllowed?: string[];
}

export interface UsageTelemetry {
  available: boolean;
  raw?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  unavailableReason?: string;
}

export interface RunTelemetry {
  totalDurationMs: number;
  agentDurationMs?: number;
  /** Time spent creating the isolated worktree (single/child runs; absent for shared/resume). */
  worktreeSetupMs?: number;
  /** Time spent generating the diff after the agent finished (single/child runs). */
  diffMs?: number;
  /** Time spent in `--test` commands (tests only; `--verify` is tracked in `verifyMs`). */
  testDurationMs: number;
  /** Time spent in `--verify` commands, split out from testDurationMs. */
  verifyMs?: number;
  /** Group runs: wall time spent in the fan-in phase (merge + judge). */
  fanInMs?: number;
  usage: UsageTelemetry;
}

export type DelegationEvent =
  | { type: "run_start"; runId: string; status: RunStatus }
  | { type: "worktree_created"; runId: string; path: string; branch: string }
  | { type: "agent_start"; runId: string; agent: string }
  | { type: "agent_event"; runId: string; event: RuntimeEvent }
  | { type: "sandbox_escape_detected"; runId: string; changes: OutOfTreeChange[] }
  | { type: "test_start"; runId: string; command: string }
  | { type: "test_done"; runId: string; command: string; status: "passed" | "failed"; exitCode: number | null }
  | { type: "diff_ready"; runId: string; path: string; changedFiles: string[] }
  | { type: "fanin_start"; runId: string; strategy: "merge" | "judge" }
  | { type: "merge_done"; runId: string; status: "ready" | "conflict"; conflicts?: string[] }
  | { type: "judge_done"; runId: string; recommendedChildId?: string; verdict?: "approve" | "needs_attention" }
  | { type: "run_done"; runId: string; status: RunStatus; reportPath: string; resultPath: string }
  | { type: "run_error"; runId?: string; error: string; code?: string };

export interface RunResult {
  run: Run;
  artifacts: RunArtifact;
  changedFiles: string[];
  tests: TestResult[];
  /** Results of `--verify` commands (doc/policy checks), reported separately from tests. */
  verify?: TestResult[];
  agentEvents: RuntimeEvent[];
  /** Group run: child results (canonical name; supersedes compareResults). */
  childResults?: RunResult[];
  /** Legacy alias; read both, write childResults. */
  compareResults?: RunResult[];
  /** Group run: aggregate status summary. */
  groupSummary?: {
    total: number;
    ready: number;
    failed: number;
    cancelled: number;
  };
  /** Split group: fan-in merge outcome (omitted for compare / un-merged groups). */
  merge?: {
    strategy: "sequential" | "integration";
    status: "ready" | "conflict";
    /** Integration worktree the merge ran in (kept for inspection). */
    integrationWorktree?: string;
    /**
     * What kind of conflict stopped the merge (only when status=conflict):
     * - `overlap`: two children edited the same region — a real three-way merge conflict.
     * - `apply_failure`: a child's own patch did not apply to the group base at all
     *   (e.g. drifted context, malformed diff) — not an inter-child overlap.
     */
    conflictKind?: "overlap" | "apply_failure";
    /** The raw `git apply` reason (first meaningful stderr line) explaining the failure. */
    conflictReason?: string;
  };
  /** Split group: per-file merge conflicts and their source child (when status=conflict). */
  conflicts?: Array<{ file: string; child: string; kind?: "overlap" | "apply_failure"; line?: number }>;
  /** Set on a group's childResults entries: whether this child's own patch applies cleanly to
   *  the group base. Proactively surfaces apply failures that file-name overlap can't explain
   *  (a child can fail to apply on a file only it touched). Read-only; computed at fan-in. */
  applyCheck?: {
    applies: boolean;
    /** First `git apply --check` error line when the patch does not apply. */
    reason?: string;
    /** Specific failing files (and hunk line, when git reports it). */
    failures?: Array<{ file: string; line?: number }>;
  };
  /** Fan-in judge verdict (compare: ranking + recommendation; split: overall verdict). */
  judge?: {
    to: string;
    /** The review run id, for `portico status <runId>`. */
    runId?: string;
    /** compare: which child the judge recommends applying. */
    recommendedChildId?: string;
    ranking?: Array<{ childId: string; score?: number; note: string }>;
    verdict?: "approve" | "needs_attention";
  };
  sandboxEscaped?: boolean;
  outOfTreeChanges?: OutOfTreeChange[];
  agentGateMismatch?: boolean;
  gateWarnings?: string[];
  /** Portico's own review verdict, derived from observed facts (not the agent's self-report).
   *  `needs_attention` when the run is not ready, or ready-but-suspect (e.g. an implement-mode
   *  run that produced no changes without `--expect-no-changes`). Otherwise `approve`. */
  reviewDecision?: "approve" | "needs_attention";
  /** Grouped diff views (name-status / stat / check) for review without re-running git. */
  diffSummary?: DiffSummary;
  /** Allowed/forbidden path-policy outcome, with retry paths when it failed. */
  pathPolicy?: PathPolicyResult;
  /** Coverage of `--expected-change`: expected/touched/untouched/unexpected (when declared). */
  coverage?: CoverageResult;
  telemetry?: RunTelemetry;
  error?: string;
}

/** Live progress for a run, computed at query time (not persisted): the current phase,
 *  whether an agent process is still executing, and the last recorded event. */
export interface RunProgress {
  /** Current lifecycle phase (mirrors run.status). */
  phase: RunStatus;
  /** True when this run (or, for a group, any child) has a live agent controller. */
  active: boolean;
  /** Last event recorded to the run's event log, with the log's last-write time. */
  lastEvent?: { type: string; at: string };
}

export interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
  /** Live progress (phase / active / last event), attached by getRun. */
  progress?: RunProgress;
}

/** Filters for listRuns, applied server-side before folding. */
export interface ListRunsOptions {
  /** Return the flat list (no group folding). */
  flat?: boolean;
  /** Keep only runs whose status is in this set. */
  status?: RunStatus[];
  /** Keep only runs created within the last `sinceMs` milliseconds. */
  sinceMs?: number;
}

/** Options for cleanup: which runs to reclaim and how aggressively. */
export interface CleanupOptions {
  /** Target failed + cancelled runs (the default when no explicit status is given). */
  failed?: boolean;
  /** Explicit status allow-list; overrides `failed`. ready/applied are never touched. */
  status?: RunStatus[];
  /** Only reclaim runs completed/updated more than this many ms ago. */
  olderThanMs?: number;
  /** Also delete artifacts (report/diff/events), not just the worktree. */
  purge?: boolean;
}

export interface CleanupResult {
  cleaned: Array<{ id: string; status: RunStatus; worktreeRemoved: boolean; purged: boolean }>;
  /** Runs examined but left untouched (protected status, filtered out, or in-flight). */
  skipped: number;
}

/** Outcome of an on-demand `integrate`: the merge result over a group's ready children. */
export interface IntegrateResult {
  details: RunDetails;
  status: "ready" | "conflict";
  /** Children merged, in apply order. */
  order: Array<{ id: string; label?: string }>;
  /** Per-file conflicts with their source child (only when status=conflict). */
  conflicts?: Array<{ file: string; child: string }>;
  /** Merged patch path (only on a clean merge). */
  mergedDiffPath?: string;
}

export interface OrchestratorOptions {
  maxDepth?: number;
  maxConcurrentRunsPerRepo?: number;
  /** Max candidate runs executed concurrently within one fan-out (e.g. compare). Defaults to 4. */
  maxConcurrentAgentProcesses?: number;
  defaultForbiddenPaths?: string[];
}
