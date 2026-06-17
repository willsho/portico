import type { RuntimeEvent } from "@portico/core";

export type DelegationMode = "implement" | "review" | "compare";

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
  repo: string;
  task: string;
  mode?: Extract<DelegationMode, "implement" | "review">;
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
  status: RunStatus;
  depth: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
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
}

export type DelegationEvent =
  | { type: "run_start"; runId: string; status: RunStatus }
  | { type: "worktree_created"; runId: string; path: string; branch: string }
  | { type: "agent_start"; runId: string; agent: string }
  | { type: "agent_event"; runId: string; event: RuntimeEvent }
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
  defaultForbiddenPaths?: string[];
}
