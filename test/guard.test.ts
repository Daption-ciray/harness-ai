import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePolicy, ROLES } from "../src/policy.ts";
import { bashCommandDenial } from "../src/permissions.ts";
import { ROLE_TOOLS } from "../src/roles/tools.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
const deny = (role: string, command: string) =>
  bashCommandDenial({ role, policy } as Parameters<typeof bashCommandDenial>[0], command);

test("devops is the only role allowed to run git or gh", () => {
  for (const role of ROLES) {
    const blocked = deny(role, "git commit -m x") !== null;
    assert.equal(blocked, role !== "devops", `${role} git`);
  }
});

test("git hidden behind a separator or a subshell is still caught", () => {
  for (const cmd of [
    "cd /tmp && git push",
    "echo hi; gh pr merge 3",
    "true || git reset --hard",
    "$(git rev-parse HEAD)",
    "`git log`",
  ]) {
    assert.notEqual(deny("builder", cmd), null, cmd);
  }
});

test("ordinary commands and lookalike words are left alone", () => {
  for (const cmd of ["npm test", "node --test", "echo github", "ls .github", "cat digit.txt"]) {
    assert.equal(deny("builder", cmd), null, cmd);
  }
});

test("recursive force delete is denied for every role, devops included", () => {
  for (const role of ROLES) {
    assert.notEqual(deny(role, "rm -rf /tmp/x"), null, role);
    assert.notEqual(deny(role, "rm -fr build"), null, role);
  }
});

test("restriction comes from the deny list, because allowedTools does not restrict", () => {
  // A bare allowedTools entry auto-approves a tool; it never removes one. Any
  // role that must not edit or shell out has to say so in `deny`.
  for (const role of ["planner", "review", "devops", "security", "scribe"] as const) {
    const policy = ROLE_TOOLS[role];
    for (const tool of ["Write", "Edit", "Bash"]) {
      assert.ok(policy.deny.includes(tool), `${role} must deny ${tool}`);
    }
  }
});

test("builder is the only role that can write code", () => {
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.ok(!ROLE_TOOLS.builder.deny.includes(tool), `builder needs ${tool}`);
  }
});

test("the pure-judgement roles get no tools at all", () => {
  for (const role of ["review", "devops"] as const) {
    assert.deepEqual(ROLE_TOOLS[role].allow, []);
    for (const tool of ["Read", "Glob", "Grep"]) {
      assert.ok(ROLE_TOOLS[role].deny.includes(tool), `${role} must deny ${tool}`);
    }
  }
});

test("no role may spawn its own subagents - the harness owns the graph", () => {
  for (const role of ROLES) {
    assert.ok(ROLE_TOOLS[role].deny.includes("Agent"), `${role} must deny Agent`);
  }
});
