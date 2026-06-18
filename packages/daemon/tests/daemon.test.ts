import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDaemon } from "../src/server.ts";
import type { Daemon } from "../src/server.ts";
import { capture } from "@portico/core";
import type { RuntimeEvent } from "@portico/core";
import type { DelegationEvent, RunDetails } from "@portico/orchestrator";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "../../../test/fixtures/fake-agent.mjs");
const EDIT_AGENT = join(here, "../../../test/fixtures/edit-agent.mjs");

let daemon: Daemon;
let base: string;

before(async () => {
  daemon = createDaemon({
    config: { port: 0, reloadIntervalMs: 0 },
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await daemon.start();
  base = info.url;
});

after(async () => {
  await daemon.stop();
});

function parseNdjson(text: string): RuntimeEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RuntimeEvent);
}

function parseDelegationNdjson(text: string): DelegationEvent[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DelegationEvent);
}

test("GET /health returns ok", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, name: "portico", version: "0.1.0" });
});

test("GET /agents lists the discovered fake codex", async () => {
  const res = await fetch(`${base}/agents`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { agents: Array<{ provider: string; available: boolean; version?: string }> };
  const codex = body.agents.find((a) => a.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.available, true);
  assert.equal(codex.version, "1.4.2");
});

test("POST /chat streams start -> content -> done as NDJSON", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "codex",
      context: { schemaVersion: "1.0", kind: "article", title: "T", content: "Body" },
      messages: [{ role: "user", content: "What is the key risk?" }],
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /x-ndjson/);
  const events = parseNdjson(await res.text());
  assert.equal(events[0]?.type, "start");
  assert.ok(events.some((e) => e.type === "content"));
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.match(done?.type === "done" ? done.message : "", /Echo from fake-agent/);
});

test("session: /chat opens a session, follow-up resumes, /sessions lists and deletes", async () => {
  const d = createDaemon({
    config: { port: 0, reloadIntervalMs: 0 },
    env: { ...process.env, PORTICO_CLAUDE_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await d.start();
  try {
    // First turn — creates a session; the handle rides the header and the start event.
    const res1 = await fetch(`${info.url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", messages: [{ role: "user", content: "echo hi" }] }),
    });
    assert.equal(res1.status, 200);
    const sid = res1.headers.get("x-portico-session");
    assert.ok(sid, "expected an X-Portico-Session header");
    const ev1 = parseNdjson(await res1.text());
    assert.equal(ev1[0]?.type, "start");
    assert.equal(ev1[0]?.type === "start" ? ev1[0].sessionId : "", sid);

    // The session is now active with the agent's native id pinned and one turn recorded.
    const listed = (await (await fetch(`${info.url}/sessions`)).json()) as {
      sessions: Array<{ id: string; status: string; agentSessionId?: string; turns: number }>;
    };
    const rec = listed.sessions.find((s) => s.id === sid);
    assert.ok(rec);
    assert.equal(rec.status, "active");
    assert.equal(rec.agentSessionId, "fake-1");
    assert.equal(rec.turns, 1);

    // Follow-up with the same id resumes — the fake agent echoes the resume id into its answer.
    const res2 = await fetch(`${info.url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude", sessionId: sid, messages: [{ role: "user", content: "again" }] }),
    });
    assert.equal(res2.headers.get("x-portico-session"), sid);
    const text2 = parseNdjson(await res2.text())
      .filter((e) => e.type === "content")
      .map((e) => (e.type === "content" ? e.delta : ""))
      .join("");
    assert.match(text2, /\(resumed fake-1\)/);

    // Delete forgets the session.
    const del = await fetch(`${info.url}/sessions/${sid}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const after = (await (await fetch(`${info.url}/sessions`)).json()) as { sessions: unknown[] };
    assert.equal(after.sessions.length, 0);
  } finally {
    await d.stop();
  }
});

test("POST /chat rejects a malformed body", async () => {
  const res = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonsense: true }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "bad_request");
});

test("POST /delegate streams a run and GET /runs/:id returns artifacts", async () => {
  const repo = await createRepo();
  const d = createDaemon({
    config: { port: 0, reloadIntervalMs: 0 },
    env: { ...process.env, PORTICO_CODEX_PATH: EDIT_AGENT },
    logger: () => {},
  });
  const info = await d.start();
  try {
    const res = await fetch(`${info.url}/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "codex",
        repo,
        task: "create delegated file",
        testCommands: ["test -f delegated.txt"],
      }),
    });
    assert.equal(res.status, 200);
    const events = parseDelegationNdjson(await res.text());
    const done = events.at(-1);
    assert.equal(done?.type, "run_done");
    const runId = done?.type === "run_done" ? done.runId : "";
    const details = (await (await fetch(`${info.url}/runs/${runId}?repo=${encodeURIComponent(repo)}`)).json()) as RunDetails;
    assert.equal(details.run.status, "ready");
    assert.ok(details.result?.changedFiles.includes("delegated.txt"));
  } finally {
    await d.stop();
    await rm(repo, { recursive: true, force: true });
  }
});

test("CORS allows localhost and rejects unlisted origins", async () => {
  const ok = await fetch(`${base}/agents`, { headers: { Origin: "http://localhost:3000" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");

  const blocked = await fetch(`${base}/agents`, { headers: { Origin: "http://evil.example" } });
  assert.equal(blocked.status, 403);
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "portico-daemon-delegate-"));
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "README.md"), "# test\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "init");
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await capture("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

test("token auth rejects requests without a bearer token", async () => {
  const secured = createDaemon({
    config: { port: 0, reloadIntervalMs: 0, token: "s3cret" },
    env: { ...process.env, PORTICO_CODEX_PATH: FAKE_AGENT },
    logger: () => {},
  });
  const info = await secured.start();
  try {
    const noAuth = await fetch(`${info.url}/agents`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${info.url}/agents`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    assert.equal(withAuth.status, 200);
  } finally {
    await secured.stop();
  }
});

test("daemon refuses LAN exposure without a token", async () => {
  const lan = createDaemon({
    config: { host: "0.0.0.0", port: 0, lan: true },
    logger: () => {},
  });
  await assert.rejects(() => lan.start(), /token/i);
});
