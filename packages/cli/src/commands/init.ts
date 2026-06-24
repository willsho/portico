import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { capture } from "@portico/core";
import { renderSkill } from "../skill.ts";

export async function initCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`Usage: portico init [options]

Options:
  -h, --help               Show this help message`);
    return 0;
  }

  const repo = await capture("git", ["rev-parse", "--show-toplevel"]);
  if (repo.code !== 0) {
    console.error("portico init must be run inside a git repo.");
    return 1;
  }
  const root = repo.stdout.trim();
  await mkdir(join(root, ".portico", "runs"), { recursive: true });
  await mkdir(join(root, ".portico", "worktrees"), { recursive: true });
  const configPath = join(root, ".portico", "config.json");
  if (!existsSync(configPath)) {
    await writeFile(configPath, JSON.stringify({ testCommands: [] }, null, 2));
  }
  await writeExampleProfiles(join(root, ".portico", "agents"));
  await writeSkill(join(root, ".claude", "skills", "portico", "SKILL.md"), renderSkill("claude"));
  await writeSkill(join(root, ".agents", "skills", "portico", "SKILL.md"), renderSkill("codex"));
  console.log(`Initialized Portico in ${root}`);
  return 0;
}

/** Example delegate profiles. Written once and never overwritten, so user edits survive re-init. */
const EXAMPLE_PROFILES: Record<string, string> = {
  "reviewer.md": `---
name: reviewer
description: Read-only review — find issues, change nothing.
mode: review
permissionProfile: read-only
---
You are performing a read-only review. Do not modify any files. Report findings grouped by
severity (critical / warning / suggestion), each with a file:line reference and a concrete fix.
`,
  "implementer.md": `---
name: implementer
description: Implement a bounded change in an isolated worktree, with tests.
permissionProfile: auto-edit
---
Implement the task in the isolated worktree. Make the minimal change that satisfies the
acceptance criteria, then run the configured tests and ensure they pass before finishing.
`,
};

async function writeExampleProfiles(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(EXAMPLE_PROFILES)) {
    const path = join(dir, file);
    if (!existsSync(path)) await writeFile(path, content);
  }
}

async function writeSkill(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
