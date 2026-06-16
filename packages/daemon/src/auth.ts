// CORS and bearer-token checks. Defaults are loopback-only and permissive for
// localhost dev; production origins and LAN tokens must be opted into.

import type { IncomingMessage } from "node:http";
import type { DaemonConfig } from "./config.ts";

/** Whether an Origin is allowed. localhost/127.0.0.1 on any port is always allowed. */
export function isOriginAllowed(origin: string, config: DaemonConfig): boolean {
  if (config.allowOrigins.includes(origin)) return true;
  if (config.allowOrigins.includes("*")) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export interface CorsHeaders {
  [header: string]: string;
}

/** Compute CORS response headers for a request, or `null` if the origin is rejected. */
export function corsHeaders(req: IncomingMessage, config: DaemonConfig): CorsHeaders | null {
  const origin = req.headers.origin;
  // No Origin header (curl, same-process, server-to-server) — nothing to gate on.
  if (!origin) return {};
  if (!isOriginAllowed(origin, config)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** True if the request carries the required bearer token (or no token is configured). */
export function isAuthorized(req: IncomingMessage, config: DaemonConfig): boolean {
  if (!config.token) return true;
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] === config.token;
}
