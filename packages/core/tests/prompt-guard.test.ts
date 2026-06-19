// Long-prompt guard: argument-mode providers refuse a prompt that would blow past a
// conservative argv size cap, while stdin-mode providers are unaffected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGenericCli, MAX_ARG_PROMPT_BYTES } from "../src/generic.ts";
import type { AgentEntry, AgentProvider, RuntimeEvent } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

const entry: AgentEntry = {
  provider: "fake",
  displayName: "Fake",
  available: true,
  path: FAKE_AGENT,
  protocols: ["generic-cli"],
};

const provider = (overrides: Partial<AgentProvider>): AgentProvider => ({
  id: "fake",
  displayName: "Fake",
  commandNames: ["fake"],
  envPathNames: [],
  protocols: ["generic-cli"],
  ...overrides,
});

async function collect(gen: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const oversized = "a".repeat(MAX_ARG_PROMPT_BYTES + 1);

test("argument-mode prompts over the cap fail fast with prompt_too_long", async () => {
  const events = await collect(
    runGenericCli(
      provider({ defaultArgs: ["--echo-argv"], promptMode: "argument" }),
      { provider: "fake", messages: [{ role: "user", content: oversized }] },
      entry,
    ),
  );
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : "", "prompt_too_long");
});

test("stdin-mode prompts are not subject to the argv cap", async () => {
  const events = await collect(
    runGenericCli(
      provider({ defaultArgs: [], promptMode: "stdin" }),
      { provider: "fake", messages: [{ role: "user", content: oversized }] },
      entry,
    ),
  );
  assert.ok(!events.some((e) => e.type === "error" && e.code === "prompt_too_long"));
  assert.equal(events.at(-1)?.type, "done");
});
