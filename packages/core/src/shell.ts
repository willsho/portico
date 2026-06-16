// Login-shell PATH resolution. GUI-launched apps and daemons frequently inherit
// a stripped PATH that misses Homebrew / fnm / nvm / volta entries which only
// exist after a shell rc file runs. We recover those by asking a login shell.

import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

/** Candidate login shells, most-preferred first. `$SHELL` wins when set. */
export function candidateShells(): string[] {
  const shells = new Set<string>();
  if (process.env["SHELL"]) shells.add(process.env["SHELL"]);
  shells.add("/bin/zsh");
  shells.add("/bin/bash");
  shells.add("zsh");
  shells.add("bash");
  return [...shells];
}

/**
 * Resolve a command's absolute path by running `command -v` inside a login shell.
 * Returns the first non-empty result, or null if no shell finds it.
 */
export async function resolveViaLoginShell(
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  if (process.platform === "win32") return null; // login-shell trick is POSIX-only
  const timeout = options.timeoutMs ?? 4000;
  for (const shell of candidateShells()) {
    try {
      const { stdout } = await execFile(shell, ["-lc", `command -v ${shellQuote(command)}`], {
        timeout,
        encoding: "utf8",
      });
      const resolved = stdout.split("\n").map((l) => l.trim()).find(Boolean);
      if (resolved && resolved.startsWith("/")) return resolved;
    } catch {
      // try the next shell
    }
  }
  return null;
}

/** Best-effort full PATH as seen by an interactive login shell. */
export async function loginShellPath(options: { timeoutMs?: number } = {}): Promise<string | null> {
  if (process.platform === "win32") return null;
  const timeout = options.timeoutMs ?? 4000;
  for (const shell of candidateShells()) {
    try {
      const out = await runCapture(shell, ["-lc", "printf %s \"$PATH\""], timeout);
      if (out && out.includes("/")) return out.trim();
    } catch {
      // next shell
    }
  }
  return null;
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("login shell timed out"));
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Quote a single shell argument safely for POSIX shells. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
