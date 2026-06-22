import { test } from "node:test";
import assert from "node:assert/strict";
import { modelInjectionArgs } from "../src/index.ts";
import type { AgentProvider } from "../src/index.ts";

// A provider that declares both arg-builders, mirroring the claude shape.
const provider: AgentProvider = {
  id: "test",
  displayName: "Test",
  commandNames: [],
  envPathNames: [],
  protocols: ["generic-cli"],
  modelArgs: (m) => ["--model", m],
  effortArgs: (e) => ["--effort", e],
};

test("modelInjectionArgs is empty when no model / effort is set", () => {
  assert.deepEqual(modelInjectionArgs(provider, undefined), []);
  assert.deepEqual(modelInjectionArgs(provider, { cwd: "/tmp" }), []);
});

test("modelInjectionArgs injects model only", () => {
  assert.deepEqual(modelInjectionArgs(provider, { model: "opus" }), ["--model", "opus"]);
});

test("modelInjectionArgs injects effort only", () => {
  assert.deepEqual(modelInjectionArgs(provider, { effort: "high" }), ["--effort", "high"]);
});

test("modelInjectionArgs injects model then effort, in that order", () => {
  assert.deepEqual(modelInjectionArgs(provider, { model: "opus", effort: "high" }), [
    "--model",
    "opus",
    "--effort",
    "high",
  ]);
});

test("modelInjectionArgs skips knobs the provider doesn't declare", () => {
  // No arg-builders at all → model selection is "managed by runtime": nothing injected.
  const managed: AgentProvider = {
    id: "managed",
    displayName: "Managed",
    commandNames: [],
    envPathNames: [],
    protocols: ["acp"],
  };
  assert.deepEqual(modelInjectionArgs(managed, { model: "opus", effort: "high" }), []);

  // Declares modelArgs but not effortArgs (gemini shape) → effort is dropped.
  const modelOnly: AgentProvider = { ...managed, modelArgs: (m) => ["--model", m] };
  assert.deepEqual(modelInjectionArgs(modelOnly, { model: "x", effort: "high" }), ["--model", "x"]);
});
