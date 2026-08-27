import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export class GitError extends Error {}

export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
export function ensureWorktree(root: string, dir: string, branch: string, base: string): string {
  if (existsSync(dir)) return dir;
  const args = branchExists(root, branch)
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, base];
  git(args, root);
  return dir;
}

export function removeWorktree(root: string, dir: string): void {
  if (!existsSync(dir)) return;
  git(["worktree", "remove", "--force", dir], root);
}

export function changedFiles(dir: string): string[] {
  const out = git(["status", "--porcelain"], dir);
  if (!out) return [];
  return out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
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

/** The harness authors commits; no agent ever runs git. */
export function commitAll(dir: string, message: string): string | null {
  if (!hasChanges(dir)) return null;
  git(["add", "-A"], dir);
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
      env: { ...process.env, HARNESS_REPO_ROOT: repoRoot },
    });
    return null;
  } catch (e) {
    return (e as { stderr?: string; message: string }).stderr || (e as Error).message;
  }
}
