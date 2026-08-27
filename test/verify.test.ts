import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Finding } from "../src/domain.ts";
import { findingKey } from "../src/domain.ts";
import type { HarnessEvent } from "../src/events.ts";
import { parsePolicy, type Role } from "../src/policy.ts";
import {
  concernsFor, currentRevision, detectStall, pendingVerifiers, requiredVerifiers,
} from "../src/verify.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
const AVAILABLE: Role[] = ["adversary", "review", "security"];
let clock = 0;
const ts = () => new Date((clock += 1000)).toISOString();

const blocker = (file: string, summary: string): Finding => ({ file, summary, severity: "blocker" });
const concern = (file: string, summary: string): Finding => ({ file, summary, severity: "concern" });

const build = (revision: number): HarnessEvent =>
  ({ ts: ts(), trace_id: "bk-1", type: "build_done", files: ["src/a.ts"], revision });
const veto = (role: Role, revision: number, findings: Finding[]): HarnessEvent =>
  ({ ts: ts(), trace_id: "bk-1", type: "veto", role, revision, kind: "soft", reason: findings[0]?.summary ?? "", findings });
const verdict = (role: Role, revision: number, findings: Finding[] = []): HarnessEvent =>
  ({ ts: ts(), trace_id: "bk-1", type: "verdict", role, revision, findings, note: "" });

test("adversary and review judge every revision", () => {
  assert.deepEqual(requiredVerifiers(policy, ["src/plain.ts"], AVAILABLE), ["adversary", "review"]);
});

test("routing is what brings security into a task at all", () => {
  assert.deepEqual(requiredVerifiers(policy, ["src/auth/token.ts"], AVAILABLE),
    ["adversary", "review", "security"]);
  assert.deepEqual(requiredVerifiers(policy, ["db/2026_migration.sql"], AVAILABLE),
    ["adversary", "review", "security"]);
});

test("a role policy routes to but the harness cannot run does not silently block a task", () => {
  assert.deepEqual(requiredVerifiers(policy, ["src/auth/token.ts"], ["adversary", "review"]),
    ["adversary", "review"]);
});

test("a routed verifier that already judges everything is not required twice", () => {
  assert.deepEqual(requiredVerifiers(policy, ["src/api/users.ts"], AVAILABLE), ["adversary", "review"]);
});

test("the lease orders the queue; it never removes anyone from it", () => {
  const events = [build(1)];
  const paths = ["src/auth/token.ts"];
  assert.deepEqual(pendingVerifiers(events, policy, paths, AVAILABLE, "security")[0], "security");
  assert.deepEqual(pendingVerifiers(events, policy, paths, AVAILABLE, "planner").sort(),
    ["adversary", "review", "security"]);
  assert.equal(pendingVerifiers(events, policy, paths, AVAILABLE, "planner").length, 3,
    "a lease held elsewhere still leaves every required verifier pending");
});

test("a verdict clears that verifier for this revision only", () => {
  const events = [build(1), verdict("adversary", 1)];
  assert.deepEqual(pendingVerifiers(events, policy, ["src/a.ts"], AVAILABLE, "planner"), ["review"]);

  const rebuilt = [...events, veto("review", 1, [blocker("src/a.ts", "wrong")]), build(2)];
  assert.equal(currentRevision(rebuilt), 2);
  assert.deepEqual(pendingVerifiers(rebuilt, policy, ["src/a.ts"], AVAILABLE, "planner").sort(),
    ["adversary", "review"], "a new revision has to be judged afresh");
});

test("max_rounds stops a role that has spent its allowance", () => {
  // review is allowed 2 rounds in the shipped policy.
  const two = [
    veto("review", 1, [blocker("a.ts", "first")]),
    veto("review", 2, [blocker("b.ts", "second")]),
  ];
  assert.equal(detectStall(two, policy), null);

  const three = [...two, veto("review", 3, [blocker("c.ts", "third")])];
  const stall = detectStall(three, policy);
  assert.equal(stall?.kind, "max_rounds");
  assert.equal(stall?.role, "review");
});

test("no_progress: the same blockers on consecutive revisions is not a round worth running", () => {
  const same = [
    veto("adversary", 1, [blocker("a.ts", "expired token returns 500")]),
    veto("adversary", 2, [blocker("a.ts", "expired token returns 500")]),
  ];
  const stall = detectStall(same, policy);
  assert.equal(stall?.kind, "no_progress");
  assert.match(stall?.detail ?? "", /revisions 1 and 2/);
});

test("no_progress sees through rewording, which is the point of a coarse key", () => {
  const reworded = [
    veto("adversary", 1, [blocker("a.ts", "Expired token returns 500!")]),
    veto("adversary", 2, [blocker("a.ts", "expired   token returns 500")]),
  ];
  assert.equal(detectStall(reworded, policy)?.kind, "no_progress");
  assert.equal(
    findingKey(blocker("a.ts", "Expired token returns 500!")),
    findingKey(blocker("a.ts", "expired   token returns 500")),
  );
});

test("genuine progress is not mistaken for a stall", () => {
  const progressing = [
    veto("adversary", 1, [blocker("a.ts", "expired token returns 500")]),
    veto("adversary", 2, [blocker("b.ts", "empty name crashes")]),
  ];
  assert.equal(detectStall(progressing, policy), null);
});

test("ping_pong: a blocker that cleared and came back means the two sides are undoing each other", () => {
  const pong = [
    veto("adversary", 1, [blocker("a.ts", "retry loop is unbounded")]),
    veto("adversary", 2, [blocker("b.ts", "something else entirely")]),
    veto("adversary", 3, [blocker("a.ts", "retry loop is unbounded")]),
  ];
  const stall = detectStall(pong, policy);
  assert.equal(stall?.kind, "ping_pong");
  assert.match(stall?.detail ?? "", /re-raised/);
});

test("concerns never stall anything - only blockers count", () => {
  const noisy = [
    veto("adversary", 1, [blocker("a.ts", "real problem"), concern("a.ts", "naming")]),
    veto("adversary", 2, [blocker("b.ts", "different problem"), concern("a.ts", "naming")]),
    veto("adversary", 3, [blocker("c.ts", "third problem"), concern("a.ts", "naming")]),
  ];
  // adversary is allowed 3 rounds, and the repeated concern is not a blocker.
  assert.equal(detectStall(noisy, policy), null);
});

test("one role's repetition is not held against another", () => {
  const mixed = [
    veto("adversary", 1, [blocker("a.ts", "same")]),
    veto("review", 2, [blocker("b.ts", "other")]),
    veto("adversary", 3, [blocker("a.ts", "same")]),
  ];
  const stall = detectStall(mixed, policy);
  assert.equal(stall?.role, "adversary", "adversary re-raised; review did nothing wrong");
});

test("concerns from every verifier on the current revision reach the pull request", () => {
  const events = [
    build(1),
    verdict("adversary", 1, [concern("a.ts", "no test for the empty case")]),
    veto("review", 1, [blocker("b.ts", "blocks"), concern("b.ts", "naming is off")]),
    verdict("review", 2, [concern("c.ts", "stale revision, must not appear")]),
  ];
  const concerns = concernsFor(events, 1);
  assert.equal(concerns.length, 2);
  assert.ok(concerns.some((c) => c.startsWith("adversary: a.ts")));
  assert.ok(concerns.some((c) => c.startsWith("review: b.ts")));
  assert.ok(!concerns.some((c) => c.includes("stale revision")));
});

test("revisions belong to a task, not to the log", () => {
  // Counted across every trace, the second task numbered its first build "2"
  // while the gate asked about "1" — so a verifier that had already reported
  // still looked pending, and the same one ran forever.
  const log: HarnessEvent[] = [
    { ts: ts(), trace_id: "bk-1", type: "build_done", files: ["a.ts"], revision: 1 },
    { ts: ts(), trace_id: "bk-2", type: "build_done", files: ["b.ts"], revision: 1 },
  ];
  assert.equal(currentRevision(log.filter((e) => e.trace_id === "bk-2")), 1);
  assert.equal(currentRevision(log), 2, "unfiltered, it counts the whole log — which is why callers must filter");
});
