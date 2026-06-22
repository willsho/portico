// A single, trustworthy readout of a (single-run-shaped) terminal state — the same facts
// `--review-summary` used to print on request, structured so callers never have to
// cross-reference report.md / result.json / a separate review call to know what happened.

import type { DiffSummary, PathPolicyResult, Run, RunResult, RunStatus, TestResult } from "./types.ts";

export interface TestTally {
  total: number;
  passed: number;
  failed: number;
}

export interface RunVerdict {
  /** Mirrors `run.status`; duplicated here so the verdict is self-contained. */
  status: RunStatus;
  /** Portico's own approve/needs_attention call (see RunResult.reviewDecision). */
  reviewDecision?: "approve" | "needs_attention";
  /** One-glance readout: ready (approve), needs_attention (ready but flagged), or
   *  not_ready (failed / cancelled / still running). */
  readiness: "ready" | "needs_attention" | "not_ready";
  changedFiles: string[];
  diffSummary?: DiffSummary;
  tests: TestTally;
  verify: TestTally;
  pathPolicy?: PathPolicyResult;
  sandboxEscaped: boolean;
  /** Flattened, human-readable risk lines: path-policy hits, test/verify tallies,
   *  sandbox escape, gate warnings — what `--review-summary` printed, as data. */
  topRisks: string[];
}

function tally(checks: TestResult[] | undefined): TestTally {
  const list = checks ?? [];
  return {
    total: list.length,
    passed: list.filter((c) => c.status === "passed").length,
    failed: list.filter((c) => c.status === "failed").length,
  };
}

function buildTopRisks(result: RunResult | undefined): string[] {
  const risks: string[] = [];
  if (result?.pathPolicy) {
    risks.push(`path policy: ${result.pathPolicy.status}`);
    if (result.pathPolicy.retryAllowed?.length) {
      risks.push(`out-of-scope: ${result.pathPolicy.retryAllowed.join(", ")}`);
    }
  }
  const tests = result?.tests ?? [];
  const verify = result?.verify ?? [];
  if (tests.length) risks.push(`tests: ${tests.filter((t) => t.status === "passed").length}/${tests.length} passed`);
  if (verify.length) risks.push(`verify: ${verify.filter((t) => t.status === "passed").length}/${verify.length} passed`);
  if (result?.sandboxEscaped) risks.push("sandbox escape: DETECTED");
  for (const w of result?.gateWarnings ?? []) risks.push(`warning: ${w}`);
  return risks;
}

function computeReadiness(run: Run, result: RunResult | undefined): RunVerdict["readiness"] {
  if (run.status !== "ready") return "not_ready";
  return result?.reviewDecision === "needs_attention" ? "needs_attention" : "ready";
}

export function buildRunVerdict(run: Run, result?: RunResult): RunVerdict {
  return {
    status: run.status,
    reviewDecision: result?.reviewDecision,
    readiness: computeReadiness(run, result),
    changedFiles: result?.changedFiles ?? [],
    diffSummary: result?.diffSummary,
    tests: tally(result?.tests),
    verify: tally(result?.verify),
    pathPolicy: result?.pathPolicy,
    sandboxEscaped: result?.sandboxEscaped ?? false,
    topRisks: buildTopRisks(result),
  };
}
