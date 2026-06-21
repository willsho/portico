import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { classifyFetchError, resolveRepoArg } from "../src/commands/http.ts";

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
