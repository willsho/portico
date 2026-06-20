import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyTask } from "../src/index.ts";

test("slugifyTask kebab-cases the first few words", () => {
  assert.equal(slugifyTask("Add a dark mode toggle to settings"), "add-a-dark-mode-toggle-to");
  assert.equal(slugifyTask("Fix the flaky test!"), "fix-the-flaky-test");
});

test("slugifyTask strips punctuation and collapses whitespace", () => {
  assert.equal(slugifyTask("  Refactor   `CollisionSystem`  "), "refactor-collisionsystem");
  assert.equal(slugifyTask('Rename "foo" to bar'), "rename-foo-to-bar");
});

test("slugifyTask caps length and never ends in a dash", () => {
  const slug = slugifyTask("supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopic");
  assert.ok(slug.length <= 48);
  assert.ok(!slug.endsWith("-"));
});

test("slugifyTask falls back to 'task' for empty input", () => {
  assert.equal(slugifyTask("   "), "task");
  assert.equal(slugifyTask("!!!"), "task");
});
