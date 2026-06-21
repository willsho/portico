import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { classifyFetchError, resolveRepoArg, daemonUrl } from "../src/commands/http.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fetchError(code: string): Error {
  const err = new Error("fetch failed");
  (err as Error & { cause?: NodeJS.ErrnoException }).cause = Object.assign(new Error(code), { code });
  return err;
}

const url = "http://127.0.0.1:8787";

test("ECONNREFUSED is reported as a daemon that is not running, with a start hint", () => {
  const { message, hint } = classifyFetchError(fetchError("ECONNREFUSED"), url);
  assert.match(message, /daemon not running/);
  assert.match(hint, /portico start/);
});

test("ECONNREFUSED with a live daemon running elsewhere gives a custom hint", () => {
  const dir = mkdtempSync(join(tmpdir(), "portico-test-"));
  const pidFile = join(dir, "daemon.pid");
  writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    host: "127.0.0.1",
    port: 9999,
    url: "http://127.0.0.1:9999",
    startedAt: new Date().toISOString()
  }));
  const env = { PORTICO_PID_FILE: pidFile };
  
  const { message, hint } = classifyFetchError(fetchError("ECONNREFUSED"), "http://127.0.0.1:8787", env);
  assert.match(message, /a daemon is running at http:\/\/127.0.0.1:9999/);
  assert.match(hint, /running daemon is elsewhere/);
});

test("EACCES/EPERM is distinguished as a sandbox/permission block", () => {
  for (const code of ["EACCES", "EPERM"]) {
    const { message, hint } = classifyFetchError(fetchError(code), url);
    assert.match(message, /permission denied/);
    assert.match(hint, /sandbox/);
  }
});

test("unknown transport failures still suggest checking the daemon", () => {
  const { hint } = classifyFetchError(new Error("boom"), url);
  assert.match(hint, /portico start/);
});

// Regression: a relative `--repo` must be resolved against the *CLI's* cwd before it is sent
// to the daemon. Sending `.` raw lets the daemon resolve it against its own cwd and silently
// run in the wrong repository (the "ran in the wrong repo" / "resume hit the wrong store" bug).
test("resolveRepoArg makes a relative --repo absolute against the CLI cwd", () => {
  const resolved = resolveRepoArg(".");
  assert.ok(isAbsolute(resolved));
  assert.equal(resolved, process.cwd());
  assert.equal(resolveRepoArg("../sibling"), resolve("../sibling"));
});

test("resolveRepoArg leaves an absolute path unchanged and defaults to cwd when unset", () => {
  assert.equal(resolveRepoArg("/abs/repo/path"), "/abs/repo/path");
  assert.equal(resolveRepoArg(undefined), process.cwd());
});

test("daemonUrl resolution precedence: url > env > live pidfile > default", () => {
  const dir = mkdtempSync(join(tmpdir(), "portico-test-"));
  const pidFile = join(dir, "daemon.pid");
  
  writeFileSync(pidFile, JSON.stringify({
    pid: process.pid,
    host: "127.0.0.1",
    port: 9999,
    url: "http://127.0.0.1:9999",
    startedAt: new Date().toISOString()
  }));

  const env = { PORTICO_PID_FILE: pidFile };
  
  assert.equal(daemonUrl("http://explicit:1234", env), "http://explicit:1234");
  
  assert.equal(daemonUrl(undefined, { ...env, PORTICO_URL: "http://env:1234" }), "http://env:1234");
  
  assert.equal(daemonUrl(undefined, env), "http://127.0.0.1:9999");
  
  writeFileSync(pidFile, JSON.stringify({
    pid: 99999999, // stale pid
    host: "127.0.0.1",
    port: 8888,
    url: "http://127.0.0.1:8888",
    startedAt: new Date().toISOString()
  }));
  
  assert.equal(daemonUrl(undefined, env), "http://127.0.0.1:8787");
});
