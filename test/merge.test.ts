import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../src/events.ts";
import { detectPublicApiChange, evaluateGate, type MergeFacts } from "../src/merge.ts";
import { parsePolicy, PolicyError, type Policy } from "../src/policy.ts";
import type { Task } from "../src/projection.ts";

const TEMPLATE = readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8");
const shipped = parsePolicy(TEMPLATE);

/** The shipped policy with auto-merge on and only the named rules kept. */
function policyWith(rules: Policy["merge"]["escalate_when"]): Policy {
  return { ...shipped, merge: { ...shipped.merge, auto: true, escalate_when: rules } };
}

const task = (over: Partial<Task> = {}): Task => ({
  id: "bk-1", text: "t", origin: "trusted", source: "human", fingerprint: "f",
  state: "awaiting_merge", task_class: "routine", scope: ["src/**"],
  acceptance: ["test: npm test passes"], steps: [], branch: "b", worktree: "/w",
  setup_artifacts: [], pr: { number: 1, url: "u", draft: false }, quarantined: false,
  rounds: 0, revision: 1, ladder_step: 0, cost_usd: 1, spans: 6, exchanges: [],
  last_error: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:10:00.000Z",
  ...over,
});

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  files: ["src/a.ts"], diffLines: 20, mergesSoFar: 50, publicApiChange: false, ...over,
});

test("nothing merges itself while merge.auto is off", () => {
  const gate = evaluateGate(shipped, task(), [], facts());
  assert.equal(gate.escalate, true);
  assert.deepEqual(gate.reasons, ["merge.auto is off"]);
});

test("a change with no rule against it is clear to merge", () => {
  const gate = evaluateGate(policyWith([{ task_class: "risky" }]), task(), [], facts());
  assert.deepEqual(gate, { escalate: false, reasons: [] });
});

test("untrusted origin never merges itself, and that is the whole cut-off", () => {
  // Text written by a stranger must not reach the default branch unread. There
  // is no combination of other rules that lets this through.
  const gate = evaluateGate(policyWith([{ origin: "untrusted" }]), task({ origin: "untrusted" }), [], facts());
  assert.equal(gate.escalate, true);
  assert.match(gate.reasons[0], /origin is untrusted/);
});

test("autonomy is earned: the first N merges go to a person", () => {
  const rules = [{ first_n_merges: 20 }];
  assert.equal(evaluateGate(policyWith(rules), task(), [], facts({ mergesSoFar: 0 })).escalate, true);
  assert.equal(evaluateGate(policyWith(rules), task(), [], facts({ mergesSoFar: 19 })).escalate, true);
  assert.equal(evaluateGate(policyWith(rules), task(), [], facts({ mergesSoFar: 20 })).escalate, false);
});

test("a security finding sends it to a person even when security passed it", () => {
  const passedWithConcern: HarnessEvent[] = [{
    ts: "2026-01-01T00:05:00.000Z", trace_id: "bk-1", type: "verdict", role: "security",
    revision: 1, note: "", findings: [{ file: "a.ts", summary: "hardening opportunity", severity: "concern" }],
  }];
  const gate = evaluateGate(policyWith([{ security_finding: "any" }]), task(), passedWithConcern, facts());
  assert.equal(gate.escalate, true);
  assert.match(gate.reasons[0], /security raised a finding/);
});

test("a quarantined change never merges, whatever the rules say", () => {
  const gate = evaluateGate(policyWith([]), task({ quarantined: true }), [], facts());
  assert.equal(gate.escalate, true);
  assert.match(gate.reasons[0], /quarantined/);
});

test("size and path thresholds are compared, not guessed", () => {
  const big = evaluateGate(policyWith([{ diff_files: ">15" }]), task(),
    [], facts({ files: Array.from({ length: 16 }, (_, i) => `src/${i}.ts`) }));
  assert.equal(big.escalate, true);

  const small = evaluateGate(policyWith([{ diff_files: ">15" }]), task(), [], facts());
  assert.equal(small.escalate, false);

  const touched = evaluateGate(policyWith([{ path_touched: "SPEC.md|.harness/**" }]), task(),
    [], facts({ files: ["src/a.ts", ".harness/policy.yaml"] }));
  assert.equal(touched.escalate, true);
  assert.match(touched.reasons[0], /\.harness\/policy\.yaml/);
});

test("an argued-over change goes to a person", () => {
  const vetoed: HarnessEvent[] = [1, 2].map((r) => ({
    ts: `2026-01-01T00:0${r}:00.000Z`, trace_id: "bk-1", type: "veto", role: "review",
    revision: r, kind: "soft", reason: "x", findings: [{ file: "a.ts", summary: "x", severity: "blocker" }],
  }));
  assert.equal(evaluateGate(policyWith([{ review_rounds: ">=2" }]), task(), vetoed, facts()).escalate, true);
  assert.equal(evaluateGate(policyWith([{ review_rounds: ">=2" }]), task(), vetoed.slice(0, 1), facts()).escalate, false);
});

test("a threshold that cannot be read escalates rather than being skipped", () => {
  // Fail-closed: a rule the code cannot evaluate must never resolve to "safe".
  const gate = evaluateGate(policyWith([{ diff_files: "lots" }]), task(), [], facts());
  assert.equal(gate.escalate, true);
  assert.match(gate.reasons[0], /unreadable/);
});

test("a task with no acceptance criteria has nothing to have been checked against", () => {
  const gate = evaluateGate(policyWith([{ acceptance_unmet: "any" }]), task({ acceptance: [] }), [], facts());
  assert.equal(gate.escalate, true);
});

test("every matching rule is reported, not just the first", () => {
  const gate = evaluateGate(
    policyWith([{ origin: "untrusted" }, { task_class: "risky" }, { first_n_merges: 20 }]),
    task({ origin: "untrusted", task_class: "risky" }), [], facts({ mergesSoFar: 1 }),
  );
  assert.equal(gate.reasons.length, 3, "a person should see all of it, not one reason at a time");
});

test("a misspelled escalation rule breaks policy loading instead of vanishing", () => {
  // Zod strips unknown keys by default, which would silently delete the rule —
  // and a deleted escalation rule auto-merges exactly the case it was written
  // to catch. This must fail loudly, at startup.
  const typo = TEMPLATE.replace("- task_class: risky", "- task_clss: risky");
  assert.throws(() => parsePolicy(typo), PolicyError);

  const empty = TEMPLATE.replace("- task_class: risky", "- {}");
  assert.throws(() => parsePolicy(empty), PolicyError);
});

test("the shipped policy escalates untrusted work and holds the first 20 merges", () => {
  const rules = shipped.merge.escalate_when;
  assert.ok(rules.some((r) => r.origin === "untrusted"));
  assert.ok(rules.some((r) => r.first_n_merges === 20));
  assert.equal(shipped.merge.auto, false, "and it ships off");
});

test("a removed export is a public API change; an added one is not", () => {
  assert.equal(detectPublicApiChange("-export function greet(name) {\n+export function greet(name, loud) {"), true);
  assert.equal(detectPublicApiChange("+export function added() {}"), false);
  assert.equal(detectPublicApiChange("--- a/src/x.ts\n+++ b/src/x.ts\n-const internal = 1;"), false);
  assert.equal(detectPublicApiChange("-pub fn open() {}"), true);
});
