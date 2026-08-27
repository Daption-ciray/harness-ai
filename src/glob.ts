import { matchesGlob } from "node:path";

/**
 * A routing or classification entry may be a concrete path (`package.json`) or a
 * glob prefix (`src/auth/**`). Probing the prefix is what lets `src/auth/**`
 * still match a pattern written as `**\/auth/**`.
 *
 * Ties resolve toward matching: over-triggering sends work to a stricter role or
 * a more careful tier, which is the safe direction to be wrong in.
 */
export function entryMatches(entry: string, pattern: string): boolean {
  if (matchesGlob(entry, pattern)) return true;
  if (!entry.includes("*")) return false;
  const probe = entry.replace(/\*+$/, "").replace(/\/+$/, "") + "/__probe__";
  return matchesGlob(probe, pattern);
}

export function anyMatch(paths: string[], patterns: string[]): boolean {
  return paths.some((p) => patterns.some((g) => entryMatches(p, g)));
}

/** Routing rules write alternatives as a single `a|b|c` string. */
export function splitPatterns(pattern: string): string[] {
  return pattern.split("|").map((p) => p.trim()).filter(Boolean);
}
