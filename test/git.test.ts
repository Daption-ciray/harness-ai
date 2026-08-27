import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, commitAll, untrackedFiles } from "../src/git.ts";

/** A throwaway git repo seeded from the toy fixture. No nested repo in-tree. */
function toyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-toy-"));
  cpSync(join(import.meta.dirname, "../fixtures/toy-repo"), dir, { recursive: true });
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "harness@example.test");
  run("config", "user.name", "harness test");
  run("add", "-A");
  run("commit", "-qm", "seed");
  return dir;
}

test("an unstaged modification keeps its full path", () => {
  // Regression: trimming the whole `git status --porcelain` output ate the
  // leading status space off the first line and shifted its path by one char,
  // so `bin/harness.ts` arrived as `in/harness.ts` and was dropped as
  // out-of-scope. It only ever corrupted the first line, which is why it looked
  // like a scope bug rather than a parsing one.
  const dir = toyRepo();
  writeFileSync(join(dir, "src/greet.js"), "export const greet = () => 'hi';\n");
  assert.deepEqual(changedFiles(dir), ["src/greet.js"]);
});

test("modified and untracked files parse together, in any order", () => {
  const dir = toyRepo();
  writeFileSync(join(dir, "src/greet.js"), "// changed\n");
  writeFileSync(join(dir, "aaa-new.js"), "// new\n");
  assert.deepEqual(changedFiles(dir).sort(), ["aaa-new.js", "src/greet.js"]);
  assert.deepEqual(untrackedFiles(dir), ["aaa-new.js"]);
});

test("a clean tree reports nothing", () => {
  assert.deepEqual(changedFiles(toyRepo()), []);
});

test("commitAll stages only the paths it is handed", () => {
  const dir = toyRepo();
  writeFileSync(join(dir, "src/greet.js"), "// wanted\n");
  writeFileSync(join(dir, "junk.txt"), "// not wanted\n");
  const sha = commitAll(dir, "test: partial stage", ["src/greet.js"]);
  assert.ok(sha);
  const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(committed, "src/greet.js");
  assert.deepEqual(changedFiles(dir), ["junk.txt"], "the unstaged file survives untouched");
});

test("commitAll with nothing to stage is a no-op, not an error", () => {
  assert.equal(commitAll(toyRepo(), "test: empty", []), null);
});
