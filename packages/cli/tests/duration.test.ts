import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, formatDuration } from "../src/duration.ts";
import { isLoopbackHost } from "../src/commands/http.ts";

test("parseDuration understands unit suffixes", () => {
  assert.equal(parseDuration("1500ms"), 1500);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("30m"), 1_800_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("parseDuration treats a bare number as seconds", () => {
  assert.equal(parseDuration("45"), 45_000);
  assert.equal(parseDuration(" 10 "), 10_000);
});

test("parseDuration rejects garbage", () => {
  assert.equal(parseDuration(""), undefined);
  assert.equal(parseDuration("soon"), undefined);
  assert.equal(parseDuration("5y"), undefined);
});

test("formatDuration compacts a millisecond span to one unit", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(500), "0s");
  assert.equal(formatDuration(8_000), "8s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(90_000_000), "1d");
  assert.equal(formatDuration(-5), "?");
});

test("isLoopbackHost only matches loopback addresses", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true);
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "example.com"]) {
    assert.equal(isLoopbackHost(host), false);
  }
});
