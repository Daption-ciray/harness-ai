import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `dir` and return the parsed contents of the nearest package.json, or null. */
function findPackageJson(dir: string): { version?: unknown } | null {
  let current = dir;
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8"));
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The harness CLI's own version, from the package.json nearest this module —
 * so `harness version` reports the tool's identity even when cwd is some other
 * repo the harness operates on. cwd is a fallback for the unlikely case that
 * walk finds nothing above the module itself.
 */
export function version(cwd = process.cwd()): string {
  const pkg = findPackageJson(import.meta.dirname) ?? findPackageJson(cwd);
  if (typeof pkg?.version !== "string") throw new Error("could not find a package.json with a version field");
  return pkg.version;
}
