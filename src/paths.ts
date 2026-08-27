import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type Paths = {
  repoRoot: string;
  slug: string;
  /** Committed to the target repo. */
  harnessDir: string;
  policyFile: string;
  decisionsFile: string;
  /** Sidecar: regenerable, never committed. */
  sidecar: string;
  eventsFile: string;
  stateFile: string;
  leasesFile: string;
  contextFile: string;
  repoProfileFile: string;
  lockFile: string;
  worktreesDir: string;
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function repoRoot(cwd = process.cwd()): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
}

/** `owner__name` from the origin remote, falling back to the directory name. */
export function repoSlug(root: string): string {
  try {
    const url = git(["remote", "get-url", "origin"], root);
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return `${m[1]}__${m[2]}`;
  } catch {
    // no remote yet - init is allowed to run before one exists
  }
  return basename(root);
}

/** The origin remote, or null when there is none. `start` requires one. */
export function originUrl(root: string): string | null {
  try {
    return git(["remote", "get-url", "origin"], root);
  } catch {
    return null;
  }
}

/**
 * Where the sidecar lives. `HARNESS_HOME` overrides it, which keeps tests off
 * the real home directory and lets one machine run isolated profiles.
 */
export function sidecarRoot(): string {
  return process.env.HARNESS_HOME || join(homedir(), ".harness");
}

export function resolvePaths(cwd = process.cwd()): Paths {
  const root = repoRoot(cwd);
  const slug = repoSlug(root);
  const harnessDir = join(root, ".harness");
  const sidecar = join(sidecarRoot(), slug);
  return {
    repoRoot: root,
    slug,
    harnessDir,
    policyFile: join(harnessDir, "policy.yaml"),
    decisionsFile: join(harnessDir, "decisions.md"),
    sidecar,
    eventsFile: join(sidecar, "events.jsonl"),
    stateFile: join(sidecar, "state.json"),
    leasesFile: join(sidecar, "leases.json"),
    contextFile: join(sidecar, "context.md"),
    repoProfileFile: join(sidecar, "repo.md"),
    lockFile: join(sidecar, "lock.json"),
    worktreesDir: join(sidecar, "worktrees"),
  };
}
