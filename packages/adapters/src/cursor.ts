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
  // `cursor-agent --model <id>`; the live catalog comes from `--list-models`, whose output is
  // a header line, a blank line, then `<id> - <label>` rows. No static catalog — the probe is it.
  modelArgs: (model) => ["--model", model],
  models: {
    probe: {
      args: ["--list-models"],
      parse: (stdout) =>
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l !== "Available models" && l.includes(" - "))
          .map((l) => {
            const sep = l.indexOf(" - ");
            return { id: l.slice(0, sep).trim(), label: l.slice(sep + 3).trim() };
          }),
    },
  },
};

export const cursorAdapter: AgentAdapter = createGenericCliAdapter(cursorProvider);
