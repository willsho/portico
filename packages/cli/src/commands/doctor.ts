// `portico doctor` — diagnose discovery, config, ports, and security posture.

import { parseArgs } from "node:util";
import { createServer } from "node:net";
import { discoverAgents, loginShellPath } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";
import { resolveConfig } from "@portico/daemon";

export async function doctorCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" } } });
  installBuiltinAdapters();

  console.log("Portico doctor");
  console.log("==============\n");

  console.log(`Node:     ${process.version}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);
  console.log(`Shell:    ${process.env["SHELL"] ?? "(unknown)"}\n`);

  const { config, sources } = resolveConfig(values.config ? { configPath: values.config } : {});
  console.log("Config");
  console.log(`  path:     ${sources.configPath}`);
  console.log(`  loaded:   ${sources.configLoaded ? "yes" : "no (using defaults)"}`);
  if (sources.configError) console.log(`  error:    ${sources.configError}`);
  if (sources.envApplied.length) console.log(`  env vars: ${sources.envApplied.join(", ")}`);
  console.log("");

  console.log("PATH resolution");
  const shellPath = await loginShellPath();
  if (shellPath) {
    const inherited = process.env["PATH"] ?? "";
    const extra = shellPath.split(":").filter((d) => d && !inherited.split(":").includes(d));
    console.log(`  login-shell PATH recovered ${extra.length} extra dir(s).`);
    if (extra.length) console.log(`    e.g. ${extra.slice(0, 4).join(", ")}`);
  } else {
    console.log("  login-shell PATH probe unavailable (non-POSIX or no shell).");
  }
  console.log("");

  console.log("Agents");
  const agents = await discoverAgents();
  for (const agent of agents) {
    const status = agent.available ? "available" : "not found";
    const bits = [
      `version=${agent.version ?? "?"}`,
      `status=${agent.versionStatus ?? "unknown"}`,
      `source=${agent.source ?? "-"}`,
    ];
    console.log(`  ${agent.provider.padEnd(10)} ${status.padEnd(12)} ${bits.join(" ")}`);
    if (agent.path) console.log(`             path: ${agent.path}`);
    if (agent.reason) console.log(`             note: ${agent.reason}`);
  }
  console.log("");

  console.log("Daemon");
  const portFree = await isPortFree(config.host, config.port);
  console.log(`  host:port: ${config.host}:${config.port} (${portFree ? "free" : "IN USE"})`);
  console.log(`  CORS:      localhost/127.0.0.1 always allowed${config.allowOrigins.length ? `, plus ${config.allowOrigins.join(", ")}` : ""}`);
  const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
  if (config.lan || !loopback) {
    console.log(`  LAN:       EXPOSED beyond loopback — token ${config.token ? "set" : "MISSING (daemon will refuse to start)"}.`);
  } else {
    console.log("  LAN:       disabled (loopback only).");
  }

  return 0;
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, () => {
      probe.close(() => resolve(true));
    });
  });
}
