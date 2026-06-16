// The Portico daemon: a thin HTTP wrapper around @portico/core. It caches discovery
// results, refreshes them periodically, and streams chat over NDJSON.

import { createServer as createHttpServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { discoverAgents, PorticoError, createInMemorySessionStore } from "@portico/core";
import type { AgentEntry } from "@portico/core";
import { installBuiltinAdapters } from "@portico/adapters";
import type { DaemonConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { corsHeaders, isAuthorized } from "./auth.ts";
import {
  handleAgents,
  handleChat,
  handleHealth,
  handleReload,
  handleListSessions,
  handleDeleteSession,
  writeJson,
} from "./routes.ts";
import type { DaemonContext } from "./routes.ts";

export const DAEMON_NAME = "portico";
export const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  config?: Partial<DaemonConfig>;
  /** Override the environment used for discovery (mainly for tests). */
  env?: NodeJS.ProcessEnv;
  /** Diagnostic logger. Defaults to console.log; pass () => {} to silence. */
  logger?: (line: string) => void;
}

export interface Daemon {
  readonly config: DaemonConfig;
  readonly url: string;
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
  reload(): Promise<AgentEntry[]>;
  getAgents(): AgentEntry[];
  /** Exposed for in-process integration tests. */
  readonly server: Server;
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const config: DaemonConfig = { ...DEFAULT_CONFIG, ...options.config };
  const env = options.env ?? process.env;
  const log = options.logger ?? ((line: string) => console.log(line));

  installBuiltinAdapters();

  let agentsCache: AgentEntry[] = [];
  let refreshTimer: NodeJS.Timeout | null = null;
  let actualPort = config.port;

  const reload = async (): Promise<AgentEntry[]> => {
    const discovered = await discoverAgents({ env });
    agentsCache = applyAgentOverrides(discovered, config);
    return agentsCache;
  };

  const sessions = createInMemorySessionStore();
  const inFlight = new Set<string>();

  const ctx: DaemonContext = {
    name: DAEMON_NAME,
    version: DAEMON_VERSION,
    config,
    getAgents: () => agentsCache,
    reload,
    findEntry: (provider) => agentsCache.find((a) => a.provider === provider),
    sessions,
    inFlight,
  };

  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, ctx, config, log);
  });

  const url = () => `http://${displayHost(config.host)}:${actualPort}`;

  return {
    config,
    get url() {
      return url();
    },
    server,
    getAgents: () => agentsCache,
    reload,
    async start() {
      assertLanSafety(config);
      await reload();

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.removeListener("error", reject);
          const address = server.address() as AddressInfo;
          actualPort = address.port;
          resolve();
        });
      });

      if (config.reloadIntervalMs > 0) {
        refreshTimer = setInterval(() => void reload(), config.reloadIntervalMs);
        refreshTimer.unref?.();
      }

      logStartup(log, config, url(), agentsCache);
      return { host: config.host, port: actualPort, url: url() };
    },
    async stop() {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  config: DaemonConfig,
  log: (line: string) => void,
): Promise<void> {
  const cors = corsHeaders(req, config);
  if (cors === null) {
    writeJson(res, 403, { error: "Origin not allowed.", code: "forbidden" });
    return;
  }
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!isAuthorized(req, config)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeJson(res, 401, { error: "Missing or invalid bearer token.", code: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  try {
    // Dynamic session route: DELETE /sessions/:id
    if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
      return handleDeleteSession(req, res, ctx, id);
    }

    switch (route) {
      case "GET /health":
        return handleHealth(req, res, ctx);
      case "GET /agents":
        return handleAgents(req, res, ctx);
      case "GET /sessions":
        return handleListSessions(req, res, ctx);
      case "POST /chat":
        return await handleChat(req, res, ctx);
      case "POST /reload":
        return await handleReload(req, res, ctx);
      default:
        writeJson(res, 404, { error: `No route for ${route}.`, code: "not_found" });
    }
  } catch (err) {
    log(`[portico] request error on ${route}: ${(err as Error).message}`);
    if (!res.headersSent) {
      writeJson(res, 500, { error: (err as Error).message, code: "internal" });
    } else {
      res.end();
    }
  }
}

function applyAgentOverrides(entries: AgentEntry[], config: DaemonConfig): AgentEntry[] {
  return entries.map((entry) => {
    const override = config.agents[entry.provider];
    if (!override) return entry;
    const next: AgentEntry = { ...entry };
    if (override.path) {
      next.path = override.path;
      next.available = true;
      next.source = "config";
    }
    if (override.enabled === false) {
      next.available = false;
      next.reason = "Disabled in config.";
    }
    return next;
  });
}

function isLanExposed(config: DaemonConfig): boolean {
  const loopback = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1";
  return config.lan || !loopback;
}

function assertLanSafety(config: DaemonConfig): void {
  if (isLanExposed(config) && !config.token) {
    throw new PorticoError(
      "config_invalid",
      "Refusing to expose Portico beyond loopback without a token. Set --token (or PORTICO_TOKEN).",
    );
  }
}

function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function logStartup(
  log: (line: string) => void,
  config: DaemonConfig,
  url: string,
  agents: AgentEntry[],
): void {
  log(`[portico] listening on ${url}`);
  const available = agents.filter((a) => a.available).map((a) => a.provider);
  log(`[portico] agents available: ${available.length ? available.join(", ") : "none"}`);
  if (config.allowOrigins.length > 0) {
    log(`[portico] extra allowed origins: ${config.allowOrigins.join(", ")}`);
  }
  if (isLanExposed(config)) {
    log(`[portico] WARNING: bound to ${config.host} — reachable beyond this machine. Token auth is required and enabled.`);
  }
}
