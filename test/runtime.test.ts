import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { append, readAll, readTrace } from "../src/events.ts";
import { isAlive, readState, writeState } from "../src/daemon.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "harness-test-"));
}

test("events round-trip through JSONL", () => {
  const file = join(scratch(), "nested", "events.jsonl");
  append(file, { trace_id: "bk-1", type: "span_start", role: "builder" });
  append(file, { trace_id: "bk-2", type: "veto", role: "security", outcome: "hard" });
  const all = readAll(file);
  assert.equal(all.length, 2);
  assert.equal(all[0].role, "builder");
  assert.ok(Date.parse(all[0].ts) > 0, "every event carries a parseable timestamp");
});

test("readTrace isolates one trace - a finding on A must not surface under B", () => {
  const file = join(scratch(), "events.jsonl");
  append(file, { trace_id: "bk-1", type: "span_start" });
  append(file, { trace_id: "bk-2", type: "span_start" });
  append(file, { trace_id: "bk-1", type: "span_end" });
  assert.deepEqual(readTrace(file, "bk-1").map((e) => e.type), ["span_start", "span_end"]);
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
  const dir = scratch();
  const file = join(dir, "state.json");
  writeState(file, { status: "running", pid: 1 });
  writeFileSync(file, "{not json", "utf8");
  assert.equal(readState(file).status, "stopped");
});

test("a stale pid does not read as a live daemon", () => {
  assert.equal(isAlive({ status: "running", pid: 999999, started_at: null, last_tick: null, tick_count: 0 }), false);
  assert.equal(isAlive({ status: "running", pid: process.pid, started_at: null, last_tick: null, tick_count: 0 }), true);
  assert.equal(isAlive({ status: "stopped", pid: process.pid, started_at: null, last_tick: null, tick_count: 0 }), false);
});
