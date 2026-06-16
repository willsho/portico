# Node CLI example

Calls a local Agent **in-process** via `@portico/core` — no daemon, no HTTP.

## Run

```bash
# List discovered agents
node examples/node-cli list

# Ask, with a file as context
node examples/node-cli ask --provider codex --file examples/node-cli/context.md -m "What is the key risk?"
```

No real Agent installed? Point a provider at the fake agent:

```bash
PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs" \
  node examples/node-cli ask --provider codex -m "hello"
```

## What it shows

- `installBuiltinAdapters()` to register codex/claude/openclaw/hermes.
- `discoverAgents()` for the agent list.
- `runAgent()` streaming `RuntimeEvent`s, rendering `content` to stdout and `reasoning`
  dimmed to stderr.
