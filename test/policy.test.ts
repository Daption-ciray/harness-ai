import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePolicy, PolicyError, preemptingRoles, ROLES } from "../src/policy.ts";

const TEMPLATE = readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8");

test("the shipped default policy validates", () => {
  const p = parsePolicy(TEMPLATE);
  assert.equal(Object.keys(p.roles).length, ROLES.length);
  assert.equal(p.version, 1);
});

test("security is the only role that preempts", () => {
  assert.deepEqual(preemptingRoles(parsePolicy(TEMPLATE)), ["security"]);
});

test("routing ends in a default rule, so resolveOwner always has a fallback", () => {
  const p = parsePolicy(TEMPLATE);
  assert.equal(p.routing.filter((r) => r.default).length, 1);
  assert.equal(p.routing.at(-1)?.default, true);
});

test("auto-merge ships off - phase 7 turns it on deliberately", () => {
  assert.equal(parsePolicy(TEMPLATE).merge.auto, false);
});

test("untrusted origin is an escalation trigger - the prompt-injection cut-off", () => {
  const rules = parsePolicy(TEMPLATE).merge.escalate_when;
  assert.ok(rules.some((r) => r.origin === "untrusted"));
});

test("only devops may touch git, and policy.yaml is off-limits to every role", () => {
  const perms = parsePolicy(TEMPLATE).permissions;
  assert.deepEqual(perms.git_allowed_for, ["devops"]);
  assert.ok(perms.deny_all_roles.includes("Bash(git *)"));
  assert.ok(perms.never_edit.includes(".harness/**"), "the whole harness directory, not just the policy file");
  assert.ok(perms.never_read.some((p) => p.includes(".ssh")), "credentials are unreadable");
  assert.equal(parsePolicy(TEMPLATE).runtime.sandbox, "os", "the OS sandbox is on by default");
});

test("invalid YAML reports as a policy error, not a crash", () => {
  assert.throws(() => parsePolicy("version: 1\n  bad: [indent"), PolicyError);
});

test("a schema violation names the offending path", () => {
  const broken = TEMPLATE.replace("effort: xhigh,  maxTurns: 40", "effort: turbo,  maxTurns: 40");
  assert.throws(
    () => parsePolicy(broken),
    (e: unknown) => e instanceof PolicyError && /roles\.builder\.effort/.test((e as Error).message),
  );
});

test("a missing required section is rejected rather than defaulted", () => {
  const broken = TEMPLATE.replace(/^budget:$/m, "budget_typo:");
  assert.throws(() => parsePolicy(broken), PolicyError);
});

test("an additive section keeps older policy files loading", () => {
  // A schema change that invalidates every deployed config is a migration.
  // Adding a field with defaults must never be one.
  const withoutMemory = TEMPLATE.replace(/^memory:[\s\S]*?\n\nsensors:/m, "sensors:");
  assert.ok(!withoutMemory.includes("context_budget_chars"));
  const policy = parsePolicy(withoutMemory);
  assert.equal(policy.memory.context_budget_chars, 8000);
  assert.equal(policy.memory.pitfall_threshold, 3);
});

test("the planner is told that scope must cover where tests live", async () => {
  // The builder is instructed to write tests. A planner that scopes only source
  // files describes a change that cannot land whole.
  const { PLANNER, BUILDER } = await import("../src/roles/prompts.ts");
  // Whitespace-normalised: the assertion is about what the prompt says, not
  // about where the paragraph happens to wrap.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  assert.match(flat(BUILDER), /Write the unit tests for your own change/);
  assert.match(flat(PLANNER), /MUST include wherever the tests for this change will live/);
});
