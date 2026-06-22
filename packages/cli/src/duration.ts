// Parse human-friendly durations ("90s", "30m", "2h", "1d", "1500ms") into milliseconds.
// Used by `runs --since` and `cleanup --older-than`. A bare number is treated as seconds.

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Format a past ISO timestamp as a compact relative age ("12s", "3m", "2h", "4d").
 *  Used by `portico watch` rows. Returns "now" for sub-second gaps and "?" for bad input. */
export function formatAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const ms = Math.max(0, now - then);
  if (ms < 1000) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Format a millisecond span as a compact duration ("8s", "3m", "2h", "4d").
 *  Used by `portico watch` to show how long a run took / has been running. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Returns the duration in milliseconds, or undefined when the text can't be parsed. */
export function parseDuration(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = UNIT_MS[unit];
  if (multiplier === undefined) return undefined;
  return value * multiplier;
}
