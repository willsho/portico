import type { RuntimeEvent } from "@portico/core";

export type DelegationMode = "implement" | "review" | "compare";

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
  | "failed"
  | "cancelled"
  | "applied"
  | "discarded";

export interface DelegateRequest {
  from?: string;
  to: string;
  /** Additional target agents for compare mode. */
  compareTargets?: string[];
  repo: string;
  task: string;
  mode?: DelegationMode;
  isolation?: WorkspaceIsolationMode | WorkspaceIsolation;
  /** Shorthand for `isolation.baseRef`. */
  baseRef?: string;
  /** Shorthand for `isolation.cleanup`. */
  cleanup?: CleanupPolicy;
  permissionProfile?: PermissionProfile;
  testCommands?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  timeoutMs?: number;
  maxAutoFixAttempts?: number;
  depth?: number;
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
  testDurationMs: number;
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
  | { type: "run_done"; runId: string; status: RunStatus; reportPath: string; resultPath: string }
  | { type: "run_error"; runId?: string; error: string; code?: string };

export interface RunResult {
  run: Run;
  artifacts: RunArtifact;
  changedFiles: string[];
  tests: TestResult[];
  agentEvents: RuntimeEvent[];
  compareResults?: RunResult[];
  sandboxEscaped?: boolean;
  outOfTreeChanges?: OutOfTreeChange[];
  agentGateMismatch?: boolean;
  gateWarnings?: string[];
  telemetry?: RunTelemetry;
  error?: string;
}

export interface RunDetails {
  run: Run;
  artifacts: RunArtifact;
  result?: RunResult;
}

export interface OrchestratorOptions {
  maxDepth?: number;
  maxConcurrentRunsPerRepo?: number;
  /** Max candidate runs executed concurrently within one fan-out (e.g. compare). Defaults to 4. */
  maxConcurrentAgentProcesses?: number;
  defaultForbiddenPaths?: string[];
}
