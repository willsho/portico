// Single source of truth for the Portico skill. The canonical file lives at
// packages/skills/portico/SKILL.md; `portico init` derives the per-agent variants
// from it so there is only ever one body to maintain.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// packages/cli/src/skill.ts -> packages/skills/portico/SKILL.md
const CANONICAL_SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "portico",
  "SKILL.md",
);

export type SkillTarget = "claude" | "codex";

/**
 * The canonical skill, adapted for one target. Claude Code keeps the
 * `allowed-tools` frontmatter; Codex-style loaders that don't understand it
 * get the same body with that line removed.
 */
export function renderSkill(target: SkillTarget): string {
  const canonical = readFileSync(CANONICAL_SKILL_PATH, "utf8");
  return target === "claude" ? canonical : stripAllowedTools(canonical);
}

// `allowed-tools:` only ever appears in the frontmatter, so a line-level drop is safe.
function stripAllowedTools(skill: string): string {
  return skill.replace(/^allowed-tools:.*\r?\n/m, "");
}
