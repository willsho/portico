import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFetchError } from "../src/commands/http.ts";

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
