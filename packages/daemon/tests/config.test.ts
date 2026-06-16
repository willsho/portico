import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.ts";

function tempConfig(contents: unknown): string {
  const path = join(tmpdir(), `portico-config-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

test("resolveConfig returns defaults when no file or env is present", () => {
  const { config, sources } = resolveConfig({ configPath: "/nonexistent/portico.json", env: {} });
  assert.equal(config.host, DEFAULT_CONFIG.host);
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(sources.configLoaded, false);
});

test("config file overrides defaults and merges limits", () => {
  const path = tempConfig({ port: 9000, limits: { maxContextChars: 5000 } });
  try {
    const { config, sources } = resolveConfig({ configPath: path, env: {} });
    assert.equal(sources.configLoaded, true);
    assert.equal(config.port, 9000);
    assert.equal(config.limits.maxContextChars, 5000);
    // unspecified limit keeps its default
    assert.equal(config.limits.defaultTimeoutMs, DEFAULT_CONFIG.limits.defaultTimeoutMs);
  } finally {
    rmSync(path);
  }
});

test("precedence is CLI overrides > env > file > defaults", () => {
  const path = tempConfig({ port: 9000 });
  try {
    const env = { PORTICO_PORT: "9100", PORTICO_TOKEN: "from-env" };

    const envWins = resolveConfig({ configPath: path, env });
    assert.equal(envWins.config.port, 9100, "env beats file");
    assert.equal(envWins.config.token, "from-env");
    assert.deepEqual(envWins.sources.envApplied.sort(), ["PORTICO_PORT", "PORTICO_TOKEN"]);

    const cliWins = resolveConfig({ configPath: path, env, overrides: { port: 9200 } });
    assert.equal(cliWins.config.port, 9200, "CLI override beats env");
    assert.equal(cliWins.config.token, "from-env", "untouched env value remains");
  } finally {
    rmSync(path);
  }
});

test("malformed config surfaces an error but still yields defaults", () => {
  const path = join(tmpdir(), `portico-bad-${process.pid}.json`);
  writeFileSync(path, "{ not json");
  try {
    const { config, sources } = resolveConfig({ configPath: path, env: {} });
    assert.ok(sources.configError);
    assert.equal(config.port, DEFAULT_CONFIG.port);
  } finally {
    rmSync(path);
  }
});
