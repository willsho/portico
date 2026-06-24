// Lifecycle gate hooks: user-declared commands that can block a delegation at its two
// "before-action" decision points — `preLaunch` (after the worktree exists, before the agent
// launches) and `preApply` (before a patch lands in the main tree). Configured per repo in
// `.portico/config.json` under `hooks`. Each hook receives the event payload as JSON on stdin;
// a non-zero exit (or a timeout) BLOCKS the action. The gate is fail-closed on purpose: a
// crashing or hanging policy check must never silently let an apply through.
//
// "After"/reaction hooks (postRun / onReady / onFailed) and per-profile hooks are a separate,
// lower-priority concern and are intentionally not part of this surface yet.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type HookEvent = "preLaunch" | "preApply";

const HOOK_EVENTS: readonly HookEvent[] = ["preLaunch", "preApply"];
const DEFAULT_TIMEOUT_MS = 60_000;

export interface HookSpec {
  /** Shell command. Receives the event payload as JSON on stdin. */
  command: string;
  /** Per-hook timeout (ms). Default 60s. A timed-out gate blocks (fail-closed). */
  timeoutMs?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookSpec[]>>;

export interface HookPayload {
  event: HookEvent;
  runId: string;
  repo: string;
  worktree: string;
  mode: string;
  targetAgent: string;
  [key: string]: unknown;
}

export interface GateResult {
  blocked: boolean;
  reason?: string;
}

/** Read and validate the `hooks` block from a repo's `.portico/config.json`. Missing or malformed → no hooks. */
export async function readHooksConfig(repoPath: string): Promise<HooksConfig> {
  try {
    const config = JSON.parse(await readFile(join(repoPath, ".portico", "config.json"), "utf8")) as { hooks?: unknown };
    return normalizeHooks(config.hooks);
  } catch {
    return {};
  }
}

/** Coerce arbitrary JSON into a HooksConfig, dropping entries that aren't `{ command }` specs. */
export function normalizeHooks(raw: unknown): HooksConfig {
  if (!raw || typeof raw !== "object") return {};
  const out: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    const specs = (raw as Record<string, unknown>)[event];
    if (!Array.isArray(specs)) continue;
    const cleaned: HookSpec[] = [];
    for (const spec of specs) {
      if (spec && typeof spec === "object" && typeof (spec as HookSpec).command === "string" && (spec as HookSpec).command.length > 0) {
        const s = spec as HookSpec;
        cleaned.push({ command: s.command, ...(typeof s.timeoutMs === "number" ? { timeoutMs: s.timeoutMs } : {}) });
      }
    }
    if (cleaned.length) out[event] = cleaned;
  }
  return out;
}

/**
 * Run every gate hook for `payload.event` in order. The first hook to exit non-zero (or time
 * out, or fail to spawn) blocks the action and its message is returned; otherwise the gate
 * passes. `cwd` is where the command runs — the worktree for preLaunch, the repo for preApply.
 */
export async function runGateHooks(hooks: HooksConfig, payload: HookPayload, cwd: string): Promise<GateResult> {
  const specs = hooks[payload.event];
  if (!specs?.length) return { blocked: false };
  for (const spec of specs) {
    const res = await runHookCommand(spec, payload, cwd);
    if (res.timedOut) {
      return { blocked: true, reason: `${payload.event} hook timed out after ${spec.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${spec.command}` };
    }
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      return { blocked: true, reason: `${payload.event} hook blocked (exit ${res.code}): ${spec.command}${detail ? `\n${detail}` : ""}` };
    }
  }
  return { blocked: false };
}

function runHookCommand(
  spec: HookSpec,
  payload: HookPayload,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, {
      cwd,
      shell: true,
      env: { ...process.env, PORTICO_HOOK_EVENT: payload.event },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    });
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin may already be closed if the command exited immediately; ignore.
    }
  });
}
