// Gemini CLI adapter. Gemini's documented non-interactive mode is
// `gemini --prompt <prompt>`, so the generic-cli engine appends the rendered prompt
// as an argv value instead of piping it to stdin.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const geminiProvider: AgentProvider = {
  id: "gemini",
  displayName: "Gemini CLI",
  commandNames: ["gemini"],
  envPathNames: ["PORTICO_GEMINI_PATH"],
  protocols: ["generic-cli"],
  defaultArgs: ["--prompt"],
  promptMode: "argument",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  // Gemini documents --yolo as automatic approval for all tool calls.
  autoEditArgs: ["--yolo"],
  // Gemini documents `-m, --model <model>`. No static catalog (not verified on this host);
  // any value passes through. Effort/thinking has no documented flag yet, so it's omitted.
  modelArgs: (model) => ["--model", model],
};

export const geminiAdapter: AgentAdapter = createGenericCliAdapter(geminiProvider);
