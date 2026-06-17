#!/usr/bin/env node
// @portico/cli — the `portico` command. Dispatches to start / agents / doctor.

import { startCommand } from "./commands/start.ts";
import { agentsCommand } from "./commands/agents.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { delegateCommand } from "./commands/delegate.ts";
import { runsCommand, statusCommand, applyCommand, cancelCommand, discardCommand } from "./commands/runs.ts";
import { initCommand } from "./commands/init.ts";

const USAGE = `Portico — a local Agent runtime bridge.

Usage:
  portico init                Create .portico folders and local skills
  portico start [options]     Start the local daemon (HTTP/NDJSON)
  portico daemon start        Alias for portico start
  portico agents [--json]     List Agents discovered on this machine
  portico delegate --to a --task t [--test cmd]
  portico runs [--repo .]     List delegation runs
  portico status <run_id>     Show a delegation run
  portico cancel <run_id>     Cancel a delegation run
  portico apply <run_id>      Apply a ready run patch
  portico discard <run_id>    Remove a run worktree and keep artifacts
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
    case "init":
      return initCommand(rest);
    case "start":
      return startCommand(rest);
    case "daemon":
      if (rest[0] === "start") return startCommand(rest.slice(1));
      if (rest[0] === "stop") {
        console.error("portico daemon stop is not available without a daemon pid file yet. Stop the daemon process directly.");
        return 1;
      }
      console.error("Usage: portico daemon start");
      return 1;
    case "agents":
      return agentsCommand(rest);
    case "delegate":
      return delegateCommand(rest);
    case "runs":
      return runsCommand(rest);
    case "status":
      return statusCommand(rest);
    case "apply":
      return applyCommand(rest);
    case "cancel":
      return cancelCommand(rest);
    case "discard":
      return discardCommand(rest);
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
