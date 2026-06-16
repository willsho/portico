// Render a ChatRequest (ContextBundle + messages) into a single prompt string.
// This is the generic, provider-agnostic projection used by the generic-cli adapter
// and as a fallback for provider adapters that don't accept structured input yet.

import type { ChatRequest, ContextBundle, ContextAttachment } from "./types.ts";

export const DEFAULT_MAX_CONTEXT_CHARS = 120_000;

export interface RenderOptions {
  maxContextChars?: number;
}

/** Build the textual prompt handed to an Agent. */
export function renderPrompt(request: ChatRequest, options: RenderOptions = {}): string {
  const maxContextChars =
    request.options?.maxContextChars ?? options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;

  const sections: string[] = [];

  const systemMessages = request.messages.filter((m) => m.role === "system");
  if (systemMessages.length > 0) {
    sections.push(systemMessages.map((m) => m.content).join("\n\n"));
  }

  if (request.context) {
    sections.push(renderContextBundle(request.context, maxContextChars));
  } else if (request.contextUrl) {
    sections.push(`## Context\nA context document is available at: ${request.contextUrl}`);
  }

  const conversation = request.messages.filter((m) => m.role !== "system");
  if (conversation.length > 0) {
    const lines = conversation.map((m) => {
      const speaker = m.role === "assistant" ? "Assistant" : "User";
      return `${speaker}: ${m.content}`;
    });
    sections.push(`## Conversation\n${lines.join("\n\n")}`);
  }

  return sections.join("\n\n").trim() + "\n";
}

function renderContextBundle(context: ContextBundle, maxContextChars: number): string {
  const lines: string[] = ["## Context"];
  lines.push(`Kind: ${context.kind}`);
  if (context.title) lines.push(`Title: ${context.title}`);
  if (context.sourceUrl) lines.push(`Source: ${context.sourceUrl}`);
  if (context.summary) lines.push(`Summary: ${context.summary}`);

  if (context.metadata && Object.keys(context.metadata).length > 0) {
    lines.push(`Metadata: ${safeJson(context.metadata)}`);
  }

  if (context.content) {
    const { text, truncated } = clamp(context.content, maxContextChars);
    lines.push("", "Content:", text);
    if (truncated) {
      lines.push(`\n[content truncated to ${maxContextChars} characters]`);
    }
  }

  if (context.attachments && context.attachments.length > 0) {
    lines.push("", "Attachments:");
    for (const a of context.attachments) {
      lines.push(renderAttachment(a));
    }
  }

  return lines.join("\n");
}

function renderAttachment(a: ContextAttachment): string {
  if (a.url) return `- ${a.name} (${a.mediaType}) -> ${a.url}`;
  if (a.content) {
    const { text } = clamp(a.content, 4_000);
    return `- ${a.name} (${a.mediaType}):\n${text}`;
  }
  return `- ${a.name} (${a.mediaType})`;
}

function clamp(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
