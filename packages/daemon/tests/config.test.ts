import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, resolveIdleTimeoutMs, DEFAULT_CONFIG } from "../src/config.ts";

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

test("PORTICO_IDLE_TIMEOUT_MS env sets the idle limit; per-agent override is read from file", () => {
  const path = tempConfig({ agents: { antigravity: { idleTimeoutMs: 600_000 } } });
  try {
    const { config, sources } = resolveConfig({ configPath: path, env: { PORTICO_IDLE_TIMEOUT_MS: "300000" } });
    assert.equal(config.limits.idleTimeoutMs, 300_000, "env beats the default idle limit");
    assert.ok(sources.envApplied.includes("PORTICO_IDLE_TIMEOUT_MS"));
    assert.equal(config.agents.antigravity?.idleTimeoutMs, 600_000, "per-agent override parsed from file");
    // A non-numeric env value is ignored, keeping the default.
    const { config: bad } = resolveConfig({ configPath: "/nonexistent.json", env: { PORTICO_IDLE_TIMEOUT_MS: "nope" } });
    assert.equal(bad.limits.idleTimeoutMs, DEFAULT_CONFIG.limits.idleTimeoutMs);
  } finally {
    rmSync(path);
  }
});

test("resolveIdleTimeoutMs precedence: request > per-agent > limit, preserving 0", () => {
  const limits = { ...DEFAULT_CONFIG.limits, idleTimeoutMs: 120_000 };
  // request value wins over everything
  assert.equal(resolveIdleTimeoutMs(5_000, { idleTimeoutMs: 600_000 }, limits), 5_000);
  // no request value → per-agent override
  assert.equal(resolveIdleTimeoutMs(undefined, { idleTimeoutMs: 600_000 }, limits), 600_000);
  // no request, no per-agent → limit (which may itself come from env)
  assert.equal(resolveIdleTimeoutMs(undefined, undefined, limits), 120_000);
  assert.equal(resolveIdleTimeoutMs(undefined, {}, limits), 120_000);
  // an explicit 0 (watchdog off) from the request must survive, not fall through
  assert.equal(resolveIdleTimeoutMs(0, { idleTimeoutMs: 600_000 }, limits), 0);
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
