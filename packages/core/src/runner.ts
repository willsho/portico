// Low-level child-process streaming primitive. Everything dangerous about driving
// an external binary lives here: timeout watchdog, max output cap, cancellation,
// and guaranteed cleanup. Adapters build on top of this; they never spawn directly.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface SpawnStreamOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then stdin is closed. */
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export type ProcessEvent =
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      outputLimited: boolean;
      cancelled: boolean;
      error?: string;
    };

/**
 * Spawn a command and stream stdout/stderr chunks as they arrive. The final
 * yielded event is always `{ type: "exit", ... }`. Breaking out of the consuming
 * loop early kills the child.
 */
export async function* spawnStream(
  command: string,
  args: string[],
  options: SpawnStreamOptions = {},
): AsyncGenerator<ProcessEvent, void, void> {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const queue: ProcessEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let emittedExit = false;

  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const push = (event: ProcessEvent) => {
    if (event.type === "exit") {
      if (emittedExit) return;
      emittedExit = true;
      finished = true;
    }
    queue.push(event);
    notify();
  };

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputLimited = false;
  let cancelled = false;

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const kill = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // already dead
    }
  };

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          kill("SIGKILL");
        }, timeoutMs)
      : null;
  if (timer) timer.unref?.();

  const onAbort = () => {
    cancelled = true;
    kill("SIGKILL");
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const enforceLimit = () => {
    if (stdoutBytes + stderrBytes > maxBytes) {
      outputLimited = true;
      kill("SIGKILL");
    }
  };

  child.stdout?.on("data", (buf: Buffer) => {
    stdoutBytes += buf.length;
    push({ type: "stdout", chunk: buf.toString("utf8") });
    enforceLimit();
  });
  child.stderr?.on("data", (buf: Buffer) => {
    stderrBytes += buf.length;
    push({ type: "stderr", chunk: buf.toString("utf8") });
    enforceLimit();
  });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  child.on("error", (err: Error) => {
    cleanup();
    push({
      type: "exit",
      code: null,
      signal: null,
      timedOut,
      outputLimited,
      cancelled,
      error: err.message,
    });
  });
  child.on("close", (code, signal) => {
    cleanup();
    push({ type: "exit", code, signal, timedOut, outputLimited, cancelled });
  });

  // Feed stdin. Ignore EPIPE if the child has already exited.
  if (child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  }

  try {
    while (true) {
      if (queue.length > 0) {
        const event = queue.shift() as ProcessEvent;
        yield event;
        if (event.type === "exit") return;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    cleanup();
    if (!emittedExit) kill("SIGKILL");
  }
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

/** Run a command to completion and buffer its output. Used for `--version` probes. */
export async function capture(
  command: string,
  args: string[],
  options: SpawnStreamOptions = {},
): Promise<CaptureResult> {
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  let timedOut = false;
  let error: string | undefined;

  for await (const event of spawnStream(command, args, options)) {
    if (event.type === "stdout") stdout += event.chunk;
    else if (event.type === "stderr") stderr += event.chunk;
    else {
      code = event.code;
      timedOut = event.timedOut;
      error = event.error;
    }
  }

  return { stdout, stderr, code, timedOut, error };
}

/**
 * Run a read-only probe (version / capability help) to completion. Defaults the
 * working directory to the OS temp dir so a discovery probe never inherits — or
 * writes lockfiles/caches into — the user's repo. Callers can still pin a cwd.
 */
export async function captureProbe(
  command: string,
  args: string[],
  options: SpawnStreamOptions = {},
): Promise<CaptureResult> {
  // Spread first so an explicit `cwd: undefined` can't clobber the temp-dir default.
  return capture(command, args, {
    ...options,
    cwd: options.cwd ?? tmpdir(),
  });
}
