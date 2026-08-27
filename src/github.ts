import { execFileSync } from "node:child_process";

export class GhError extends Error {}

export type PullRequest = { number: number; url: string; isDraft: boolean; state: string };
export type Issue = { number: number; title: string; body: string };
export type CreatePrOptions = { branch: string; base: string; title: string; body: string; draft: boolean };

/**
 * The seam between the harness and the forge. Everything that decides *whether*
 * a pull request opens, what it says, and how it is labelled is exercised in
 * tests against `memoryForge`; only the `gh` adapter needs a real GitHub.
 */
export type Forge = {
  findPr(cwd: string, branch: string): PullRequest | null;
  /** State of every pull request the harness opened, by number. One call. */
  prStates(cwd: string): Map<number, string>;
  createPr(cwd: string, opts: CreatePrOptions): PullRequest;
  addLabels(cwd: string, prNumber: number, labels: string[]): void;
  /** Whether GitHub considers this pull request safe to merge right now. */
  mergeability(cwd: string, prNumber: number): { mergeable: string; state: string; draft: boolean };
  /** Squash-merges and returns the resulting commit, or throws. */
  mergePr(cwd: string, prNumber: number): string;
  openIssues(cwd: string, limit?: number): Issue[];
};

function gh(args: string[], cwd: string): string {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new GhError(`gh ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
  }
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

export const ghForge: Forge = {
  findPr(cwd, branch) {
    const out = gh(["pr", "list", "--head", branch, "--state", "all", "--json", "number,url,isDraft,state"], cwd);
    return (JSON.parse(out || "[]") as PullRequest[])[0] ?? null;
  },

  prStates(cwd) {
    const out = gh(["pr", "list", "--state", "all", "--limit", "100",
      "--label", "harness", "--json", "number,state"], cwd);
    const list = JSON.parse(out || "[]") as { number: number; state: string }[];
    return new Map(list.map((p) => [p.number, p.state]));
  },

  createPr(cwd, opts) {
    // Idempotent after a crash, but not stale: a re-run has newer concerns.
    const existing = ghForge.findPr(cwd, opts.branch);
    if (existing) {
      gh(["pr", "edit", String(existing.number), "--title", opts.title, "--body", opts.body], cwd);
      return existing;
    }
    const args = ["pr", "create", "--head", opts.branch, "--base", opts.base,
      "--title", opts.title, "--body", opts.body];
    if (opts.draft) args.push("--draft");
    gh(args, cwd);
    const created = ghForge.findPr(cwd, opts.branch);
    if (!created) throw new GhError(`created a pull request for ${opts.branch} but could not read it back`);
    return created;
  },

  mergeability(cwd, prNumber) {
    const out = gh(["pr", "view", String(prNumber), "--json", "mergeable,mergeStateStatus,isDraft"], cwd);
    const pr = JSON.parse(out) as { mergeable: string; mergeStateStatus: string; isDraft: boolean };
    return { mergeable: pr.mergeable, state: pr.mergeStateStatus, draft: pr.isDraft };
  },

  mergePr(cwd, prNumber) {
    gh(["pr", "merge", String(prNumber), "--squash"], cwd);
    const out = gh(["pr", "view", String(prNumber), "--json", "mergeCommit"], cwd);
    return (JSON.parse(out) as { mergeCommit?: { oid?: string } }).mergeCommit?.oid ?? "";
  },

  addLabels(cwd, prNumber, labels) {
    if (labels.length === 0) return;
    for (const label of labels) ensureLabel(cwd, label);
    try {
      gh(["pr", "edit", String(prNumber), ...labels.flatMap((l) => ["--add-label", l])], cwd);
    } catch {
      // A labelling failure must not sink a task that is otherwise complete.
    }
  },

  openIssues(cwd, limit = 20) {
    const out = gh(["issue", "list", "--state", "open", "--limit", String(limit),
      "--json", "number,title,body"], cwd);
    return JSON.parse(out || "[]") as Issue[];
  },
};

export type MemoryForge = Forge & {
  prs: (PullRequest & { branch: string; title: string; body: string; labels: string[] })[];
  issues: Issue[];
};

/** In-memory forge with the same idempotency contract as the `gh` adapter. */
export function memoryForge(issues: Issue[] = []): MemoryForge {
  const forge: MemoryForge = {
    prs: [],
    issues,
    findPr(_cwd, branch) {
      return forge.prs.find((p) => p.branch === branch) ?? null;
    },
    prStates() {
      return new Map(forge.prs.map((p) => [p.number, p.state]));
    },
    createPr(_cwd, opts) {
      const existing = forge.prs.find((p) => p.branch === opts.branch);
      if (existing) {
        existing.title = opts.title;
        existing.body = opts.body;
        return existing;
      }
      const pr = {
        number: forge.prs.length + 1,
        url: `https://example.test/pull/${forge.prs.length + 1}`,
        isDraft: opts.draft, state: "OPEN",
        branch: opts.branch, title: opts.title, body: opts.body, labels: [],
      };
      forge.prs.push(pr);
      return pr;
    },
    mergeability(_cwd, prNumber) {
      const pr = forge.prs.find((p) => p.number === prNumber);
      return { mergeable: "MERGEABLE", state: "CLEAN", draft: pr?.isDraft ?? false };
    },
    mergePr(_cwd, prNumber) {
      const pr = forge.prs.find((p) => p.number === prNumber);
      if (!pr) throw new GhError(`no such pull request: ${prNumber}`);
      if (pr.isDraft) throw new GhError("refusing to merge a draft");
      pr.state = "MERGED";
      return `sha-${prNumber}`;
    },
    addLabels(_cwd, prNumber, labels) {
      const pr = forge.prs.find((p) => p.number === prNumber);
      if (pr) pr.labels = [...new Set([...pr.labels, ...labels])];
    },
    openIssues() {
      return forge.issues;
    },
  };
  return forge;
}
