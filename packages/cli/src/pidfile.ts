// Tracks the locally running daemon so `portico daemon stop` can find and signal it.
// The daemon is a per-user, loopback singleton, so a single pid file under ~/.portico
// (alongside config.json) is enough. Override the path with PORTICO_PID_FILE.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DaemonPidInfo {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
}

export function daemonPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["PORTICO_PID_FILE"] ?? join(homedir(), ".portico", "daemon.pid");
}

export function writeDaemonPid(info: DaemonPidInfo, env: NodeJS.ProcessEnv = process.env): void {
  const path = daemonPidPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2));
}

export function readDaemonPid(env: NodeJS.ProcessEnv = process.env): DaemonPidInfo | null {
  try {
    const info = JSON.parse(readFileSync(daemonPidPath(env), "utf8")) as DaemonPidInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

export function removeDaemonPid(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(daemonPidPath(env), { force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Whether a process with this pid exists (EPERM still means it's alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
