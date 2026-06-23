import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { initCommand } from "../src/commands/init.ts";
import { renderSkill } from "../src/skill.ts";

const execFileAsync = promisify(execFile);

test("init refreshes Portico skill files without overwriting config", async () => {
  const repo = await mkdtemp(join(tmpdir(), "portico-init-"));
  const previousCwd = process.cwd();
  const originalLog = console.log;

  try {
    console.log = () => {};
    await execFileAsync("git", ["init"], { cwd: repo });
    process.chdir(repo);

    const configPath = join(repo, ".portico", "config.json");
    const claudeSkillPath = join(repo, ".claude", "skills", "portico", "SKILL.md");
    const codexSkillPath = join(repo, ".agents", "skills", "portico", "SKILL.md");

    const reviewerPath = join(repo, ".portico", "agents", "reviewer.md");

    await initCommand([]);
    await writeFile(configPath, JSON.stringify({ testCommands: ["npm test"] }, null, 2));
    await writeFile(claudeSkillPath, "old claude skill");
    await writeFile(codexSkillPath, "old codex skill");
    await writeFile(reviewerPath, "edited reviewer profile");

    const code = await initCommand([]);
    assert.equal(code, 0);
    assert.equal(await readFile(configPath, "utf8"), JSON.stringify({ testCommands: ["npm test"] }, null, 2));
    assert.equal(await readFile(claudeSkillPath, "utf8"), renderSkill("claude"));
    assert.equal(await readFile(codexSkillPath, "utf8"), renderSkill("codex"));
    // Example profiles are scaffolded, then never overwritten so user edits survive re-init.
    assert.equal(await readFile(reviewerPath, "utf8"), "edited reviewer profile");
    assert.match(await readFile(join(repo, ".portico", "agents", "implementer.md"), "utf8"), /name: implementer/);
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    await rm(repo, { recursive: true, force: true });
  }
});
