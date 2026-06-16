# Web Reader example

A plain HTML/JS page that detects a running Portico daemon, lists the local Agents, sends
an article as a `ContextBundle`, and streams the answer — with a live **reasoning** panel, a
**tool-activity** log, and multi-turn **follow-ups** that resume the same session. No build
step, no framework.

## Run

```bash
# 1. Start the daemon. With no real Agent, point one at the fake agent — it speaks Claude's
#    stream-json, so pick "Claude Code" in the page to exercise reasoning, tool activity,
#    and resumable follow-ups. (PORTICO_CODEX_PATH works too, but generic-cli only streams
#    plain `content`.)
export PORTICO_CLAUDE_PATH="$PWD/test/fixtures/fake-agent.mjs"
npm run portico -- start

# 2. Serve the page over http://localhost (so the browser Origin passes the daemon's CORS)
node examples/web/serve.mjs
# open http://localhost:5173
```

If Portico isn't running, the page shows an **offline** pill and an explanation instead of
failing silently — that's the graceful-degradation path every Portico web app should have.

## Notes

- `app.js` inlines a tiny client (fetch + NDJSON reader) so the example is dependency-free.
  In a real app you'd `import { createPorticoClient } from "@portico/client"` instead — it
  does the same thing with typed errors and `AbortController` support.
- **Reasoning / tool panels** only populate for Agents that speak a structured protocol
  (Claude Code). A generic-cli Agent (e.g. Codex) streams plain `content`, so those panels
  stay empty — that's expected.
- **Sessions**: the page keeps the `sessionId` from the first `start` event and resends it
  on each turn, so follow-ups resume the same conversation. **New chat** (or switching the
  Agent) drops the handle and starts fresh.
- Serving over `file://` would send an opaque (`null`) Origin that the daemon's default CORS
  rejects. Serving from `http://localhost` is why `serve.mjs` exists.
