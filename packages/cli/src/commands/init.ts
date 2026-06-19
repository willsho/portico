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
  await writeSkill(join(root, ".claude", "skills", "portico", "SKILL.md"), renderSkill("claude"));
  await writeSkill(join(root, ".agents", "skills", "portico", "SKILL.md"), renderSkill("codex"));
  console.log(`Initialized Portico in ${root}`);
  return 0;
}

async function writeSkill(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  await writeFile(path, content);
}
