// `portico start` — resolve config (CLI > env > file > defaults) and run the daemon.

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { createDaemon } from "@portico/daemon";
import { resolveConfig } from "@portico/daemon";
import type { DaemonConfig } from "@portico/daemon";
import { isPorticoError } from "@portico/core";
import { daemonPidPath, isProcessAlive, readDaemonPid, removeDaemonPid, writeDaemonPid } from "../pidfile.ts";

interface Preflight {
  /** Whether the daemon pidfile can be written (governs stop/discovery support). */
  pidWritable: boolean;
  warnings: string[];
}

/**
 * Surface sandbox/permission problems *before* the daemon claims to be up, so a user
 * isn't told "listening" only to have the first `delegate` fail on an unwritable worktree
 * dir. Checks the pidfile location and — when started from inside a repo — that repo's
 * `.portico` and `.git` dirs. None of these are fatal on their own; we warn and continue.
 */
function preflightStart(): Preflight {
  const warnings: string[] = [];

  // Pidfile writability: needed so `portico stop` / discovery can find this daemon later.
  let pidWritable = true;
  const pidDir = dirname(daemonPidPath());
  try {
    mkdirSync(pidDir, { recursive: true });
    accessSync(pidDir, constants.W_OK);
  } catch {
    pidWritable = false;
    warnings.push(
      `pidfile dir not writable (${pidDir}) — the daemon will run, but \`portico stop\` and discovery will be limited.`,
    );
  }

  // If started inside a repo, that repo's run/worktree dirs must be writable for delegate.
  const cwd = process.cwd();
  if (existsSync(join(cwd, ".git"))) {
    for (const rel of [".portico", ".git"]) {
      const target = join(cwd, rel);
      try {
        if (existsSync(target)) accessSync(target, constants.W_OK);
        else accessSync(cwd, constants.W_OK);
      } catch {
        warnings.push(
          `${rel} under ${cwd} is not writable — delegations here will fail to create worktrees. ` +
            `A sandbox is likely blocking writes; grant write access or run outside the sandbox.`,
        );
      }
    }
  }

  return { pidWritable, warnings };
}

export async function startCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      host: { type: "string" },
      port: { type: "string" },
      lan: { type: "boolean" },
      token: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      config: { type: "string" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico start [options]

Options:
  --host <host>            Bind host
  --port <port>            Bind port
  --lan                    Expose beyond loopback
  --token <token>          Auth token
  --allow-origin <origin>  Extra CORS origin (repeatable)
  --config <path>          Config file path
  -h, --help               Show this help message`);
    return 0;
  }

  const overrides: Partial<DaemonConfig> = {};
  if (values.host) overrides.host = values.host;
  if (values.port) overrides.port = Number(values.port);
  if (values.lan) overrides.lan = true;
  if (values.token) overrides.token = values.token;
  if (values["allow-origin"]) overrides.allowOrigins = values["allow-origin"];

  const { config, sources } = resolveConfig({
    overrides,
    ...(values.config ? { configPath: values.config } : {}),
  });

  if (sources.configError) {
    console.warn(`[portico] config at ${sources.configPath} could not be read: ${sources.configError}`);
  }

  const preflight = preflightStart();
  for (const warning of preflight.warnings) console.warn(`[portico] ${warning}`);

  const existing = readDaemonPid();
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      console.log(`[portico] daemon already running (pid ${existing.pid}, port ${existing.port}, ${existing.url})`);
      return 0;
    }
    removeDaemonPid();
  }

  const daemon = createDaemon({ config });

  let info: { host: string; port: number; url: string };
  try {
    info = await daemon.start();
  } catch (err) {
    if (isPorticoError(err)) {
      console.error(`[portico] ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Record the running daemon so `portico daemon stop` can find and signal it. When the
  // pidfile isn't writable the daemon is still usable for delegations over its URL — we just
  // can't support `portico stop` / discovery, so say so instead of failing the start.
  if (preflight.pidWritable) {
    try {
      writeDaemonPid({ pid: process.pid, ...info, startedAt: new Date().toISOString() });
    } catch (err) {
      console.warn(`[portico] could not write pidfile: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("[portico] daemon is usable, but `portico stop` and discovery are limited.");
    }
  } else {
    console.warn("[portico] daemon is usable, but `portico stop` and discovery are limited (no pidfile).");
  }

  const shutdown = () => {
    console.log("\n[portico] shutting down…");
    removeDaemonPid();
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Resolve never — the server keeps the event loop alive until a signal arrives.
  return new Promise<number>(() => {});
}
