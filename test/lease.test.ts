import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../src/events.ts";
import { resolveLease, resolveOwner } from "../src/lease.ts";
import { parsePolicy, ROLES, type Policy, type Role } from "../src/policy.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function planned(minute: number, scope: string[]): HarnessEvent {
  return {
    ts: at(minute), trace_id: "bk-1", type: "task_planned", role: "planner",
    task_class: "routine", scope, acceptance: ["x"], steps: [], ladder_step: 0,
  };
}
function built(minute: number, files: string[]): HarnessEvent {
  return { ts: at(minute), trace_id: "bk-1", type: "build_done", files, revision: 1 };
}
function reported(minute: number, role: Role): HarnessEvent {
  return { ts: at(minute), trace_id: "bk-1", type: "verdict", role, revision: 1, findings: [], note: "" };
}
function spanStart(minute: number, role: Role): HarnessEvent {
  return {
    ts: at(minute), trace_id: "bk-1", type: "span_start",
    span_id: "s", role, model: "m", effort: "high", ladder_step: 0,
  };
}

const now = (minutes: number) => T0 + minutes * 60_000;

test("routing: first matching rule wins and there is always a fallback", () => {
  assert.equal(resolveOwner(policy, { paths: ["src/auth/token.ts"] }).owner, "security");
  assert.equal(resolveOwner(policy, { paths: ["db/2026_migration.sql"] }).owner, "security");
  assert.equal(resolveOwner(policy, { paths: ["src/api/users.ts"] }).owner, "review");
  assert.equal(resolveOwner(policy, { paths: [], eventType: "ci_result" }).owner, "devops");
  assert.equal(resolveOwner(policy, { paths: ["src/anything.ts"] }).owner, "planner");
  assert.equal(resolveOwner(policy, { paths: [] }).owner, "planner");
});

test("rule 2: an empty trace is held by the default owner", () => {
  const lease = resolveLease([], policy, now(0));
  assert.equal(lease.holder, "planner");
  assert.equal(lease.reason, "default");
});

test("rule 4: a non-preempting role may take the lease from the default owner", () => {
  const lease = resolveLease([planned(0, ["src/api/users.ts"])], policy, now(1));
  assert.equal(lease.holder, "review");
  assert.equal(lease.preempted_from, null);
});

test("rule 3: a preempting role takes the lease from a specialist", () => {
  const lease = resolveLease([
    planned(0, ["src/api/users.ts"]),   // review takes it
    built(1, ["src/auth/token.ts"]),    // security preempts
  ], policy, now(2));
  assert.equal(lease.holder, "security");
  assert.equal(lease.preempted_from, "review");
});

test("rule 4: a non-preempting role may NOT take the lease from a specialist", () => {
  // Without this, review and security tug the lease back and forth and the
  // trace never settles on who is in charge.
  const lease = resolveLease([
    planned(0, ["src/auth/token.ts"]),  // security takes it
    built(1, ["src/api/users.ts"]),     // review would like it
  ], policy, now(2));
  assert.equal(lease.holder, "security");
});

test("a holder that reports releases the lease back to the default owner", () => {
  const lease = resolveLease([
    planned(0, ["src/auth/token.ts"]),
    reported(1, "security"),
  ], policy, now(2));
  assert.equal(lease.holder, "planner");
  assert.match(lease.reason, /released by security/);
});

test("a report from someone who does not hold the lease changes nothing", () => {
  const lease = resolveLease([
    planned(0, ["src/auth/token.ts"]),
    reported(1, "adversary"),
  ], policy, now(2));
  assert.equal(lease.holder, "security");
});

test("rule 1: span events never move the lease", () => {
  // Transfer happens only at span boundaries, which the caller enforces by only
  // asking between spans. The lease itself must not react to a span at all.
  const withSpans = resolveLease([
    planned(0, ["src/api/users.ts"]),
    spanStart(1, "builder"), spanStart(2, "adversary"), spanStart(3, "security"),
  ], policy, now(4));
  const without = resolveLease([planned(0, ["src/api/users.ts"])], policy, now(4));
  assert.equal(withSpans.holder, without.holder);
  assert.equal(withSpans.acquired_at, without.acquired_at);
});

test("rule 5: a holder past its TTL is reclaimed, so a silent role cannot freeze a trace", () => {
  const events = [planned(0, ["src/auth/token.ts"])];
  const ttlMinutes = policy.runtime.lease_ttl_seconds / 60;

  const inTime = resolveLease(events, policy, now(ttlMinutes - 1));
  assert.equal(inTime.holder, "security");
  assert.equal(inTime.expired, false);

  const expired = resolveLease(events, policy, now(ttlMinutes + 1));
  assert.equal(expired.holder, "planner");
  assert.equal(expired.expired, true);
  assert.match(expired.reason, /ttl expired for security/);
});

test("the default owner never expires - there is nobody to hand it back to", () => {
  const lease = resolveLease([planned(0, ["src/plain.ts"])], policy, now(10_000));
  assert.equal(lease.holder, "planner");
  assert.equal(lease.expired, false);
});

// ---------------------------------------------------------------------------
// Properties. A seeded generator rather than a dependency: same seed, same run,
// and a failure is reproducible from the seed printed in the message.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_POOL = [
  ["src/auth/token.ts"], ["src/api/users.ts"], ["src/plain.ts"],
  ["db/2026_migration.sql"], ["README.md"], [],
];

function randomTrace(rand: () => number, length: number): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  for (let i = 0; i < length; i++) {
    const roll = rand();
    const paths = PATH_POOL[Math.floor(rand() * PATH_POOL.length)];
    const role = ROLES[Math.floor(rand() * ROLES.length)];
    if (roll < 0.3) events.push(planned(i, paths));
    else if (roll < 0.6) events.push(built(i, paths));
    else if (roll < 0.75) events.push(reported(i, role));
    else if (roll < 0.9) events.push(spanStart(i, role));
    else events.push({ ts: at(i), trace_id: "bk-1", type: "ci_result", ok: rand() > 0.5, summary: "x" });
  }
  return events;
}

/** Replays the fold step by step so a violation can be attributed to one event. */
function holderSequence(events: HarnessEvent[], policy: Policy, clock: number): Role[] {
  return events.map((_, i) => resolveLease(events.slice(0, i + 1), policy, clock).holder);
}

test("property: the lease is total, deterministic, and obeys rule 4 on every trace", () => {
  for (let seed = 0; seed < 300; seed++) {
    const rand = mulberry32(seed);
    const events = randomTrace(rand, 12);
    const clock = now(1000); // far enough ahead that TTL is not what is under test
    const withinTtl = now(0);

    const first = resolveLease(events, policy, withinTtl);
    const second = resolveLease(structuredClone(events), policy, withinTtl);
    assert.deepEqual(first, second, `seed ${seed}: not deterministic`);
    assert.ok(ROLES.includes(first.holder), `seed ${seed}: holder is not a role`);

    const sequence = holderSequence(events, policy, withinTtl);
    for (let i = 1; i < sequence.length; i++) {
      const [before, after] = [sequence[i - 1], sequence[i]];
      if (before === after || after === "planner") continue;
      assert.ok(
        policy.roles[after].preempt || before === "planner",
        `seed ${seed}: ${after} took the lease from ${before} without the right to`,
      );
    }

    // Past the TTL every non-default holder is gone, on every trace.
    assert.equal(resolveLease(events, policy, clock).holder, "planner", `seed ${seed}: TTL did not reclaim`);
  }
});

test("property: a trace of pure noise still leaves exactly one well-formed lease", () => {
  for (let seed = 0; seed < 100; seed++) {
    const events = randomTrace(mulberry32(seed + 5000), 40);
    const lease = resolveLease(events, policy, now(0));
    assert.ok(ROLES.includes(lease.holder));
    assert.ok(Date.parse(lease.acquired_at) > 0, `seed ${seed}: unparseable acquired_at`);
    assert.ok(lease.preempted_from === null || ROLES.includes(lease.preempted_from));
  }
});
