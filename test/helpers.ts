import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { decisionsHeader } from "../src/memory.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type Paths } from "../src/paths.ts";
import { loadPolicy, type Policy } from "../src/policy.ts";

export function scratch(prefix = "harness-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A throwaway git repository seeded from the toy fixture, with a real bare
 * `origin` so push is genuinely exercised. Nothing here is nested inside the
 * harness repo, and `HARNESS_HOME` keeps the sidecar out of the real home
 * directory.
 */
export function toyRepo(opts: { withHarness?: boolean } = {}): { dir: string; paths: Paths; policy: Policy } {
  const base = scratch("harness-toy-");
  const dir = join(base, "work");
  const origin = join(base, "origin.git");
  mkdirSync(dir, { recursive: true });
  cpSync(join(import.meta.dirname, "../fixtures/toy-repo"), dir, { recursive: true });

  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "ignore" });
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "harness@example.test");
  run(dir, "config", "user.name", "harness test");
  run(dir, "remote", "add", "origin", origin);
  run(dir, "add", "-A");
  run(dir, "commit", "-qm", "seed");
  run(dir, "push", "-q", "-u", "origin", "main");

  process.env.HARNESS_HOME = join(base, "sidecar");
  const paths = resolvePaths(dir);

  if (opts.withHarness !== false) {
    mkdirSync(paths.harnessDir, { recursive: true });
    copyFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), paths.policyFile);
    writeFileSync(paths.decisionsFile, decisionsHeader(), "utf8");
    run(dir, "add", "-A");
    run(dir, "commit", "-qm", "harness init");
    run(dir, "push", "-q", "origin", "main");
  }
  const policy = opts.withHarness === false
    ? (undefined as unknown as Policy)
    : loadPolicy(paths.policyFile);
  return { dir, paths, policy };
}

export function fencedJson(value: unknown): string {
  return "Here is the result.\n```json\n" + JSON.stringify(value, null, 2) + "\n```\n";
}
