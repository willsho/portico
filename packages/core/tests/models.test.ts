import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModel,
  modelKnownIncompatible,
  modelSelectionSupported,
  discoverModels,
} from "../src/models.ts";
import type { AgentProvider, ModelDescriptor, AgentEntry } from "../src/types.ts";

// ── resolveModel ───────────────────────────────────────────────

const catalog: ModelDescriptor[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", default: true, aliases: ["sonnet"] },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", aliases: ["opus"] },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", aliases: ["haiku"] },
];

test("resolveModel returns canonical id for an exact id match", () => {
  assert.equal(resolveModel(catalog, "claude-opus-4-8"), "claude-opus-4-8");
});

test("resolveModel returns canonical id for an alias match", () => {
  assert.equal(resolveModel(catalog, "opus"), "claude-opus-4-8");
  assert.equal(resolveModel(catalog, "sonnet"), "claude-sonnet-4-6");
});

test("resolveModel passes through an unknown model unchanged", () => {
  assert.equal(resolveModel(catalog, "gpt-4o"), "gpt-4o");
  assert.equal(resolveModel([], "anything"), "anything");
});

// ── modelKnownIncompatible ─────────────────────────────────────

const claudeProvider: AgentProvider = {
  id: "claude",
  displayName: "Claude Code",
  commandNames: ["claude"],
  envPathNames: [],
  protocols: ["stream-json"],
  models: {
    static: catalog,
  },
  modelArgs: (m) => ["--model", m],
};

const noStaticProvider: AgentProvider = {
  id: "codex",
  displayName: "Codex",
  commandNames: ["codex"],
  envPathNames: [],
  protocols: ["generic-cli"],
  modelArgs: (m) => ["--model", m],
};

test("modelKnownIncompatible rejects an unknown model against a static catalog", () => {
  assert.equal(modelKnownIncompatible(claudeProvider, catalog, "gpt-4o"), true);
});

test("modelKnownIncompatible accepts a known id", () => {
  assert.equal(modelKnownIncompatible(claudeProvider, catalog, "claude-opus-4-8"), false);
});

test("modelKnownIncompatible accepts a known alias", () => {
  assert.equal(modelKnownIncompatible(claudeProvider, catalog, "opus"), false);
});

test("modelKnownIncompatible always passes for a provider with no static catalog", () => {
  assert.equal(modelKnownIncompatible(noStaticProvider, [], "anything-goes"), false);
});

// ── modelSelectionSupported ────────────────────────────────────

test("modelSelectionSupported returns true when modelArgs is declared", () => {
  assert.equal(modelSelectionSupported(claudeProvider), true);
});

test("modelSelectionSupported returns false when modelArgs is absent", () => {
  const managed: AgentProvider = {
    id: "managed",
    displayName: "Managed",
    commandNames: [],
    envPathNames: [],
    protocols: ["acp"],
  };
  assert.equal(modelSelectionSupported(managed), false);
});

// ── discoverModels ─────────────────────────────────────────────

test("discoverModels returns static catalog for claude", async () => {
  const entry: AgentEntry = {
    provider: "claude",
    displayName: "Claude Code",
    available: true,
    protocols: ["stream-json"],
  };
  const models = await discoverModels(claudeProvider, entry);
  assert.equal(models.length, catalog.length);
  assert.equal(models[0]?.id, "claude-sonnet-4-6");
});

test("discoverModels returns empty array for a provider with no catalog", async () => {
  const entry: AgentEntry = {
    provider: "codex",
    displayName: "Codex",
    available: true,
    protocols: ["generic-cli"],
  };
  const models = await discoverModels(noStaticProvider, entry);
  assert.deepEqual(models, []);
});
