// Agent discovery: env paths -> PATH lookup -> login-shell fallback -> --version probe.
// Mirrors the layered probing that mature local runtimes use to survive GUI-stripped PATHs.

import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { resolveViaLoginShell } from "./shell.ts";
import { captureProbe } from "./runner.ts";
import { parseSemver, versionStatus } from "./version.ts";
import { listProviders } from "./registry.ts";
import type { AgentEntry, AgentProvider } from "./types.ts";

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  versionTimeoutMs?: number;
  shellTimeoutMs?: number;
  /** Skip the (slower) login-shell fallback. */
  skipLoginShell?: boolean;
  /** Skip running `--version` probes (faster; status becomes "unknown"). */
  skipVersion?: boolean;
}

interface ResolvedPath {
  path: string;
  source: NonNullable<AgentEntry["source"]>;
}

/** Discover every registered provider on this machine. */
export async function discoverAgents(options: DiscoverOptions = {}): Promise<AgentEntry[]> {
  return Promise.all(listProviders().map((provider) => safeDiscoverAgent(provider, options)));
}

export async function safeDiscoverAgent(
  provider: AgentProvider,
  options: DiscoverOptions = {},
): Promise<AgentEntry> {
  try {
    return await discoverAgent(provider, options);
  } catch (err) {
    return {
      provider: provider.id,
      displayName: provider.displayName,
      available: false,
      protocols: provider.protocols,
      reason: `Discovery probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Discover a single provider. */
export async function discoverAgent(
  provider: AgentProvider,
  options: DiscoverOptions = {},
): Promise<AgentEntry> {
  const env = options.env ?? process.env;
  const base: AgentEntry = {
    provider: provider.id,
    displayName: provider.displayName,
    available: false,
    protocols: provider.protocols,
  };

  const resolved = await resolvePath(provider, env, options);
  if (!resolved) {
    return { ...base, reason: "Not found via env path, PATH, or login shell." };
  }

  const entry: AgentEntry = {
    ...base,
    available: true,
    path: resolved.path,
    source: resolved.source,
    modelSelection: provider.modelArgs ? "supported" : "managed-by-runtime",
  };

  if (options.skipVersion) {
    entry.versionStatus = "unknown";
    return entry;
  }

  const version = await probeVersion(
    resolved.path,
    provider.versionArgs ?? ["--version"],
    options.versionTimeoutMs ?? 5000,
    env,
  );
  if (version) {
    entry.version = version;
    entry.versionStatus = versionStatus(version, provider.minVersion);
    if (entry.versionStatus === "too_old") {
      entry.reason = `Installed ${version} is older than required ${provider.minVersion}.`;
    }
  } else {
    entry.versionStatus = "unknown";
  }

  if (provider.capabilityProbe) {
    entry.capabilities = await probeCapabilities(
      resolved.path,
      provider.capabilityProbe,
      env,
    );
  }

  return entry;
}

async function resolvePath(
  provider: AgentProvider,
  env: NodeJS.ProcessEnv,
  options: DiscoverOptions,
): Promise<ResolvedPath | null> {
  // 1. Explicit env path wins.
  for (const name of provider.envPathNames) {
    const value = env[name];
    if (value && (await isExecutable(value))) {
      return { path: value, source: "env" };
    }
  }

  // 2. PATH lookup.
  const onPath = await findOnPath(provider.commandNames, env);
  if (onPath) return { path: onPath, source: "path" };

  // 3. Login-shell fallback (recovers Homebrew/fnm/nvm/volta PATHs).
  if (!options.skipLoginShell) {
    for (const name of provider.commandNames) {
      const viaShell = await resolveViaLoginShell(name, { timeoutMs: options.shellTimeoutMs });
      if (viaShell && (await isExecutable(viaShell))) {
        return { path: viaShell, source: "login-shell" };
      }
    }
  }

  return null;
}

async function findOnPath(
  commandNames: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];

  for (const dir of dirs) {
    for (const name of commandNames) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
    await access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

async function probeVersion(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await captureProbe(binaryPath, args, {
      timeoutMs,
      env,
      maxOutputBytes: 64_000,
    });
    const parsed = parseSemver(`${stdout}\n${stderr}`);
    return parsed ? parsed.raw : null;
  } catch {
    return null;
  }
}

async function probeCapabilities(
  binaryPath: string,
  probe: NonNullable<AgentProvider["capabilityProbe"]>,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, boolean>> {
  try {
    const { stdout, stderr, code, timedOut } = await captureProbe(
      binaryPath,
      probe.args,
      {
        timeoutMs: probe.timeoutMs ?? 5000,
        env,
        maxOutputBytes: 64_000,
      },
    );
    if (code !== 0 || timedOut) {
      return {};
    }
    const output = `${stdout}\n${stderr}`;
    const caps: Record<string, boolean> = {};
    for (const [flag, key] of Object.entries(probe.flags)) {
      caps[key] = output.includes(flag);
    }
    return caps;
  } catch {
    return {};
  }
}
