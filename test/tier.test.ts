import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePolicy } from "../src/policy.ts";
import { classify, ladderStartFor, resolveTier } from "../src/tier.ts";
import { extractJson } from "../src/spawn.ts";
import { scopeViolations } from "../src/pipeline.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));

test("auth and crypto paths classify as risky", () => {
  assert.equal(classify(policy, { paths: ["src/auth/**"] }), "risky");
  assert.equal(classify(policy, { paths: ["lib/crypto/aes.ts"] }), "risky");
  assert.equal(classify(policy, { paths: ["db/2026_migration_users.sql"] }), "risky");
  assert.equal(classify(policy, { paths: ["package.json"] }), "risky");
  assert.equal(classify(policy, { paths: [".github/workflows/ci.yml"] }), "risky");
});

test("one risky path in a mixed scope makes the whole task risky", () => {
  assert.equal(classify(policy, { paths: ["README.md", "src/auth/token.ts"] }), "risky");
});

test("docs and tests within the file cap classify as trivial", () => {
  assert.equal(classify(policy, { paths: ["README.md"] }), "trivial");
  assert.equal(classify(policy, { paths: ["docs/a.md", "src/x.test.ts"] }), "trivial");
});

test("too many files stops a task being trivial", () => {
  assert.equal(classify(policy, { paths: ["a.md", "b.md", "c.md"] }), "routine");
});

test("anything unrecognised falls back to routine, never to trivial", () => {
  assert.equal(classify(policy, { paths: ["src/server.ts"] }), "routine");
  assert.equal(classify(policy, { paths: [] }), "routine");
});

test("a risky source classifies as risky whatever the paths say", () => {
  assert.equal(classify(policy, { paths: ["README.md"], source: "cve_scan" }), "risky");
});

test("risky work never starts on the cheap rung", () => {
  assert.equal(ladderStartFor(policy, "trivial"), 0);
  assert.equal(ladderStartFor(policy, "risky"), 1);
});

test("the ladder climbs model and effort on retry", () => {
  const first = resolveTier(policy, "builder", "routine", 0);
  const second = resolveTier(policy, "builder", "routine", 1);
  assert.equal(first.kind, "tier");
  assert.equal(second.kind, "tier");
  if (first.kind !== "tier" || second.kind !== "tier") return;
  assert.equal(first.tier.model, "claude-sonnet-5");
  assert.equal(second.tier.model, "claude-opus-5");
});

test("security keeps its model whatever the ladder or the class says", () => {
  for (const step of [0, 1, 2]) {
    const t = resolveTier(policy, "security", "trivial", step);
    assert.equal(t.kind, "tier");
    if (t.kind !== "tier") return;
    assert.equal(t.tier.model, "claude-opus-5");
    assert.equal(t.tier.effort, "xhigh");
  }
});

test("the last rung escalates to a human rather than looping", () => {
  assert.equal(resolveTier(policy, "builder", "routine", 3).kind, "escalate");
  assert.equal(resolveTier(policy, "builder", "routine", 99).kind, "escalate");
});

test("scope violations name every file the plan did not authorise", () => {
  assert.deepEqual(scopeViolations(["src/auth/a.ts", "src/other.ts"], ["src/auth/**"]), ["src/other.ts"]);
  assert.deepEqual(scopeViolations(["src/auth/a.ts"], ["src/auth/**"]), []);
  assert.deepEqual(scopeViolations(["README.md"], []), ["README.md"]);
});

test("extractJson survives prose around a fenced block", () => {
  assert.deepEqual(extractJson("Here is the plan.\n```json\n{\"a\":1}\n```\n"), { a: 1 });
  assert.deepEqual(extractJson("```\n{\"a\":2}\n```"), { a: 2 });
  assert.deepEqual(extractJson("no json at all"), null);
});
