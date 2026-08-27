import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cleanEnv } from "./env.ts";

export class GitError extends Error {}

/**
 * `raw` keeps the output byte-exact. Porcelain status lines start with a status
 * column that is a space for an unstaged change, and trimming the whole output
 * eats that space off the FIRST line only - shifting one path by one character
 * while every other line parses fine.
 */
export function git(args: string[], cwd: string, opts?: { raw?: boolean }): string {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return opts?.raw ? out : out.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new GitError(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
  }
}

export function branchExists(root: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", `refs/heads/${branch}`], root);
    return true;
  } catch {
    return false;
  }
}

/**
 * One worktree per builder. Test runs and edits stay isolated, so two builders
 * cannot corrupt each other's results. Idempotent: an existing worktree for the
 * branch is reused, which is what makes crash-restart safe.
 */
export function ensureWorktree(root: string, dir: string, branch: string, base: string): { dir: string; created: boolean } {
  if (existsSync(dir)) return { dir, created: false };
  const args = branchExists(root, branch)
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, base];
  git(args, root);
  return { dir, created: true };
}

export function removeWorktree(root: string, dir: string): void {
  if (!existsSync(dir)) return;
  git(["worktree", "remove", "--force", dir], root);
}

export function untrackedFiles(dir: string): string[] {
  return git(["ls-files", "--others", "--exclude-standard"], dir)
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Files this branch changes relative to base, already committed. */
export function branchFiles(dir: string, base: string): string[] {
  return git(["diff", "--name-only", `${base}...HEAD`], dir)
    .split("\n").map((l) => l.trim()).filter(Boolean);
}

/** `-z` also removes git's quoting of unusual filenames. */
export function changedFiles(dir: string): string[] {
  const out = git(["status", "--porcelain", "-z"], dir, { raw: true });
  return out.split("\0").filter((l) => l.length > 3).map((l) => l.slice(3));
}

export function hasChanges(dir: string): boolean {
  return changedFiles(dir).length > 0;
}

export function diffStat(dir: string, base: string): { files: number; lines: number } {
  const out = git(["diff", "--numstat", `${base}...HEAD`], dir);
  if (!out) return { files: 0, lines: 0 };
  const rows = out.split("\n").filter(Boolean);
  const lines = rows.reduce((n, r) => {
    const [add, del] = r.split("\t");
    return n + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
  return { files: rows.length, lines };
}

/**
 * The harness authors commits; no agent ever runs git.
 *
 * Only the listed paths are staged. `git add -A` would sweep in whatever the
 * worktree setup left behind - a `node_modules` symlink is not matched by a
 * `node_modules/` ignore pattern, for one - and it cannot be fixed with an
 * exclude file, because git resolves info/exclude to the shared directory for
 * every worktree. Staging the authorised paths is the honest fix: the harness
 * already knows which files the plan allowed to change.
 */
export function commitAll(dir: string, message: string, paths: string[]): string | null {
  if (paths.length === 0) return null;
  git(["add", "--", ...paths], dir);
  if (git(["diff", "--cached", "--name-only"], dir) === "") return null;
  git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

export function push(dir: string, branch: string): void {
  git(["push", "-u", "origin", branch], dir);
}

/**
 * A fresh worktree has none of the repo's gitignored directories, so the test
 * command would fail before the builder ever ran. Policy supplies the fix.
 * Best effort: a failing setup must not sink the task, it shows up as a failing
 * test instead, which is the signal we want anyway.
 */
export function runWorktreeSetup(dir: string, repoRoot: string, command: string | undefined): string | null {
  if (!command) return null;
  try {
    execFileSync(command, {
      cwd: dir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv({ HARNESS_REPO_ROOT: repoRoot }),
    });
    return null;
  } catch (e) {
    return (e as { stderr?: string; message: string }).stderr || (e as Error).message;
  }
}

