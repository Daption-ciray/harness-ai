import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePolicy, ROLES } from "../src/policy.ts";
import { bashCommandDenial } from "../src/permissions.ts";

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
