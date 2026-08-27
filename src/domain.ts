/** Vocabulary shared by the event log, the projection, and policy evaluation. */

export type Origin = "trusted" | "untrusted";

export type TaskClass = "trivial" | "routine" | "risky";

export type TaskState =
  | "queued"      // needs the planner
  | "planned"     // needs a builder
  | "built"       // needs devops
  | "escalated"   // pull request open, waiting on a human
  | "merged"
  | "failed";

export const ACTIVE_STATES: readonly TaskState[] = ["queued", "planned", "built"];

export function isActiveState(state: TaskState): boolean {
  return ACTIVE_STATES.includes(state);
}
