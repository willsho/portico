import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopCommand } from "../src/commands/stop.ts";
import { writeDaemonPid } from "../src/pidfile.ts";

test("daemon stop signals the recorded pid and clears the pid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-pid-"));
  const pidFile = join(dir, "daemon.pid");
  process.env["PORTICO_PID_FILE"] = pidFile;
  // A child that just stays alive until signalled.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  assert.ok(child.pid, "expected the child to have a pid");
  try {
    writeDaemonPid({
      pid: child.pid,
      host: "127.0.0.1",
      port: 0,
      url: "http://127.0.0.1:0",
      startedAt: new Date().toISOString(),
    });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

    const code = await stopCommand([]);
    assert.equal(code, 0);

    await exited;
    assert.equal(existsSync(pidFile), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    delete process.env["PORTICO_PID_FILE"];
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon stop is idempotent with no pid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-pid-"));
  process.env["PORTICO_PID_FILE"] = join(dir, "daemon.pid");
  try {
    assert.equal(await stopCommand([]), 0);
  } finally {
    delete process.env["PORTICO_PID_FILE"];
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon stop removes a stale pid file when the process is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "portico-pid-"));
  const pidFile = join(dir, "daemon.pid");
  process.env["PORTICO_PID_FILE"] = pidFile;
  // Spawn and immediately reap a process so its pid is (almost certainly) dead.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  try {
    writeDaemonPid({
      pid: child.pid,
      host: "127.0.0.1",
      port: 0,
      url: "http://127.0.0.1:0",
      startedAt: new Date().toISOString(),
    });
    assert.equal(await stopCommand([]), 0);
    assert.equal(existsSync(pidFile), false);
  } finally {
    delete process.env["PORTICO_PID_FILE"];
    await rm(dir, { recursive: true, force: true });
  }
});
