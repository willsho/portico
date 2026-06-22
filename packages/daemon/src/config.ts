// Daemon configuration with the precedence chain: CLI args > env vars > config file > defaults.
// The config file lives at ~/.portico/config.json by default.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentOverride {
  path?: string;
  enabled?: boolean;
  /** Per-agent idle watchdog timeout (ms). Lets a known-quiet agent get a longer leash. */
  idleTimeoutMs?: number;
}

export interface DaemonLimits {
  defaultTimeoutMs: number;
  defaultAgentTimeoutMs: number;
  idleTimeoutMs: number;
  maxContextChars: number;
  maxOutputChars: number;
}

export interface DaemonConfig {
  host: string;
  port: number;
  /** Extra production origins allowed by CORS, beyond localhost/127.0.0.1. */
  allowOrigins: string[];
  /** Bearer token. Required whenever `lan` is true. */
  token?: string;
  /** Whether the daemon is intentionally exposed beyond loopback. */
  lan: boolean;
  agents: Record<string, AgentOverride>;
  limits: DaemonLimits;
  /** Background registry refresh interval. 0 disables periodic refresh. */
  reloadIntervalMs: number;
}

export const DEFAULT_CONFIG: DaemonConfig = {
  host: "127.0.0.1",
  port: 8787,
  allowOrigins: [],
  lan: false,
  agents: {},
  limits: {
    defaultTimeoutMs: 120_000,
    defaultAgentTimeoutMs: 900_000,
    idleTimeoutMs: 120_000,
    maxContextChars: 120_000,
    maxOutputChars: 200_000,
  },
  reloadIntervalMs: 60_000,
};

export interface ConfigResolution {
  config: DaemonConfig;
  /** Where settings came from — surfaced by `portico doctor`. */
  sources: {
    configPath: string;
    configLoaded: boolean;
    configError?: string;
    envApplied: string[];
  };
}

export interface ResolveConfigOptions {
  /** CLI overrides, highest precedence. */
  overrides?: Partial<DaemonConfig>;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["PORTICO_CONFIG"] ?? join(homedir(), ".portico", "config.json");
}

/** Resolve the effective daemon config, recording where each layer came from. */
export function resolveConfig(options: ResolveConfigOptions = {}): ConfigResolution {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? defaultConfigPath(env);
  const config: DaemonConfig = structuredClone(DEFAULT_CONFIG);

  let configLoaded = false;
  let configError: string | undefined;
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    mergeConfig(config, parsed);
    configLoaded = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") configError = e.message;
  }

  const envApplied = applyEnv(config, env);
  if (options.overrides) mergeConfig(config, options.overrides);

  return {
    config,
    sources: { configPath, configLoaded, configError, envApplied },
  };
}

function mergeConfig(target: DaemonConfig, patch: Partial<DaemonConfig>): void {
  if (patch.host !== undefined) target.host = patch.host;
  if (patch.port !== undefined) target.port = patch.port;
  if (patch.allowOrigins !== undefined) target.allowOrigins = patch.allowOrigins;
  if (patch.token !== undefined) target.token = patch.token;
  if (patch.lan !== undefined) target.lan = patch.lan;
  if (patch.agents !== undefined) target.agents = { ...target.agents, ...patch.agents };
  if (patch.limits !== undefined) target.limits = { ...target.limits, ...patch.limits };
  if (patch.reloadIntervalMs !== undefined) target.reloadIntervalMs = patch.reloadIntervalMs;
}

function applyEnv(config: DaemonConfig, env: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];
  if (env["PORTICO_HOST"]) {
    config.host = env["PORTICO_HOST"];
    applied.push("PORTICO_HOST");
  }
  if (env["PORTICO_PORT"]) {
    const port = Number(env["PORTICO_PORT"]);
    if (Number.isFinite(port)) {
      config.port = port;
      applied.push("PORTICO_PORT");
    }
  }
  if (env["PORTICO_TOKEN"]) {
    config.token = env["PORTICO_TOKEN"];
    applied.push("PORTICO_TOKEN");
  }
  if (env["PORTICO_ALLOW_ORIGIN"]) {
    config.allowOrigins = env["PORTICO_ALLOW_ORIGIN"].split(",").map((s) => s.trim()).filter(Boolean);
    applied.push("PORTICO_ALLOW_ORIGIN");
  }
  if (env["PORTICO_IDLE_TIMEOUT_MS"]) {
    const idleMs = Number(env["PORTICO_IDLE_TIMEOUT_MS"]);
    if (Number.isFinite(idleMs)) {
      config.limits.idleTimeoutMs = idleMs;
      applied.push("PORTICO_IDLE_TIMEOUT_MS");
    }
  }
  return applied;
}

/**
 * Effective idle watchdog timeout for a delegation, highest precedence first:
 * request body (where the CLI's `--idle-timeout` lands) > per-agent override >
 * daemon limit (itself settable via PORTICO_IDLE_TIMEOUT_MS or the config file).
 * Uses `??` so an explicit `0` (watchdog off) from the request is preserved.
 */
export function resolveIdleTimeoutMs(
  requestIdleMs: number | undefined,
  agentOverride: AgentOverride | undefined,
  limits: DaemonLimits,
): number {
  return requestIdleMs ?? agentOverride?.idleTimeoutMs ?? limits.idleTimeoutMs;
}
