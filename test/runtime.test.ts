import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { emit, isType, readAll, readTrace } from "../src/events.ts";
import { isAlive, readState, writeState } from "../src/daemon.ts";
import { scratch } from "./helpers.ts";

test("events round-trip through JSONL with their fields intact", () => {
  const file = join(scratch(), "nested", "events.jsonl");
  emit(file, "bk-1", "span_start", {
    span_id: "s1", role: "builder", model: "m", effort: "high", ladder_step: 0,
  });
  emit(file, "bk-2", "veto", {
    role: "security", revision: 1, kind: "hard",
    reason: "secret in diff", findings: [{ file: "src/a.ts", summary: "api key", severity: "blocker" }],
  });

  const all = readAll(file);
  assert.equal(all.length, 2);
  assert.ok(isType(all[0], "span_start") && all[0].role === "builder");
  assert.ok(isType(all[1], "veto") && all[1].kind === "hard");
  assert.ok(Date.parse(all[0].ts) > 0, "every event carries a parseable timestamp");
});

test("readTrace isolates one trace - a finding on A must not surface under B", () => {
  const file = join(scratch(), "events.jsonl");
  emit(file, "bk-1", "escalate", { reason: "one" });
  emit(file, "bk-2", "escalate", { reason: "two" });
  emit(file, "bk-1", "task_failed", { reason: "three" });
  assert.deepEqual(readTrace(file, "bk-1").map((e) => e.type), ["escalate", "task_failed"]);
});

test("a missing event log reads as empty, not as a crash", () => {
  assert.deepEqual(readAll(join(scratch(), "absent.jsonl")), []);
});

test("state defaults to stopped and survives a partial patch", () => {
  const file = join(scratch(), "state.json");
  assert.equal(readState(file).status, "stopped");
  writeState(file, { status: "running", pid: 4242 });
  writeState(file, { tick_count: 7 });
  const s = readState(file);
  assert.equal(s.status, "running");
  assert.equal(s.pid, 4242);
  assert.equal(s.tick_count, 7);
});

test("a corrupt state file degrades to stopped instead of throwing", () => {
  const file = join(scratch(), "state.json");
  writeState(file, { status: "running", pid: 1 });
  writeFileSync(file, "{not json", "utf8");
  assert.equal(readState(file).status, "stopped");
});

test("a stale pid does not read as a live daemon", () => {
  const base = { started_at: null, last_tick: null, tick_count: 0 };
  assert.equal(isAlive({ ...base, status: "running", pid: 999999 }), false);
  assert.equal(isAlive({ ...base, status: "running", pid: process.pid }), true);
  assert.equal(isAlive({ ...base, status: "stopped", pid: process.pid }), false);
});
