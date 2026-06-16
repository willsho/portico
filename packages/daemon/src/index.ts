// @portico/daemon — local HTTP/NDJSON bridge to @portico/core.

export { createDaemon, DAEMON_NAME, DAEMON_VERSION } from "./server.ts";
export type { Daemon, DaemonOptions } from "./server.ts";

export {
  resolveConfig,
  defaultConfigPath,
  DEFAULT_CONFIG,
} from "./config.ts";
export type {
  DaemonConfig,
  DaemonLimits,
  AgentOverride,
  ConfigResolution,
  ResolveConfigOptions,
} from "./config.ts";

export { corsHeaders, isOriginAllowed, isAuthorized } from "./auth.ts";
export type { DaemonContext } from "./routes.ts";
