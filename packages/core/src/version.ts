// Minimal semver handling. We only need: extract a version from CLI output,
// compare two versions, and check a minimum. No need for the full `semver` package.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  raw: string;
}

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/** Extract the first semver-looking token from arbitrary `--version` output. */
export function parseSemver(text: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(text);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease || undefined,
    raw: `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}`,
  };
}

/**
 * Compare two versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * A release version outranks a prerelease of the same x.y.z (1.0.0 > 1.0.0-rc).
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1; // a is a full release, b is a prerelease
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Whether `version` satisfies the `minVersion` floor. Returns true if either is unparseable. */
export function satisfiesMinVersion(version: string | null, minVersion?: string): boolean {
  if (!minVersion) return true;
  const have = typeof version === "string" ? parseSemver(version) : version;
  const min = parseSemver(minVersion);
  if (!have || !min) return true; // can't decide -> don't block
  return compareVersions(have, min) >= 0;
}

export type VersionStatus = "ok" | "too_old" | "unknown";

export function versionStatus(version: string | null, minVersion?: string): VersionStatus {
  if (!version || !parseSemver(version)) return "unknown";
  if (!minVersion) return "ok";
  return satisfiesMinVersion(version, minVersion) ? "ok" : "too_old";
}
