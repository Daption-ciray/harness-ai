/** Vocabulary shared by the event log, the projection, and policy evaluation. */

export type Origin = "trusted" | "untrusted";

export type TaskClass = "trivial" | "routine" | "risky";

export type TaskState =
  | "queued"       // needs the planner
  | "planned"      // needs a builder
  | "verifying"    // built; the verifiers have not all reported yet
  | "integrating"  // verified; needs devops
  | "escalated"    // pull request open, waiting on a human
  | "merged"
  | "failed";

export const ACTIVE_STATES: readonly TaskState[] =
  ["queued", "planned", "verifying", "integrating"];

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

/**
 * Identity of a finding for deduplication. Deliberately coarse: a verifier that
 * rewords the same complaint must not read as new information.
 */
export function findingKey(finding: Finding): string {
  const normalised = finding.summary
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
  return `${finding.file}::${normalised}`;
}

export function isActiveState(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state);
}
