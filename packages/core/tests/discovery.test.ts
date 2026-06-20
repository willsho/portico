import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { discoverAgent, discoverAgents, safeDiscoverAgent } from "../src/discovery.ts";
import { getProvider } from "../src/registry.ts";
import { runAgent } from "../src/run.ts";
import type { AgentProvider, RuntimeEvent } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

const fakeProvider = (overrides: Partial<AgentProvider>): AgentProvider => ({
  id: "fake",
  displayName: "Fake",
  commandNames: ["fake"],
  envPathNames: ["FAKE_PATH"],
  protocols: ["generic-cli"],
  ...overrides,
});

test("discoverAgent resolves an explicit env path and probes its version", async () => {
  const codex = getProvider("codex")!;
  const entry = await discoverAgent(codex, {
    // Keep a real PATH so the fake agent's `#!/usr/bin/env node` shebang can run.
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    skipLoginShell: true,
  });
  assert.equal(entry.available, true);
  assert.equal(entry.source, "env");
  assert.equal(entry.path, FAKE_AGENT);
  assert.equal(entry.version, "1.4.2");
  assert.equal(entry.versionStatus, "ok");
});

test("discoverAgent reports unavailable when nothing resolves", async () => {
  const hermes = getProvider("hermes")!;
  const entry = await discoverAgent(hermes, {
    env: { PATH: "" },
    skipLoginShell: true,
  });
  assert.equal(entry.available, false);
  assert.match(entry.reason ?? "", /Not found/);
});

test("discoverAgents returns one entry per registered provider", async () => {
  const entries = await discoverAgents({ env: { PATH: "" }, skipLoginShell: true, skipVersion: true });
  const ids = entries.map((e) => e.provider).sort();
  assert.deepEqual(ids, ["antigravity", "claude", "codex", "gemini", "hermes", "openclaw", "opencode"]);
});

test("runAgent streams start -> content -> done through the generic-cli engine", async () => {
  const events: RuntimeEvent[] = [];
  for await (const event of runAgent(
    {
      provider: "codex",
      messages: [{ role: "user", content: "What is the strongest counterargument?" }],
    },
    { env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT } },
  )) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "start");
  assert.ok(events.some((e) => e.type === "content"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.match(done?.type === "done" ? done.message : "", /Echo from fake-agent/);
});

test("safeDiscoverAgent isolates a provider whose probe throws", async () => {
  // A malformed provider: resolvePath iterates `envPathNames` and throws on undefined.
  // The failure must be contained as an unavailable entry, not propagated.
  const broken = {
    id: "broken",
    displayName: "Broken",
    commandNames: ["broken"],
    protocols: ["generic-cli"],
    envPathNames: undefined,
  } as unknown as AgentProvider;

  const entry = await safeDiscoverAgent(broken, { skipLoginShell: true });
  assert.equal(entry.provider, "broken");
  assert.equal(entry.available, false);
  assert.match(entry.reason ?? "", /Discovery probe failed/);
});

test("safeDiscoverAgent passes a normal discovery through unchanged", async () => {
  const codex = getProvider("codex")!;
  const entry = await safeDiscoverAgent(codex, {
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    skipLoginShell: true,
  });
  assert.equal(entry.available, true);
  assert.equal(entry.version, "1.4.2");
});

test("discoverAgent honors a custom versionArgs", async () => {
  const env = { ...process.env, FAKE_PATH: FAKE_AGENT };

  // Default (["--version"]) — the fixture prints a semver.
  const def = await discoverAgent(fakeProvider({}), { env, skipLoginShell: true });
  assert.equal(def.version, "1.4.2");

  // A custom probe the fixture doesn't treat as --version → no semver is parsed,
  // proving the provided args (not a hardcoded --version) were used.
  const custom = await discoverAgent(fakeProvider({ versionArgs: ["--echo-argv"] }), {
    env,
    skipLoginShell: true,
  });
  assert.equal(custom.available, true);
  assert.equal(custom.version, undefined);
  assert.equal(custom.versionStatus, "unknown");
});

test("capability probe records which flags a build advertises", async () => {
  const env = { ...process.env, FAKE_PATH: FAKE_AGENT };

  // Present: the fixture's --help output lists --include-partial-messages.
  const present = await discoverAgent(
    fakeProvider({
      capabilityProbe: { args: ["--help"], flags: { "--include-partial-messages": "partialMessages" } },
    }),
    { env, skipLoginShell: true },
  );
  assert.deepEqual(present.capabilities, { partialMessages: true });

  // Absent: a flag the help text never mentions.
  const absent = await discoverAgent(
    fakeProvider({ capabilityProbe: { args: ["--help"], flags: { "--add-dir": "addDir" } } }),
    { env, skipLoginShell: true },
  );
  assert.deepEqual(absent.capabilities, { addDir: false });

  // Probe failure (non-zero exit) → no capabilities, but the agent stays available.
  const failed = await discoverAgent(
    fakeProvider({ capabilityProbe: { args: ["--fail"], flags: { "--add-dir": "addDir" } } }),
    { env, skipLoginShell: true },
  );
  assert.equal(failed.available, true);
  assert.deepEqual(failed.capabilities, {});
});

test("read-only probes run in a temp dir, not the repo", async () => {
  const marker = `portico-probe-${process.pid}-${Date.now()}.tmp`;
  const env = { ...process.env, FAKE_PATH: FAKE_AGENT };

  await discoverAgent(fakeProvider({ versionArgs: ["--touch-cwd", marker] }), {
    env,
    skipLoginShell: true,
  });

  // The probe must not have written into the test's working directory (the repo)...
  assert.equal(existsSync(join(process.cwd(), marker)), false);
  // ...it ran in the OS temp dir instead.
  const inTmp = join(tmpdir(), marker);
  assert.equal(existsSync(inTmp), true);
  rmSync(inTmp, { force: true });
});

test("runAgent yields agent_not_found for an unknown provider", async () => {
  const events: RuntimeEvent[] = [];
  for await (const event of runAgent({ provider: "nope", messages: [] })) {
    events.push(event);
  }
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.type === "error" ? events[0].code : "", "agent_not_found");
});
