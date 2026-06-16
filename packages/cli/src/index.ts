#!/usr/bin/env node
// @portico/cli — the `portico` command. Dispatches to start / agents / doctor.

import { startCommand } from "./commands/start.ts";
import { agentsCommand } from "./commands/agents.ts";
import { doctorCommand } from "./commands/doctor.ts";

const USAGE = `Portico — a local Agent runtime bridge.

Usage:
  portico start [options]     Start the local daemon (HTTP/NDJSON)
  portico agents [--json]     List Agents discovered on this machine
  portico doctor [--config p] Diagnose discovery, config, ports and security

start options:
  --host <host>               Bind host (default 127.0.0.1)
  --port <port>               Bind port (default 8787)
  --lan                       Expose beyond loopback (requires --token)
  --token <token>             Bearer token for authenticated requests
  --allow-origin <origin>     Extra CORS origin (repeatable)
  --config <path>             Config file (default ~/.portico/config.json)
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "start":
      return startCommand(rest);
    case "agents":
      return agentsCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(`[portico] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
