// Delegate profiles: named, layered, version-controllable presets for `portico delegate`.
//
// A profile is a Markdown file with YAML-ish frontmatter (the config) and an optional body
// (a standing task preamble, prepended to the task — the analog of a subagent's system prompt).
// Profiles resolve from two scopes, closest-wins:
//   1. project — <repo>/.portico/agents/<name>.md   (shareable via version control)
//   2. user    — ~/.portico/agents/<name>.md         (personal, all repos)
// The project scope overrides the user scope field-by-field.
//
// Resolution is entirely CLI-side: a profile only fills DelegateRequest fields the caller left
// unset, so an explicit flag always wins (precedence CLI flag > profile > config > default) and
// the daemon never needs to know profiles exist.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DelegateProfile {
  /** Identity — the filename stem the caller passes to `--profile`. */
  name: string;
  description?: string;
  to?: string;
  mode?: string;
  model?: string;
  effort?: string;
  permissionProfile?: string;
  allowed?: string[];
  forbidden?: string[];
  testCommands?: string[];
  idleTimeoutMs?: number;
  /** Standing task preamble (the Markdown body), prepended to the task when present. */
  body?: string;
  /** Which scopes contributed, in merge order (e.g. ["user", "project"]). */
  sources: string[];
}

/** Frontmatter keys a profile understands (including accepted aliases). */
const KNOWN_KEYS = new Set([
  "name", "description", "to", "mode", "model", "effort",
  "permissionProfile", "permission-profile",
  "allowed", "allowedPaths", "forbidden", "forbiddenPaths",
  "testCommands", "test", "idleTimeoutMs", "idleTimeout",
]);
const VALID_MODES = new Set(["implement", "review", "compare", "split"]);
const VALID_PERMISSION_PROFILES = new Set(["default", "read-only", "auto-edit"]);

/** A single profile file's lint result (per file, not merged), for `portico doctor`. */
export interface ProfileLint {
  name: string;
  scope: "project" | "user";
  path: string;
  warnings: string[];
}

/** The two profile directories for a repo, in precedence order (project wins over user). */
export function profileDirs(repo: string, env: NodeJS.ProcessEnv = process.env): { project: string; user: string } {
  const userBase = env["PORTICO_HOME"] ?? homedir();
  return {
    project: join(repo, ".portico", "agents"),
    user: join(userBase, ".portico", "agents"),
  };
}

/** Resolve a named profile, merging the user scope under the project scope. Undefined if neither exists. */
export function loadProfile(
  repo: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): DelegateProfile | undefined {
  const dirs = profileDirs(repo, env);
  const user = loadProfileFile(join(dirs.user, `${name}.md`), name, "user");
  const project = loadProfileFile(join(dirs.project, `${name}.md`), name, "project");
  if (user && project) return mergeProfiles(user, project);
  return project ?? user;
}

/** Enumerate every profile visible to a repo (project + user), merged and sorted by name. */
export function listProfiles(repo: string, env: NodeJS.ProcessEnv = process.env): DelegateProfile[] {
  const dirs = profileDirs(repo, env);
  const names = new Set<string>();
  for (const dir of [dirs.project, dirs.user]) {
    for (const file of safeReaddir(dir)) {
      if (file.endsWith(".md")) names.add(file.slice(0, -3));
    }
  }
  return [...names]
    .sort()
    .map((name) => loadProfile(repo, name, env))
    .filter((p): p is DelegateProfile => p !== undefined);
}

/**
 * Lint every profile file (per file, not merged) so `portico doctor` can surface authoring
 * mistakes the lenient loader otherwise swallows: unknown frontmatter keys (typos), invalid
 * `mode` / `permissionProfile` values, and a non-numeric `idleTimeoutMs`.
 */
export function lintProfiles(repo: string, env: NodeJS.ProcessEnv = process.env): ProfileLint[] {
  const dirs = profileDirs(repo, env);
  const results: ProfileLint[] = [];
  for (const [scope, dir] of [["project", dirs.project], ["user", dirs.user]] as const) {
    for (const file of safeReaddir(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      let data: Record<string, unknown>;
      try {
        data = parseFrontmatter(readFileSync(path, "utf8")).data;
      } catch {
        results.push({ name: file.slice(0, -3), scope, path, warnings: ["could not read the file"] });
        continue;
      }
      const warnings: string[] = [];
      for (const key of Object.keys(data)) {
        if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" (ignored — typo?)`);
      }
      const mode = data.mode;
      if (typeof mode === "string" && !VALID_MODES.has(mode)) {
        warnings.push(`invalid mode "${mode}" (expected ${[...VALID_MODES].join(" | ")})`);
      }
      const perm = data.permissionProfile ?? data["permission-profile"];
      if (typeof perm === "string" && !VALID_PERMISSION_PROFILES.has(perm)) {
        warnings.push(`invalid permissionProfile "${perm}" (expected ${[...VALID_PERMISSION_PROFILES].join(" | ")})`);
      }
      const idle = data.idleTimeoutMs ?? data.idleTimeout;
      if (idle !== undefined && asNumber(idle) === undefined) {
        warnings.push(`idleTimeoutMs "${String(idle)}" is not a number`);
      }
      results.push({ name: file.slice(0, -3), scope, path, warnings });
    }
  }
  return results;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadProfileFile(path: string, name: string, scope: string): DelegateProfile | undefined {
  if (!existsSync(path)) return undefined;
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  return toProfile(name, data, body, scope);
}

function mergeProfiles(base: DelegateProfile, over: DelegateProfile): DelegateProfile {
  return {
    name: over.name,
    description: over.description ?? base.description,
    to: over.to ?? base.to,
    mode: over.mode ?? base.mode,
    model: over.model ?? base.model,
    effort: over.effort ?? base.effort,
    permissionProfile: over.permissionProfile ?? base.permissionProfile,
    allowed: over.allowed ?? base.allowed,
    forbidden: over.forbidden ?? base.forbidden,
    testCommands: over.testCommands ?? base.testCommands,
    idleTimeoutMs: over.idleTimeoutMs ?? base.idleTimeoutMs,
    body: over.body ?? base.body,
    sources: [...base.sources, ...over.sources],
  };
}

function toProfile(name: string, data: Record<string, unknown>, body: string, source: string): DelegateProfile {
  const profile: DelegateProfile = { name, sources: [source] };
  const description = asString(data.description);
  if (description) profile.description = description;
  const to = asString(data.to);
  if (to) profile.to = to;
  const mode = asString(data.mode);
  if (mode) profile.mode = mode;
  const model = asString(data.model);
  if (model) profile.model = model;
  const effort = asString(data.effort);
  if (effort) profile.effort = effort;
  const permissionProfile = asString(data.permissionProfile ?? data["permission-profile"]);
  if (permissionProfile) profile.permissionProfile = permissionProfile;
  const allowed = asStringArray(data.allowed ?? data.allowedPaths);
  if (allowed) profile.allowed = allowed;
  const forbidden = asStringArray(data.forbidden ?? data.forbiddenPaths);
  if (forbidden) profile.forbidden = forbidden;
  const testCommands = asStringArray(data.testCommands ?? data.test);
  if (testCommands) profile.testCommands = testCommands;
  const idleTimeoutMs = asNumber(data.idleTimeoutMs ?? data.idleTimeout);
  if (idleTimeoutMs !== undefined) profile.idleTimeoutMs = idleTimeoutMs;
  const trimmedBody = body.trim();
  if (trimmedBody) profile.body = trimmedBody;
  return profile;
}

/**
 * Minimal frontmatter parser — no YAML dependency (Portico ships zero runtime deps).
 * Supports `key: scalar`, inline arrays `key: [a, b]`, and block lists:
 *   key:
 *     - a
 *     - b
 * Scalars coerce to number / boolean where unambiguous; everything else is a string.
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { data: {}, body: normalized.trim() };

  const [, frontmatter = "", body = ""] = match;
  const data: Record<string, unknown> = {};
  let listKey: string | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as unknown[]).push(coerce(stripQuotes((item[1] ?? "").trim())));
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv || !kv[1]) continue;
    const key = kv[1];
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      data[key] = [];
      listKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => coerce(stripQuotes(s)));
      listKey = undefined;
    } else {
      data[key] = coerce(stripQuotes(rest));
      listKey = undefined;
    }
  }
  return { data, body: body.trim() };
}

function coerce(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    return items.length ? items : undefined;
  }
  const single = asString(value);
  return single ? [single] : undefined;
}
