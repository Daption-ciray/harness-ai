import { execFileSync } from "node:child_process";

export class GhError extends Error {}

function gh(args: string[], cwd: string): string {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new GhError(`gh ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
  }
}

export type PullRequest = { number: number; url: string; isDraft: boolean; state: string };

/** Idempotency: a re-run after a crash must find the existing PR, not open a twin. */
export function findPr(cwd: string, branch: string): PullRequest | null {
  const out = gh(["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,isDraft,state"], cwd);
  const list = JSON.parse(out || "[]") as PullRequest[];
  return list[0] ?? null;
}

export function createPr(
  cwd: string,
  opts: { branch: string; base: string; title: string; body: string; draft: boolean },
): PullRequest {
  const existing = findPr(cwd, opts.branch);
  if (existing) {
    // Idempotent, but not stale: a re-run has newer concerns to report.
    gh(["pr", "edit", String(existing.number), "--title", opts.title, "--body", opts.body], cwd);
    return existing;
  }
  const args = ["pr", "create", "--head", opts.branch, "--base", opts.base,
    "--title", opts.title, "--body", opts.body];
  if (opts.draft) args.push("--draft");
  gh(args, cwd);
  const created = findPr(cwd, opts.branch);
  if (!created) throw new GhError(`created a PR for ${opts.branch} but could not read it back`);
  return created;
}

const LABEL_COLOURS: Record<string, string> = {
  harness: "5319e7", "needs:human": "d93f0b", "blocked:devops": "b60205",
  "blocked:security": "b60205", stale: "fbca04",
};

/** `gh pr edit --add-label` fails outright on a label the repo does not have. */
function ensureLabel(cwd: string, name: string): void {
  try {
    gh(["label", "create", name, "--color", LABEL_COLOURS[name] ?? "ededed"], cwd);
  } catch {
    // Already exists, which is the common case.
  }
}

export function addLabels(cwd: string, prNumber: number, labels: string[]): void {
  if (labels.length === 0) return;
  for (const label of labels) ensureLabel(cwd, label);
  try {
    gh(["pr", "edit", String(prNumber), ...labels.flatMap((l) => ["--add-label", l])], cwd);
  } catch {
    // A labelling failure must not sink a task that is otherwise complete.
  }
}

export function openIssues(cwd: string, limit = 20): { number: number; title: string; body: string }[] {
  const out = gh(["issue", "list", "--state", "open", "--limit", String(limit), "--json", "number,title,body"], cwd);
  return JSON.parse(out || "[]") as { number: number; title: string; body: string }[];
}
