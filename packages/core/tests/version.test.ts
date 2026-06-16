import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSemver,
  compareVersions,
  satisfiesMinVersion,
  versionStatus,
} from "../src/version.ts";

test("parseSemver extracts a version from noisy CLI output", () => {
  assert.equal(parseSemver("0.100.0")?.raw, "0.100.0");
  assert.equal(parseSemver("codex 0.100.0")?.raw, "0.100.0");
  assert.equal(parseSemver("Claude Code 2.0.1")?.raw, "2.0.1");
  assert.equal(parseSemver("v1.2.3-beta.1 (build 9)")?.raw, "1.2.3-beta.1");
  assert.equal(parseSemver("no version here"), null);
});

test("compareVersions orders releases and prereleases", () => {
  const a = parseSemver("1.2.3")!;
  const b = parseSemver("1.2.4")!;
  const rc = parseSemver("1.2.3-rc.1")!;
  assert.equal(compareVersions(a, b), -1);
  assert.equal(compareVersions(b, a), 1);
  assert.equal(compareVersions(a, a), 0);
  // a full release outranks a prerelease of the same x.y.z
  assert.equal(compareVersions(a, rc), 1);
  assert.equal(compareVersions(rc, a), -1);
});

test("satisfiesMinVersion is permissive when either side is unparseable", () => {
  assert.equal(satisfiesMinVersion("2.0.0", "1.0.0"), true);
  assert.equal(satisfiesMinVersion("0.9.0", "1.0.0"), false);
  assert.equal(satisfiesMinVersion(null, "1.0.0"), true);
  assert.equal(satisfiesMinVersion("garbage", "1.0.0"), true);
  assert.equal(satisfiesMinVersion("0.1.0", undefined), true);
});

test("versionStatus maps to ok / too_old / unknown", () => {
  assert.equal(versionStatus("1.0.0", "1.0.0"), "ok");
  assert.equal(versionStatus("0.9.0", "1.0.0"), "too_old");
  assert.equal(versionStatus(null, "1.0.0"), "unknown");
  assert.equal(versionStatus("1.2.3", undefined), "ok");
});
