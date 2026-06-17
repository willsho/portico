import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "@portico/core";

export async function initCommand(_args: string[]): Promise<number> {
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
  await writeSkill(join(root, ".claude", "skills", "portico", "SKILL.md"), true);
  await writeSkill(join(root, ".agents", "skills", "portico", "SKILL.md"), false);
  console.log(`Initialized Portico in ${root}`);
  return 0;
}

async function writeSkill(path: string, claude: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  const frontmatter = claude
    ? [
        "---",
        "name: portico",
        "description: Use Portico to delegate coding work to another local agent in an isolated worktree.",
        "allowed-tools: Bash(portico *)",
        "---",
        "",
      ].join("\n")
    : [
        "---",
        "name: portico",
        "description: Use Portico to delegate coding work to another local agent in an isolated worktree.",
        "---",
        "",
      ].join("\n");
  await writeFile(
    path,
    `${frontmatter}${UNIFIED_SKILL_BODY}`,
  );
}

const UNIFIED_SKILL_BODY = `# Portico

Use Portico for coding tasks that should be delegated to another local coding agent.

When invoked:

1. Convert the user request into a concise task.
2. Choose the target agent explicitly with \`--to\`.
3. If the user names a target agent, use that target.
4. If no target is named, delegate to a different capable local agent than the one currently handling the request.
5. Prefer \`portico delegate --to <agent> --repo . --task "<task>"\`.
6. Include test commands when known, using repeated \`--test "<command>"\`.
7. Do not manually modify the main working tree for delegated work.
8. Read the generated report path from Portico output.
9. Summarize changed files, test result, risks, and next actions.
10. Ask the user before running \`portico apply\`.

Common targets:

- From Claude Code to Codex: \`portico delegate --to codex --repo . --task "<task>"\`
- From Codex to Claude Code: \`portico delegate --to claude --repo . --task "<task>"\`
- To any configured agent: \`portico delegate --to <agent-id> --repo . --task "<task>"\`
`;
