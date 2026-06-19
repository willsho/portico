// `portico start` — resolve config (CLI > env > file > defaults) and run the daemon.

import { parseArgs } from "node:util";
import { createDaemon } from "@portico/daemon";
import { resolveConfig } from "@portico/daemon";
import type { DaemonConfig } from "@portico/daemon";
import { isPorticoError } from "@portico/core";
import { isProcessAlive, readDaemonPid, removeDaemonPid, writeDaemonPid } from "../pidfile.ts";

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

  // Record the running daemon so `portico daemon stop` can find and signal it.
  writeDaemonPid({ pid: process.pid, ...info, startedAt: new Date().toISOString() });

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
