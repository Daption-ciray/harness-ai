import { DEFAULT_OWNER, type Policy, type Role } from "./policy.ts";
import type { EventType, HarnessEvent } from "./events.ts";
import { anyMatch, splitPatterns } from "./glob.ts";

/**
 * Which role decides a task's next step.
 *
 * The lease is DERIVED, never stored: a function of the trace's events, the
 * policy and the clock. There is no leases.json to drift from the log, and any
 * process can compute the same answer.
 *
 * It orders and preempts. It does not gate — which verifiers a task still owes
 * is a separate question (see verify.ts), so a lease timing out can never skip a
 * verifier that policy requires.
 */
export type Lease = {
  holder: Role;
  reason: string;
  acquired_at: string;
  /** Set when a preempting role took the lease from someone else. */
  preempted_from: Role | null;
  /** True when the holder was reclaimed by the TTL rather than releasing. */
  expired: boolean;
};

export type RoutingInput = { paths: string[]; eventType?: EventType };

/** First matching rule wins; the `default` rule is the guaranteed fallback. */
export function resolveOwner(policy: Policy, input: RoutingInput): { owner: Role; reason: string } {
  for (const rule of policy.routing) {
    if (rule.on && rule.on === input.eventType) {
      return { owner: rule.owner, reason: `on:${rule.on}` };
    }
    if (rule.match && anyMatch(input.paths, splitPatterns(rule.match))) {
      return { owner: rule.owner, reason: `match:${rule.match}` };
    }
    if (rule.default) return { owner: rule.owner, reason: "default" };
  }
  return { owner: DEFAULT_OWNER, reason: "default" };
}

/** Only events that can change who should be in charge. */
function routingInput(event: HarnessEvent): RoutingInput | null {
  switch (event.type) {
    case "task_planned": return { paths: event.scope, eventType: event.type };
    case "build_done": return { paths: event.files, eventType: event.type };
    case "ci_result": return { paths: [], eventType: event.type };
    default: return null;
  }
}

/**
 * Rule 3: a preempting role takes the lease from anyone.
 * Rule 4: a non-preempting role takes it only from the default owner — without
 * this, two specialists tug the lease back and forth between themselves.
 */
function mayTake(policy: Policy, intended: Role, holder: Role): boolean {
  if (intended === holder) return false;
  return policy.roles[intended].preempt || holder === DEFAULT_OWNER;
}

export function resolveLease(events: HarnessEvent[], policy: Policy, now: number): Lease {
  const start = events[0]?.ts ?? new Date(now).toISOString();
  let lease: Lease = {
    holder: DEFAULT_OWNER, reason: "default",
    acquired_at: start, preempted_from: null, expired: false,
  };

  for (const event of events) {
    // A holder that has reported is done; the lease goes back to the default
    // owner so the next routing decision starts from a clean slate.
    if ((event.type === "verdict" || event.type === "veto") && event.role === lease.holder
      && lease.holder !== DEFAULT_OWNER) {
      lease = {
        holder: DEFAULT_OWNER, reason: `released by ${event.role}`,
        acquired_at: event.ts, preempted_from: null, expired: false,
      };
      continue;
    }

    const input = routingInput(event);
    if (!input) continue;
    const { owner, reason } = resolveOwner(policy, input);
    if (!mayTake(policy, owner, lease.holder)) continue;

    lease = {
      holder: owner, reason,
      acquired_at: event.ts,
      preempted_from: policy.roles[owner].preempt ? lease.holder : null,
      expired: false,
    };
  }

  // Rule 5: a holder that has sat on the lease past its TTL loses it, so a role
  // that never reports cannot freeze the trace. Safe precisely because the
  // verifier gate is separate: reclaiming the lease skips nobody's turn.
  const ttlMs = policy.runtime.lease_ttl_seconds * 1000;
  if (lease.holder !== DEFAULT_OWNER && now - Date.parse(lease.acquired_at) > ttlMs) {
    return {
      holder: DEFAULT_OWNER, reason: `ttl expired for ${lease.holder}`,
      acquired_at: new Date(now).toISOString(),
      preempted_from: null, expired: true,
    };
  }
  return lease;
}

export function expiresAt(lease: Lease, policy: Policy): string {
  return new Date(Date.parse(lease.acquired_at) + policy.runtime.lease_ttl_seconds * 1000).toISOString();
}
