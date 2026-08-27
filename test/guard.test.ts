import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePolicy, ROLES } from "../src/policy.ts";
import { screenCommand } from "../src/permissions.ts";
import { ROLE_TOOLS } from "../src/roles/tools.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
const deny = (role: string, command: string) =>
  screenCommand(policy, role as Parameters<typeof screenCommand>[1], command);

test("devops is the only role allowed to run git or gh", () => {
  for (const role of ROLES) {
    const blocked = deny(role, "git commit -m x") !== null;
    assert.equal(blocked, role !== "devops", `${role} git`);
  }
});

test("the word git inside an argument is text, not a command", () => {
  // A real verifier lost a turn to `grep -rn "not a git repository" .` being
  // read as running git. A guard that blocks honest work teaches agents to
  // route around it, which is worse than the guard not existing.
  for (const cmd of [
    'grep -rn "not a git repository" /path',
    'echo "use git to clone this"',
    "cat gitignore.md",
    "npm test", "node --test", "echo github", "ls .github", "cat digit.txt",
    "rg --files-with-matches 'gh pr create'",
  ]) {
    assert.equal(deny("builder", cmd), null, cmd);
  }
});

test("command position is what counts, wherever the shell would find it", () => {
  for (const cmd of [
    "git push",
    "cd /tmp && git push",
    "echo hi; gh pr merge 3",
    "true || git reset --hard",
    'echo "$(git log)"',
    "x=`git rev-parse HEAD`",
    "sudo git push",
    "FOO=1 git push",
    "/usr/bin/git push",
    "ls | xargs gh issue create",
    "( git status )",
    "git status > out.txt",
  ]) {
    assert.notEqual(deny("builder", cmd), null, cmd);
  }
});

test("commandHeads reports what a line would actually run", async () => {
  const { commandHeads } = await import("../src/permissions.ts");
  assert.deepEqual(commandHeads("npm test"), ["npm"]);
  assert.deepEqual(commandHeads("cd /tmp && git push"), ["cd", "git"]);
  assert.deepEqual(commandHeads('echo "$(git log)"').sort(), ["echo", "git"]);
  assert.deepEqual(commandHeads(""), []);
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
