// Cursor CLI adapter. Cursor's documented non-interactive mode is print mode
// (`cursor-agent -p [prompt...]`), so the rendered prompt is appended as an argv
// value. Print mode refuses an untrusted workspace unless `--trust` is passed, so
// `--trust` is always included in `defaultArgs`. `--force` (alias `--yolo`)
// auto-approves every tool call and is the auto-edit grant, appended only on
// `options.autoEdit` (delegation in a throwaway worktree).

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const cursorProvider: AgentProvider = {
  id: "cursor",
  displayName: "Cursor CLI",
  commandNames: ["cursor-agent"],
  envPathNames: ["PORTICO_CURSOR_PATH"],
  protocols: ["generic-cli"],
  defaultArgs: ["-p", "--output-format", "text", "--trust"],
  promptMode: "argument",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  autoEditArgs: ["--force"],
};

export const cursorAdapter: AgentAdapter = createGenericCliAdapter(cursorProvider);
