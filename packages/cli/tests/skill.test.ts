import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSkill } from "../src/skill.ts";

test("claude variant keeps the allowed-tools frontmatter", () => {
  const skill = renderSkill("claude");
  assert.match(skill, /^---\nname: portico\n/);
  assert.match(skill, /^allowed-tools: Bash\(portico \*\), Read$/m);
});

test("codex variant drops only the allowed-tools line", () => {
  const claude = renderSkill("claude");
  const codex = renderSkill("codex");
  assert.doesNotMatch(codex, /allowed-tools:/);
  // Same frontmatter keys otherwise, and identical body.
  assert.match(codex, /^---\nname: portico\n/);
  assert.equal(codex, claude.replace(/^allowed-tools:.*\r?\n/m, ""));
});

test("the skill teaches the orchestration essentials", () => {
  const skill = renderSkill("claude");
  // Self-contained task + isolated worktree + no memory between runs.
  assert.match(skill, /self-contained/i);
  assert.match(skill, /isolated worktree/i);
  assert.match(skill, /no memory/i);
  // Apply is user-gated and tests aren't chosen by the delegate.
  assert.match(skill, /portico apply/);
  assert.match(skill, /without the user's explicit go-ahead/i);
  // Nested delegation is forbidden.
  assert.match(skill, /nested delegation/i);
});
