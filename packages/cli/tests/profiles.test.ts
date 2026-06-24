import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintProfiles, listProfiles, loadProfile, parseFrontmatter } from "../src/profiles.ts";
import { profilesCommand } from "../src/commands/profiles.ts";

test("parseFrontmatter reads scalars, inline arrays, block lists, and the body", () => {
  const { data, body } = parseFrontmatter(`---
name: reviewer
mode: review
idleTimeoutMs: 300000
forbidden: [".env", "dist/**"]
allowed:
  - "src/**"
  - "test/**"
---
Body line one.
Body line two.`);
  assert.equal(data.name, "reviewer");
  assert.equal(data.mode, "review");
  assert.equal(data.idleTimeoutMs, 300000);
  assert.deepEqual(data.forbidden, [".env", "dist/**"]);
  assert.deepEqual(data.allowed, ["src/**", "test/**"]);
  assert.equal(body, "Body line one.\nBody line two.");
});

test("parseFrontmatter returns empty data and the whole text as body when no frontmatter", () => {
  const { data, body } = parseFrontmatter("just a plain body");
  assert.deepEqual(data, {});
  assert.equal(body, "just a plain body");
});

async function setupScopes(): Promise<{ home: string; repo: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(join(tmpdir(), "portico-home-"));
  const repo = await mkdtemp(join(tmpdir(), "portico-repo-"));
  await mkdir(join(home, ".portico", "agents"), { recursive: true });
  await mkdir(join(repo, ".portico", "agents"), { recursive: true });
  return { home, repo, env: { ...process.env, PORTICO_HOME: home } };
}

test("loadProfile resolves and lets the project scope override the user scope field-by-field", async () => {
  const { home, repo, env } = await setupScopes();
  try {
    await writeFile(
      join(home, ".portico", "agents", "reviewer.md"),
      `---\nto: codex\nmodel: gpt-x\npermissionProfile: read-only\n---\nuser body`,
    );
    await writeFile(
      join(repo, ".portico", "agents", "reviewer.md"),
      `---\nto: claude\nmode: review\n---\nproject body`,
    );
    const p = loadProfile(repo, "reviewer", env);
    assert.ok(p);
    assert.equal(p.to, "claude"); // project overrides user
    assert.equal(p.mode, "review"); // project-only
    assert.equal(p.model, "gpt-x"); // inherited from user
    assert.equal(p.permissionProfile, "read-only"); // inherited from user
    assert.equal(p.body, "project body"); // project body wins
    assert.deepEqual(p.sources, ["user", "project"]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("loadProfile returns undefined when neither scope defines the profile", async () => {
  const { home, repo, env } = await setupScopes();
  try {
    assert.equal(loadProfile(repo, "missing", env), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("listProfiles unions names across scopes and sorts them", async () => {
  const { home, repo, env } = await setupScopes();
  try {
    await writeFile(join(home, ".portico", "agents", "shared.md"), `---\nto: codex\n---`);
    await writeFile(join(home, ".portico", "agents", "userly.md"), `---\nto: codex\n---`);
    await writeFile(join(repo, ".portico", "agents", "shared.md"), `---\nto: claude\n---`);
    await writeFile(join(repo, ".portico", "agents", "projecty.md"), `---\nto: claude\n---`);
    const names = listProfiles(repo, env).map((p) => p.name);
    assert.deepEqual(names, ["projecty", "shared", "userly"]);
    const shared = listProfiles(repo, env).find((p) => p.name === "shared");
    assert.equal(shared?.to, "claude"); // project wins
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("lintProfiles flags unknown keys and invalid enum values, and passes a clean profile", async () => {
  const { home, repo, env } = await setupScopes();
  try {
    await writeFile(
      join(repo, ".portico", "agents", "messy.md"),
      `---\nto: claude\nmode: reveiw\npermissionProfile: read_only\nidleTimeoutMs: soon\ntypoKey: oops\n---\nbody`,
    );
    await writeFile(join(repo, ".portico", "agents", "clean.md"), `---\nto: claude\nmode: review\npermissionProfile: read-only\n---\nbody`);
    const lints = lintProfiles(repo, env);
    const messy = lints.find((l) => l.name === "messy");
    const clean = lints.find((l) => l.name === "clean");
    assert.ok(messy);
    assert.equal(messy.scope, "project");
    assert.ok(messy.warnings.some((w) => /unknown key "typoKey"/.test(w)));
    assert.ok(messy.warnings.some((w) => /invalid mode "reveiw"/.test(w)));
    assert.ok(messy.warnings.some((w) => /invalid permissionProfile "read_only"/.test(w)));
    assert.ok(messy.warnings.some((w) => /idleTimeoutMs "soon" is not a number/.test(w)));
    assert.deepEqual(clean?.warnings, []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("profiles list and show print resolved profiles", async () => {
  const { home, repo } = await setupScopes();
  const originalHome = process.env.PORTICO_HOME;
  const originalLog = console.log;
  process.env.PORTICO_HOME = home;
  const out: string[] = [];
  console.log = (msg?: unknown) => out.push(String(msg ?? ""));
  try {
    await writeFile(
      join(repo, ".portico", "agents", "reviewer.md"),
      `---\nto: claude\nmode: review\ndescription: Read-only review.\n---\nReview only.`,
    );

    let code = await profilesCommand(["list", "--repo", repo]);
    assert.equal(code, 0);
    let text = out.join("\n");
    assert.match(text, /reviewer/);
    assert.match(text, /to claude/);
    assert.match(text, /Read-only review\./);

    out.length = 0;
    code = await profilesCommand(["show", "reviewer", "--repo", repo]);
    assert.equal(code, 0);
    text = out.join("\n");
    assert.match(text, /profile: reviewer/);
    assert.match(text, /mode: review/);
    assert.match(text, /body \(task preamble\)/);
  } finally {
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.PORTICO_HOME;
    else process.env.PORTICO_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("profiles show returns 1 for an unknown profile", async () => {
  const { home, repo } = await setupScopes();
  const originalHome = process.env.PORTICO_HOME;
  const originalError = console.error;
  process.env.PORTICO_HOME = home;
  let err = "";
  console.error = (msg?: unknown) => {
    err += String(msg ?? "") + "\n";
  };
  try {
    const code = await profilesCommand(["show", "ghost", "--repo", repo]);
    assert.equal(code, 1);
    assert.match(err, /profile "ghost" not found/);
  } finally {
    console.error = originalError;
    if (originalHome === undefined) delete process.env.PORTICO_HOME;
    else process.env.PORTICO_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
