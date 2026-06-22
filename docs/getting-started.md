# Getting Started

This guide gets Portico running locally, verifies agent discovery, and walks through the
first delegation run.

## Requirements

Portico currently runs directly from the repository with Node's native type stripping.

- Node.js 20 or newer
- npm
- git
- at least one supported local coding agent installed, or the included fake agent fixture

Supported built-in providers include:

| Provider id | CLI searched |
| --- | --- |
| `codex` | `codex` |
| `claude` | `claude` |
| `gemini` | `gemini` |
| `antigravity` | `agy`, `antigravity` |
| `opencode` | `opencode` |
| `cursor` | `cursor-agent` |
| `openclaw` | `openclaw` |
| `hermes` | `hermes` |

Some providers may be discovery-only until their non-interactive contract is stable.

## Install Dependencies

From the repository root:

```bash
npm install
```

Run the checks:

```bash
npm run typecheck
npm test
```

## Use the Fake Agent

If you do not have a real agent installed, point a provider at the fixture:

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
```

For delegation flows that need file edits, use the edit fixture:

```bash
export PORTICO_CODEX_PATH="$PWD/test/fixtures/edit-agent.mjs"
```

## Initialize a Repository

Run this inside a git repository:

```bash
npm run portico -- init
```

This creates:

```text
.portico/config.json
.portico/runs/
.portico/worktrees/
.claude/skills/portico/SKILL.md
.agents/skills/portico/SKILL.md
```

The generated `.portico/config.json` starts with:

```json
{
  "testCommands": []
}
```

## Start the Daemon

```bash
npm run portico -- daemon start
```

By default the daemon listens on:

```text
http://127.0.0.1:8787
```

In another terminal, check health:

```bash
curl -s http://127.0.0.1:8787/health
```

## List Agents

```bash
npm run portico -- agents
```

Or request JSON:

```bash
npm run portico -- agents --json
```

If no agents are found, run:

```bash
npm run portico -- doctor
```

`doctor` reports config source, PATH recovery, provider discovery, port status, CORS, and
LAN/token posture.

## Run a Chat Request

The daemon's `/chat` endpoint streams NDJSON runtime events:

```bash
curl -N http://127.0.0.1:8787/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "codex",
    "messages": [
      { "role": "user", "content": "Say hello from Portico" }
    ]
  }'
```

Expected event shape:

```json
{"type":"start","sessionId":"...","provider":"codex"}
{"type":"content","delta":"..."}
{"type":"done","message":"..."}
```

## Run a Delegation

With the edit fixture or a real coding agent:

```bash
npm run portico -- delegate \
  --to codex \
  --repo . \
  --task "Create delegated.txt with a short message" \
  --test "test -f delegated.txt"
```

Portico creates a run, executes the target agent, generates a diff, runs tests, and writes
artifacts under `.portico/runs/<run_id>/`.

Inspect the run:

```bash
npm run portico -- runs
npm run portico -- status <run_id>
```

Apply after review:

```bash
npm run portico -- apply <run_id>
```

Discard the run worktree when finished:

```bash
npm run portico -- discard <run_id>
```

## Next Reading

- [CLI Reference](cli.md)
- [Delegation](delegation.md)
- [Isolation and Permissions](isolation-and-permissions.md)
- [Review and Compare](review-and-compare.md)
- [Daemon API](daemon-api.md)
- [Configuration](configuration.md)
- [Skills](skills.md)
- [Security Model](security-model.md)

