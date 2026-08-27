import { findingKey, type Finding } from "./domain.ts";
import type { HarnessEvent } from "./events.ts";
import { resolveOwner } from "./lease.ts";
import type { Policy, Role } from "./policy.ts";

/** Roles that report a verdict on a revision rather than producing work. */
export const VERIFIER_ROLES: readonly Role[] = ["adversary", "review", "security"];

/** Every build produces a new revision; verdicts are always about one of them. */
export function currentRevision(events: HarnessEvent[]): number {
  return events.filter((e) => e.type === "build_done").length;
}

/**
 * `adversary` and `review` judge every revision. A routed specialist joins when
 * the touched paths call for it — that is the only way `security` ever enters a
 * task, and it is why routing is checked against real paths rather than guesses.
 *
 * `available` is what the harness can actually run today, so a role that policy
 * routes to but the harness has not implemented cannot silently block a task.
 */
export function requiredVerifiers(policy: Policy, paths: string[], available: readonly Role[]): Role[] {
  const required: Role[] = [];
  for (const role of ["adversary", "review"] as const) {
    if (available.includes(role)) required.push(role);
  }
  const routed = resolveOwner(policy, { paths }).owner;
  if (VERIFIER_ROLES.includes(routed) && available.includes(routed) && !required.includes(routed)) {
    required.push(routed);
  }
  return required;
}

export function reportedVerifiers(events: HarnessEvent[], revision: number): Role[] {
  return events
    .filter((e) => (e.type === "verdict" || e.type === "veto") && e.revision === revision)
    .map((e) => (e as Extract<HarnessEvent, { type: "verdict" | "veto" }>).role);
}

/**
 * Who still owes a report on the current revision, lease holder first. The lease
 * decides the order; this decides the set. Keeping them separate is what makes a
 * lease timeout unable to skip a verifier.
 */
export function pendingVerifiers(
  events: HarnessEvent[],
  policy: Policy,
  paths: string[],
  available: readonly Role[],
  leaseHolder: Role,
): Role[] {
  const revision = currentRevision(events);
  const reported = new Set(reportedVerifiers(events, revision));
  const pending = requiredVerifiers(policy, paths, available).filter((r) => !reported.has(r));
  return pending.sort((a, b) => Number(b === leaseHolder) - Number(a === leaseHolder));
}

export type Stall = { kind: "max_rounds" | "ping_pong" | "no_progress"; role: Role; detail: string };

type VetoEvent = Extract<HarnessEvent, { type: "veto" }>;

function vetoes(events: HarnessEvent[]): VetoEvent[] {
  return events.filter((e): e is VetoEvent => e.type === "veto");
}

function blockerKeys(veto: VetoEvent): Set<string> {
  return new Set(veto.findings.filter((f: Finding) => f.severity === "blocker").map(findingKey));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/**
 * Three ways a verify loop stops being useful. All three are decided from
 * structured findings rather than by asking a model whether two complaints are
 * "the same" — a judgement call at the point where the loop most needs a
 * decision it can trust.
 */
export function detectStall(events: HarnessEvent[], policy: Policy): Stall | null {
  const all = vetoes(events);

  // 1. A role has spent its allowance of rounds.
  for (const role of VERIFIER_ROLES) {
    const limit = policy.veto[role]?.max_rounds;
    const count = all.filter((v) => v.role === role).length;
    if (limit !== undefined && count > limit) {
      return { kind: "max_rounds", role, detail: `${role} vetoed ${count} times, limit ${limit}` };
    }
  }

  for (const role of VERIFIER_ROLES) {
    const mine = all.filter((v) => v.role === role).sort((a, b) => a.revision - b.revision);

    // 2. Consecutive revisions with an identical blocker set: the builder
    //    changed something, the complaint did not. Another round will not help.
    for (let i = 1; i < mine.length; i++) {
      const previous = blockerKeys(mine[i - 1]);
      const current = blockerKeys(mine[i]);
      if (previous.size > 0 && sameSet(previous, current)) {
        return {
          kind: "no_progress", role,
          detail: `${role} raised the same ${current.size} blocker(s) on revisions ` +
            `${mine[i - 1].revision} and ${mine[i].revision}`,
        };
      }
    }

    // 3. A blocker that was raised, went away, and came back. The two sides are
    //    undoing each other rather than converging.
    const seen = new Map<string, number[]>();
    for (const veto of mine) {
      for (const key of blockerKeys(veto)) {
        seen.set(key, [...(seen.get(key) ?? []), veto.revision]);
      }
    }
    for (const [key, revisions] of seen) {
      for (let i = 1; i < revisions.length; i++) {
        if (revisions[i] - revisions[i - 1] > 1) {
          return {
            kind: "ping_pong", role,
            detail: `${role} re-raised "${key}" on revision ${revisions[i]} after it cleared ` +
              `on revision ${revisions[i - 1] + 1}`,
          };
        }
      }
    }
  }
  return null;
}

/** Concerns from every verifier that judged the current revision, for the PR body. */
export function concernsFor(events: HarnessEvent[], revision: number): string[] {
  return events
    .filter((e): e is Extract<HarnessEvent, { type: "verdict" | "veto" }> =>
      (e.type === "verdict" || e.type === "veto") && e.revision === revision)
    .flatMap((e) => e.findings
      .filter((f) => f.severity === "concern")
      .map((f) => `${e.role}: ${f.file}${f.line ? `:${f.line}` : ""} — ${f.summary}`));
}
