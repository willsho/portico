// Parse human-friendly durations ("90s", "30m", "2h", "1d", "1500ms") into milliseconds.
// Used by `runs --since` and `cleanup --older-than`. A bare number is treated as seconds.

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

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
