// Model discovery and validation helpers.
// Pure functions (except discoverModels, which may run a probe) for resolving,
// validating, and discovering provider model catalogs.

import { captureProbe } from "./runner.ts";
import type { AgentEntry, AgentProvider, ModelDescriptor } from "./types.ts";

/** TTL for cached probe results (60 seconds). */
const MODEL_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  models: ModelDescriptor[];
  expiresAt: number;
}

const modelCache = new Map<string, CacheEntry>();

/** Whether the provider accepts a model choice via CLI args. */
export function modelSelectionSupported(provider: AgentProvider): boolean {
  return typeof provider.modelArgs === "function";
}

/**
 * Resolve a user-supplied model string against a known catalog.
 * Returns the canonical id if `input` matches a model id or an alias;
 * otherwise returns `input` unchanged (custom / unknown ids pass through).
 */
export function resolveModel(models: ModelDescriptor[], input: string): string {
  // Direct id match.
  for (const m of models) {
    if (m.id === input) return m.id;
  }
  // Alias match.
  for (const m of models) {
    if (m.aliases?.includes(input)) return m.id;
  }
  // Unknown — pass through.
  return input;
}

/**
 * Returns true only when the provider has a non-empty **static** catalog and
 * the model is NOT one of the known ids or aliases. Probe-derived or empty
 * catalogs always return false (pass through).
 */
export function modelKnownIncompatible(
  provider: AgentProvider,
  models: ModelDescriptor[],
  model: string,
): boolean {
  const staticList = provider.models?.static;
  if (!staticList || staticList.length === 0) return false;
  const resolved = resolveModel(models, model);
  return !staticList.some(
    (m) => m.id === resolved || (m.aliases?.includes(model) ?? false),
  );
}

/**
 * Discover the models a provider supports.
 * - static → returns `provider.models.static ?? []`
 * - probe  → runs the probe command, parses output, caches result
 * - both   → merges (static first, then new probe entries)
 * Cache keyed by `${provider.id}:${entry.path ?? ""}`, TTL ~60s.
 * Empty/failed probe → `[]` (never throws).
 */
export async function discoverModels(
  provider: AgentProvider,
  entry: AgentEntry,
  env?: NodeJS.ProcessEnv,
): Promise<ModelDescriptor[]> {
  const staticModels = provider.models?.static ?? [];
  const probe = provider.models?.probe;

  if (!probe) return staticModels;

  // Check cache.
  const cacheKey = `${provider.id}:${entry.path ?? ""}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return mergeModels(staticModels, cached.models);
  }

  // Run probe.
  let probeModels: ModelDescriptor[] = [];
  if (entry.path) {
    try {
      const { stdout, stderr, code, timedOut } = await captureProbe(
        entry.path,
        probe.args,
        {
          timeoutMs: probe.timeoutMs ?? 5000,
          env,
          maxOutputBytes: 64_000,
        },
      );
      if (code === 0 && !timedOut) {
        probeModels = probe.parse(stdout, stderr);
      }
    } catch {
      // Failed probe → empty list, never throw.
    }
  }

  // Cache the probe result.
  modelCache.set(cacheKey, {
    models: probeModels,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
  });

  return mergeModels(staticModels, probeModels);
}

/** Merge static and probe models. Static first, then probe entries whose id is new. */
function mergeModels(
  staticModels: ModelDescriptor[],
  probeModels: ModelDescriptor[],
): ModelDescriptor[] {
  if (probeModels.length === 0) return staticModels;
  if (staticModels.length === 0) return probeModels;
  const knownIds = new Set(staticModels.map((m) => m.id));
  const novel = probeModels.filter((m) => !knownIds.has(m.id));
  return [...staticModels, ...novel];
}
