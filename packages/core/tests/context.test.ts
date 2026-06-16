import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPrompt } from "../src/context.ts";
import type { ChatRequest } from "../src/types.ts";

test("renderPrompt includes context, system and conversation sections", () => {
  const request: ChatRequest = {
    provider: "codex",
    context: {
      schemaVersion: "1.0",
      kind: "article",
      title: "Local-first AI",
      sourceUrl: "https://example.com/a",
      summary: "A short summary.",
      content: "Full article body.",
      metadata: { author: "Jane" },
    },
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: "What is the key risk?" },
    ],
  };

  const prompt = renderPrompt(request);
  assert.match(prompt, /You are concise\./);
  assert.match(prompt, /## Context/);
  assert.match(prompt, /Title: Local-first AI/);
  assert.match(prompt, /Source: https:\/\/example\.com\/a/);
  assert.match(prompt, /Full article body\./);
  assert.match(prompt, /## Conversation/);
  assert.match(prompt, /User: What is the key risk\?/);
});

test("renderPrompt truncates content past maxContextChars", () => {
  const request: ChatRequest = {
    provider: "codex",
    context: {
      schemaVersion: "1.0",
      kind: "article",
      content: "A".repeat(5000),
    },
    messages: [{ role: "user", content: "summarize" }],
    options: { maxContextChars: 100 },
  };
  const prompt = renderPrompt(request);
  assert.match(prompt, /\[content truncated to 100 characters\]/);
  assert.ok(!prompt.includes("A".repeat(200)));
});

test("renderPrompt falls back to contextUrl when no bundle", () => {
  const request: ChatRequest = {
    provider: "codex",
    contextUrl: "https://example.com/api/context?token=abc",
    messages: [{ role: "user", content: "go" }],
  };
  const prompt = renderPrompt(request);
  assert.match(prompt, /context document is available at: https:\/\/example\.com/);
});
