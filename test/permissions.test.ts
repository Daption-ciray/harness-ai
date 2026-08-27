import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  denyRules, expandHome, isWithin, realResolve, sandboxSettings,
  screenCommand, screenRead, screenTool, screenWrite, type Guard,
} from "../src/permissions.ts";
import { parsePolicy, ROLES, type Policy } from "../src/policy.ts";
import { scratch } from "./helpers.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));

function guardIn(overrides: Partial<Guard> = {}, p: Policy = policy): Guard & { worktree: string; repo: string } {
  const base = scratch("harness-perm-");
  const worktree = join(base, "worktree");
  const repo = join(base, "repo");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return {
    role: "builder", policy: p, cwd: worktree,
    roots: { write: [worktree], read: [worktree, repo] },
    worktree, repo, ...overrides,
  };
}

test("a write inside the working tree is allowed", () => {
  const g = guardIn();
  assert.equal(screenWrite(g, "src/a.ts"), null);
  assert.equal(screenWrite(g, join(g.worktree, "deep/b.ts")), null);
});

test("a write outside the working tree is denied, however it is spelled", () => {
  const g = guardIn();
  for (const path of ["../escape.txt", "../../escape.txt", "/tmp/escape.txt", join(homedir(), ".bashrc")]) {
    assert.match(screenWrite(g, path) ?? "", /outside the working tree/, path);
  }
});

test("a symlink planted inside the tree does not become a way out of it", () => {
  // A purely textual check passes this and then writes exactly where it was
  // told not to, which is why the path is resolved the way the filesystem will.
  const g = guardIn();
  const outside = scratch("harness-outside-");
  symlinkSync(outside, join(g.worktree, "escape"));
  assert.match(screenWrite(g, "escape/evil.txt") ?? "", /outside the working tree/);
  assert.match(screenWrite(g, "escape/nested/deeper/evil.txt") ?? "", /outside the working tree/);
});

test("the main checkout is readable but never writable", () => {
  // A worktree's dependency directory is a symlink into the main checkout, so
  // the builder must read there — but that tree is what every task branches
  // from, and writing to it would corrupt work the builder never saw.
  const g = guardIn();
  assert.equal(screenRead(g, join(g.repo, "package.json")), null);
  assert.match(screenWrite(g, join(g.repo, "package.json")) ?? "", /outside the working tree/);
});

test("never_edit holds even inside the working tree", () => {
  const g = guardIn();
  assert.match(screenWrite(g, ".harness/policy.yaml") ?? "", /never_edit/);
  assert.match(screenWrite(g, ".github/workflows/ci.yml") ?? "", /never_edit/);
  assert.equal(screenWrite(g, ".github/CODEOWNERS"), null, "only the workflows are protected");
});

test("the harness cannot loosen its own guardrails", () => {
  const g = guardIn();
  for (const role of ROLES) {
    assert.notEqual(screenWrite({ ...g, role }, ".harness/policy.yaml"), null, role);
  }
});

test("credentials are unreadable, including the ones that pay for the run", () => {
  const g = guardIn();
  for (const path of [
    join(homedir(), ".ssh/id_ed25519"),
    join(homedir(), ".aws/credentials"),
    join(homedir(), ".config/anthropic/profiles.json"),
    join(homedir(), ".claude/settings.json"),
  ]) {
    assert.match(screenRead(g, path) ?? "", /never_read/, path);
  }
});

test("a .env anywhere in the tree is unreadable", () => {
  const g = guardIn();
  assert.match(screenRead(g, join(g.worktree, ".env")) ?? "", /never_read/);
  assert.match(screenRead(g, join(g.worktree, "packages/api/.env.production")) ?? "", /never_read/);
  assert.equal(screenRead(g, join(g.worktree, "env.ts")), null);
});

test("screenTool routes each tool to the check that fits it", () => {
  const g = guardIn();
  assert.match(screenTool(g, "Bash", { command: "git push" }) ?? "", /may not run git/);
  assert.match(screenTool(g, "Write", { file_path: "/etc/passwd" }) ?? "", /outside the working tree/);
  assert.match(screenTool(g, "Edit", { file_path: ".harness/policy.yaml" }) ?? "", /never_edit/);
  assert.match(screenTool(g, "Read", { file_path: join(homedir(), ".ssh/id_rsa") }) ?? "", /never_read/);
  assert.equal(screenTool(g, "Write", { file_path: "src/ok.ts" }), null);
  assert.equal(screenTool(g, "TodoWrite", { todos: [] }), null, "a tool with no path is not our business");
});

test("deny rules use Edit(), because a Write() rule is never matched", () => {
  // `Edit(path)` governs every built-in tool that writes files, `Write` and
  // `NotebookEdit` included. A `Write(...)` rule would look protective and do
  // nothing at all.
  const rules = denyRules(guardIn());
  assert.ok(rules.some((r) => r.startsWith("Edit(//")), "writes are denied through Edit()");
  assert.ok(!rules.some((r) => r.startsWith("Write(")), "a Write() rule protects nothing");
  assert.ok(rules.some((r) => r.startsWith("Read(//")));
  assert.ok(rules.every((r) => /\((\/\/)/.test(r)), "every rule is anchored at the filesystem root");
});

test("the sandbox is configured against its own defaults where they are unsafe here", () => {
  const settings = sandboxSettings(guardIn()) as Record<string, unknown>;
  assert.equal(settings.enabled, true);
  // Default true, and it must stay true: an unattended daemon must never fall
  // back to running unsandboxed with a warning nobody is reading.
  assert.equal(settings.failIfUnavailable, true);
  // Default TRUE, and wrong here: it lets the model set dangerouslyDisableSandbox
  // on a tool call and step straight out of the boundary.
  assert.equal(settings.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.excludedCommands, [], "nothing bypasses the sandbox");

  const network = settings.network as Record<string, unknown>;
  assert.equal(network.strictAllowlist, true, "outside the allowlist is denied, not prompted");
  assert.deepEqual(network.allowedDomains, policy.permissions.network_allowlist);
  assert.deepEqual(network.allowUnixSockets, [], "a unix socket can be a way onto the host");
  assert.equal(network.allowLocalBinding, false);
});

test("the sandbox write scope is the worktree, not the checkout it branches from", () => {
  const g = guardIn();
  const fs = (sandboxSettings(g) as { filesystem: Record<string, string[]> }).filesystem;
  // Canonical paths: the OS enforces against what the filesystem resolves to,
  // so handing it an unresolved spelling would describe a different directory.
  assert.deepEqual(fs.allowWrite, [realResolve(g.worktree, g.worktree)]);
  assert.ok(fs.allowRead.includes(realResolve(g.repo, g.repo)));
  assert.ok(!fs.allowWrite.includes(realResolve(g.repo, g.repo)), "the checkout stays read-only");
  assert.ok(fs.denyRead.some((p) => p.includes(".ssh")));
  assert.ok(fs.denyWrite.some((p) => p.includes(".harness")));
});

test("sandbox: none is an explicit opt-out, not a silent one", () => {
  const off = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
  off.runtime.sandbox = "none";
  assert.equal(sandboxSettings(guardIn({}, off)), undefined);
});

test("path helpers behave at their edges", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false, "a prefix match is not containment");
  assert.equal(isWithin("/a/b", "/a"), false);
  assert.equal(expandHome("~/x"), join(homedir(), "x"));
  assert.equal(expandHome("/x"), "/x");

  const dir = scratch();
  writeFileSync(join(dir, "real.txt"), "");
  assert.equal(realResolve(dir, "real.txt"), realResolve(dir, "./real.txt"));
  assert.equal(realResolve(dir, "nope/deeper/x.txt").endsWith("nope/deeper/x.txt"), true,
    "a path that does not exist yet still resolves");
});

test("git and gh stay closed to every role but devops", () => {
  for (const role of ROLES) {
    const blocked = screenCommand(policy, role, "git commit -m x") !== null;
    assert.equal(blocked, role !== "devops", role);
  }
});

test("a tilde in a tool input is expanded on the target, not only in the pattern", () => {
  // `~/.ssh/id_rsa` would otherwise resolve under the working directory and
  // sail past a rule written against the home directory.
  const g = guardIn();
  assert.match(screenRead(g, "~/.ssh/id_rsa") ?? "", /never_read/);
  assert.match(screenWrite(g, "~/evil.txt") ?? "", /outside the working tree/);
});
