import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGenericCli } from "../src/generic.ts";
import type { AgentEntry, AgentProvider, ChatRequest, RuntimeEvent } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");

const provider: AgentProvider = {
  id: "fake",
  displayName: "Fake",
  commandNames: ["fake"],
  envPathNames: [],
  protocols: ["generic-cli"],
  defaultArgs: [],
  // The fake agent echoes its argv when it sees --echo-argv, so we can read the
  // assembled command line back out of the content stream.
  autoEditArgs: ["--echo-argv", "--flag-x"],
};

const entry: AgentEntry = {
  provider: "fake",
  displayName: "Fake",
  available: true,
  path: FAKE_AGENT,
  protocols: ["generic-cli"],
  source: "config",
};

async function collectContent(request: ChatRequest): Promise<string> {
  let text = "";
  for await (const event of runGenericCli(provider, request, entry) as AsyncIterable<RuntimeEvent>) {
    if (event.type === "content") text += event.delta;
  }
  return text;
}

test("autoEdit appends the provider's autoEditArgs", async () => {
  const text = await collectContent({
    provider: "fake",
    messages: [{ role: "user", content: "go" }],
    options: { autoEdit: true },
  });
  const argv = JSON.parse(text.trim()) as string[];
  assert.deepEqual(argv, ["--echo-argv", "--flag-x"]);
});

test("autoEditArgs are withheld without the opt-in", async () => {
  const text = await collectContent({
    provider: "fake",
    messages: [{ role: "user", content: "go" }],
  });
  // Without autoEdit the agent never receives --echo-argv, so it echoes a chat reply.
  assert.doesNotMatch(text, /--echo-argv|--flag-x/);
});

test("generic-cli can pass the rendered prompt as an argv argument", async () => {
  const argvProvider: AgentProvider = {
    ...provider,
    defaultArgs: ["--echo-argv"],
    autoEditArgs: [],
    promptMode: "argument",
  };

  let text = "";
  for await (const event of runGenericCli(argvProvider, {
    provider: "fake",
    messages: [{ role: "user", content: "go" }],
  }, entry) as AsyncIterable<RuntimeEvent>) {
    if (event.type === "content") text += event.delta;
  }

  const argv = JSON.parse(text.trim()) as string[];
  assert.equal(argv[0], "--echo-argv");
  assert.match(argv.at(-1) ?? "", /User: go/);
});

test("generic-cli treats known CLI error stderr as a failed run even on exit 0", async () => {
  const cliErrorProvider: AgentProvider = {
    ...provider,
    defaultArgs: ["--cli-error-ok"],
    autoEditArgs: [],
  };

  const events: RuntimeEvent[] = [];
  for await (const event of runGenericCli(cliErrorProvider, {
    provider: "fake",
    messages: [{ role: "user", content: "go" }],
  }, entry) as AsyncIterable<RuntimeEvent>) {
    events.push(event);
  }

  const error = events.at(-1);
  assert.equal(error?.type, "error");
  assert.equal(error?.type === "error" ? error.code : "", "cli_error");
  assert.notEqual(events.at(-1)?.type, "done");
});
