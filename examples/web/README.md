# Web Reader example

A plain HTML/JS page that detects a running Portico daemon, lists the local Agents, sends
an article as a `ContextBundle`, and streams the answer. No build step, no framework.

## Run

```bash
# 1. Start the daemon (point a provider at the fake agent if you have no real one)
export PORTICO_CODEX_PATH="$PWD/test/fixtures/fake-agent.mjs"
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
- Serving over `file://` would send an opaque (`null`) Origin that the daemon's default CORS
  rejects. Serving from `http://localhost` is why `serve.mjs` exists.
