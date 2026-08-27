import { matchesGlob } from "node:path";
import type { HarnessEvent } from "./events.ts";
import { splitPatterns } from "./glob.ts";
import type { Policy } from "./policy.ts";
import type { Task } from "./projection.ts";

/**
 * Decides whether a change may reach the default branch without a person.
 *
 * Fail-closed everywhere. A rule this code does not recognise escalates rather
 * than being ignored; a fact it cannot establish escalates rather than being
 * assumed benign. The failure mode being designed against is not "escalates too
 * often" — it is a rule silently doing nothing, which looks identical to safety
 * right up until it isn't.
 */
export type MergeFacts = {
  /** Files this branch changes, relative to the default branch. */
  files: string[];
  diffLines: number;
  /** Merges of harness pull requests so far, however they were merged. */
  mergesSoFar: number;
  /** True when a removed or altered line declared something exported. */
  publicApiChange: boolean;
};

export type Gate = { escalate: boolean; reasons: string[] };

function compare(value: number, expression: string): boolean | null {
  const m = expression.trim().match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
  if (!m) return null; // unparseable threshold: caller escalates
  const bound = Number(m[2]);
  switch (m[1] ?? "=") {
    case ">=": return value >= bound;
    case "<=": return value <= bound;
    case ">": return value > bound;
    case "<": return value < bound;
    default: return value === bound;
  }
}

/** Lines a diff REMOVED or CHANGED that declared something exported. */
export function detectPublicApiChange(diff: string): boolean {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .some((l) => /^-\s*(export\s|pub\s|public\s|def\s|func\s+[A-Z])/.test(l));
}

export function evaluateGate(
  policy: Policy,
  task: Task,
  events: HarnessEvent[],
  facts: MergeFacts,
): Gate {
  const reasons: string[] = [];
  const mine = events.filter((e) => e.trace_id === task.id);

  if (!policy.merge.auto) {
    return { escalate: true, reasons: ["merge.auto is off"] };
  }

  for (const rule of policy.merge.escalate_when) {
    if (rule.first_n_merges !== undefined && facts.mergesSoFar < rule.first_n_merges) {
      reasons.push(`only ${facts.mergesSoFar} of the first ${rule.first_n_merges} merges have been reviewed`);
    }
    // No exception, ever. This is the prompt-injection cut-off: text written by
    // a stranger must not reach the default branch unread.
    if (rule.origin !== undefined && task.origin === rule.origin) {
      reasons.push(`origin is ${task.origin}`);
    }
    if (rule.task_class !== undefined && task.task_class === rule.task_class) {
      reasons.push(`task class is ${task.task_class}`);
    }
    if (rule.security_finding === "any") {
      const found = mine.some((e) =>
        (e.type === "veto" || e.type === "verdict") && e.role === "security" && e.findings.length > 0);
      if (found) reasons.push("security raised a finding");
    }
    if (rule.acceptance_unmet === "any" && task.acceptance.length === 0) {
      reasons.push("no acceptance criteria to check against");
    }
    if (rule.public_api_change === true && facts.publicApiChange) {
      reasons.push("a public declaration was removed or changed");
    }
    if (rule.review_rounds !== undefined) {
      const rounds = mine.filter((e) => e.type === "veto" && e.role === "review").length;
      const hit = compare(rounds, rule.review_rounds);
      if (hit === null) reasons.push(`review_rounds rule "${rule.review_rounds}" is unreadable`);
      else if (hit) reasons.push(`review vetoed ${rounds} time(s)`);
    }
    if (rule.diff_files !== undefined) {
      const hit = compare(facts.files.length, rule.diff_files);
      if (hit === null) reasons.push(`diff_files rule "${rule.diff_files}" is unreadable`);
      else if (hit) reasons.push(`${facts.files.length} files changed`);
    }
    if (rule.diff_lines !== undefined) {
      const hit = compare(facts.diffLines, rule.diff_lines);
      if (hit === null) reasons.push(`diff_lines rule "${rule.diff_lines}" is unreadable`);
      else if (hit) reasons.push(`${facts.diffLines} lines changed`);
    }
    if (rule.path_touched !== undefined) {
      const patterns = splitPatterns(rule.path_touched);
      const hits = facts.files.filter((f) => patterns.some((g) => matchesGlob(f, g)));
      if (hits.length) reasons.push(`touches ${hits.join(", ")}`);
    }
  }

  // A quarantined change never merges: only a person releases a hard veto.
  if (task.quarantined) reasons.push("quarantined by security");

  return { escalate: reasons.length > 0, reasons };
}
