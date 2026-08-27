/** Vocabulary shared by the event log, the projection, and policy evaluation. */

export type Origin = "trusted" | "untrusted";

export type TaskClass = "trivial" | "routine" | "risky";

export type TaskState =
  | "queued"       // needs the planner
  | "planned"      // needs a builder
  | "verifying"    // built; the verifiers have not all reported yet
  | "scribing"     // verified; the decision entry is not written yet
  | "integrating"  // verified and recorded; needs devops
  | "escalated"    // pull request open, waiting on a human
  | "merged"
  | "failed";

export const ACTIVE_STATES: readonly TaskState[] =
  ["queued", "planned", "verifying", "scribing", "integrating"];

/**
 * A verifier reports findings, not prose. Only a `blocker` is a veto; a
 * `concern` is advisory and travels to the pull request body. Keeping the
 * distinction in the data is what lets stall detection be mechanical instead of
 * a model judging whether two complaints are "the same".
 */
export type Severity = "blocker" | "concern";

export type Finding = {
  file: string;
  line?: number;
  summary: string;
  severity: Severity;
};

function normalise(summary: string): string {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
}

/**
 * Identity for stall detection: the same complaint about the same file.
 * Deliberately coarse on the wording, so a verifier that rephrases itself does
 * not read as new information.
 */
export function findingKey(finding: Finding): string {
  return `${finding.file}::${normalise(finding.summary)}`;
}

/**
 * Identity for pitfalls, which deliberately ignores the file. The same mistake
 * appearing in different files across different tasks is what makes it a
 * property of the codebase rather than of one change — keying on the file would
 * hide exactly the pattern worth remembering.
 */
export function summaryKey(finding: Finding): string {
  return normalise(finding.summary);
}

export function isActiveState(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state);
}
