# Configuration

Portico has two configuration layers:

1. daemon configuration, loaded from `~/.portico/config.json` by default;
2. repository delegation configuration, stored at `.portico/config.json`.

Command-line options and environment variables can override daemon configuration.

## Daemon Precedence

Daemon settings are resolved in this order:

1. CLI flags;
2. environment variables;
3. daemon config file;
4. built-in defaults.

Use `portico doctor` to see what was loaded:

```bash
portico doctor
portico doctor --config ./daemon-config.json
```

## Default Daemon Config

Built-in defaults:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "allowOrigins": [],
  "lan": false,
  "agents": {},
  "limits": {
    "defaultTimeoutMs": 120000,
    "defaultAgentTimeoutMs": 900000,
    "idleTimeoutMs": 120000,
    "maxContextChars": 120000,
    "maxOutputChars": 200000
  },
  "reloadIntervalMs": 60000
}
```

`token` is unset by default.

## Daemon Config File

Default path:

```text
~/.portico/config.json
```

Override path:

```bash
portico start --config ./portico-daemon.json
portico doctor --config ./portico-daemon.json
```

Example:

```json
{
  "host": "127.0.0.1",
  "port": 8799,
  "allowOrigins": ["http://localhost:3000"],
  "agents": {
    "codex": {
      "path": "/opt/bin/codex"
    },
    "gemini": {
      "enabled": false
    }
  },
  "limits": {
    "defaultTimeoutMs": 180000,
    "maxContextChars": 200000,
    "maxOutputChars": 400000
  },
  "reloadIntervalMs": 30000
}
```

## CLI Overrides

`portico start` supports:

```bash
portico start \
  --host 127.0.0.1 \
  --port 8799 \
  --allow-origin http://localhost:3000
```

LAN exposure requires a token:

```bash
portico start \
  --host 0.0.0.0 \
  --lan \
  --token "$PORTICO_TOKEN"
```

## Environment Variables

Daemon config environment variables:

| Variable | Meaning |
| --- | --- |
| `PORTICO_CONFIG` | Config file path |
| `PORTICO_HOST` | Bind host |
| `PORTICO_PORT` | Bind port |
| `PORTICO_TOKEN` | Bearer token |
| `PORTICO_ALLOW_ORIGIN` | Comma-separated extra CORS origins |
| `PORTICO_IDLE_TIMEOUT_MS` | Default idle watchdog timeout (sets `limits.idleTimeoutMs`) |

Agent path overrides:

| Provider | Environment variable |
| --- | --- |
| Codex | `PORTICO_CODEX_PATH` |
| Claude Code | `PORTICO_CLAUDE_PATH` |
| Gemini CLI | `PORTICO_GEMINI_PATH` |
| Antigravity CLI | `PORTICO_ANTIGRAVITY_PATH` |
| OpenCode | `PORTICO_OPENCODE_PATH` |
| openclaw | `PORTICO_OPENCLAW_PATH` |
| Hermes | `PORTICO_HERMES_PATH` |

Example with fixtures:

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
portico agents
```

## Agent Overrides

Daemon config can override provider discovery:

```json
{
  "agents": {
    "codex": {
      "path": "/absolute/path/to/codex"
    },
    "claude": {
      "enabled": false
    },
    "antigravity": {
      "idleTimeoutMs": 600000
    }
  }
}
```

`path` marks the agent available and sets its source to `config`.

`enabled: false` marks the provider unavailable with the reason "Disabled in config."

`idleTimeoutMs` gives that agent a longer (or shorter) idle watchdog leash than the
daemon default — useful for an agent that works silently (writes files without printing
to stdout) and would otherwise be falsely flagged as stalled.

## Limits

Limits apply to `/chat` defaults:

| Field | Meaning |
| --- | --- |
| `defaultTimeoutMs` | Default test/verify command timeout |
| `defaultAgentTimeoutMs` | Default total agent run timeout |
| `idleTimeoutMs` | Default idle watchdog timeout — kills an agent that produces no output for this long |
| `maxContextChars` | Default context truncation limit |
| `maxOutputChars` | Default child process output cap |

Individual chat requests can override these through `ChatRequest.options`.

Delegation requests can set `timeoutMs` (total run), `testTimeoutMs` (test/verify), and
`idleTimeoutMs` (idle watchdog; the CLI's `--idle-timeout` lands here). The effective idle
timeout resolves request value > per-agent `agents.<id>.idleTimeoutMs` > `limits.idleTimeoutMs`.

`limits` are read at daemon start and are **not** hot-reloaded — changing them requires a
daemon restart (`portico stop && portico start`). The background reload only refreshes the
agent registry.

## Reload Interval

`reloadIntervalMs` controls background agent rediscovery.

```json
{
  "reloadIntervalMs": 0
}
```

Set it to `0` to disable periodic refresh. You can still refresh manually:

```bash
curl -X POST http://127.0.0.1:8787/reload
```

## Repository Config

`portico init` creates:

```text
.portico/config.json
```

Initial content:

```json
{
  "testCommands": []
}
```

Delegation uses these commands when `--test` is omitted:

```json
{
  "testCommands": [
    "npm run typecheck",
    "npm test"
  ]
}
```

Command-line `--test` flags take precedence for that run.

## Discovery Troubleshooting

Run:

```bash
portico doctor
```

Check:

- whether the daemon config file loaded;
- whether env vars were applied;
- whether login-shell PATH recovery found extra directories;
- whether the provider is available;
- which path/source was used;
- whether the configured daemon port is free.

