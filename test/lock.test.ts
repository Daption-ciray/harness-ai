import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acquire, LockBusy, lockHolder, withLock } from "../src/lock.ts";
import { scratch } from "./helpers.ts";

test("a second acquire is refused while the first is held", () => {
  const file = join(scratch(), "lock.json");
  const release = acquire(file, "first");
  assert.throws(() => acquire(file, "second"), LockBusy);
  release();
  acquire(file, "second")(); // free again
});

test("a lock left by a dead process is stolen, not waited on", () => {
  // A daemon killed with SIGKILL must not wedge the repository forever.
  const file = join(scratch(), "lock.json");
  writeFileSync(file, JSON.stringify({ pid: 999999, owner: "ghost", at: new Date().toISOString() }));
  assert.equal(lockHolder(file), null, "a dead holder does not count as holding it");
  const release = acquire(file, "live");
  assert.equal(lockHolder(file)?.owner, "live");
  release();
});

test("release only ever removes our own lock", () => {
  const file = join(scratch(), "lock.json");
  const release = acquire(file, "mine");
  // Somebody else's lock replaces ours; releasing must not hand out a second copy.
  writeFileSync(file, JSON.stringify({ pid: 999999, owner: "theirs", at: new Date().toISOString() }));
  release();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).owner, "theirs");
});

test("withLock releases even when the body throws", async () => {
  const file = join(scratch(), "lock.json");
  await assert.rejects(withLock(file, "body", async () => { throw new Error("boom"); }), /boom/);
  acquire(file, "after")();
});

test("the busy error names who holds it, so the user is not left guessing", () => {
  const file = join(scratch(), "lock.json");
  acquire(file, "harness daemon");
  try {
    acquire(file, "harness run");
    assert.fail("expected LockBusy");
  } catch (e) {
    assert.ok(e instanceof LockBusy);
    assert.match(e.message, /harness daemon/);
    assert.equal(e.holder.pid, process.pid);
  }
});
