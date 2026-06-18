// `portico daemon stop` — signal the daemon recorded in the pid file and clean up.
// Idempotent: a missing pid file or an already-dead process is reported, not an error.

import { parseArgs } from "node:util";
import { daemonPidPath, isProcessAlive, readDaemonPid, removeDaemonPid } from "../pidfile.ts";

export async function stopCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { timeout: { type: "string" } } });

  const info = readDaemonPid();
  if (!info) {
    console.log(`No running Portico daemon recorded at ${daemonPidPath()}.`);
    return 0;
  }
  if (!isProcessAlive(info.pid)) {
    removeDaemonPid();
    console.log(`Portico daemon (pid ${info.pid}) was not running; removed stale pid file.`);
    return 0;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (err) {
    console.error(`[portico] could not signal daemon pid ${info.pid}: ${(err as Error).message}`);
    return 1;
  }

  const timeoutMs = Number(values.timeout ?? "5000");
  if (!(await waitForExit(info.pid, Number.isFinite(timeoutMs) ? timeoutMs : 5000))) {
    // Graceful stop timed out — force it.
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      // already gone between the check and the kill
    }
    await waitForExit(info.pid, 2000);
  }

  removeDaemonPid();
  console.log(`Stopped Portico daemon (pid ${info.pid}) at ${info.url}.`);
  return 0;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}
