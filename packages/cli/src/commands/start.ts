// `portico start` — resolve config (CLI > env > file > defaults) and run the daemon.

import { parseArgs } from "node:util";
import { createDaemon } from "@portico/daemon";
import { resolveConfig } from "@portico/daemon";
import type { DaemonConfig } from "@portico/daemon";
import { isPorticoError } from "@portico/core";

export async function startCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      lan: { type: "boolean" },
      token: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      config: { type: "string" },
    },
  });

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

  const daemon = createDaemon({ config });

  try {
    await daemon.start();
  } catch (err) {
    if (isPorticoError(err)) {
      console.error(`[portico] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const shutdown = () => {
    console.log("\n[portico] shutting down…");
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Resolve never — the server keeps the event loop alive until a signal arrives.
  return new Promise<number>(() => {});
}
