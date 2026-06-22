// OpenCode adapter. OpenCode documents `opencode run [message..]` as the
// non-interactive command, so the rendered prompt is appended as an argv value.

import { createGenericCliAdapter } from "@portico/core";
import type { AgentAdapter, AgentProvider } from "@portico/core";

export const opencodeProvider: AgentProvider = {
  id: "opencode",
  displayName: "OpenCode",
  commandNames: ["opencode"],
  envPathNames: ["PORTICO_OPENCODE_PATH"],
  protocols: ["acp", "generic-cli"],
  defaultArgs: ["run"],
  promptMode: "argument",
  // Granted only on `options.autoEdit` (delegation in a throwaway worktree).
  autoEditArgs: ["--dangerously-skip-permissions"],
  // `opencode --model <provider/model>`; the live catalog comes from the `models` subcommand,
  // one `provider/model` id per line. That id is exactly what --model wants, so it passes
  // straight through. No static catalog — the probe is the catalog.
  modelArgs: (model) => ["--model", model],
  models: {
    probe: {
      args: ["models"],
      parse: (stdout) =>
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((id) => ({ id })),
    },
  },
};

export const opencodeAdapter: AgentAdapter = createGenericCliAdapter(opencodeProvider);
