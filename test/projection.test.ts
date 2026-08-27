import assert from "node:assert/strict";
import { test } from "node:test";
import { emit, readAll, type HarnessEvent } from "../src/events.ts";
import { apply, listTasks, nextTaskId, project, projectOne, spendSince } from "../src/projection.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./helpers.ts";

let clock = 0;
function ev<T extends HarnessEvent["type"]>(
  trace_id: string, type: T, fields: Omit<Extract<HarnessEvent, { type: T }>, "ts" | "trace_id" | "type">,
): HarnessEvent {
  clock += 1000;
  return { ts: new Date(clock).toISOString(), trace_id, type, ...fields } as HarnessEvent;
}

const span = (role: "planner" | "builder" | "devops", cost: number, ok = true) =>
  ({
    span_id: "s1", role, model: "m", effort: "high" as const, ladder_step: 0,
    cost_usd: cost, session_id: "sess", ok, subtype: ok ? "success" : "error_during_execution",
    num_turns: 1, denials: 0, error: ok ? null : "boom", model_usage: {},
  });

const happyPath = (): HarnessEvent[] => [
  ev("bk-1", "backlog_add", { text: "do a thing", origin: "trusted", source: "human" }),
  ev("bk-1", "span_end", span("planner", 0.2)),
  ev("bk-1", "task_planned", {
    role: "planner", task_class: "routine", scope: ["src/**"],
    acceptance: ["test passes"], steps: ["step"], ladder_step: 0,
  }),
  ev("bk-1", "worktree_open", { branch: "harness/bk-1", dir: "/w/bk-1", setup_artifacts: ["node_modules"], setup_error: null }),
  ev("bk-1", "span_end", span("builder", 0.9)),
  ev("bk-1", "build_done", { files: ["src/a.ts"], revision: 1 }),
  ev("bk-1", "span_end", span("devops", 0.2)),
  ev("bk-1", "pr_opened", { number: 7, url: "https://x/7", draft: false, sha: "abc", files: 1, lines: 10 }),
  ev("bk-1", "escalate", { reason: "merge.auto is off" }),
];

test("state is a fold of the log, never stored", () => {
  const t = projectOne(happyPath(), "bk-1");
  assert.ok(t);
  assert.equal(t.state, "escalated");
  assert.equal(t.task_class, "routine");
  assert.deepEqual(t.scope, ["src/**"]);
  assert.equal(t.branch, "harness/bk-1");
  assert.deepEqual(t.setup_artifacts, ["node_modules"]);
  assert.deepEqual(t.pr, { number: 7, url: "https://x/7", draft: false });
  assert.equal(t.spans, 3);
  assert.equal(t.cost_usd, 1.3, "cost sums across every span, including subagent-inclusive totals");
});

test("truncating the log at any point yields the state that prefix describes", () => {
  const log = happyPath();
  const expected = ["queued", "queued", "planned", "planned", "planned", "verifying", "verifying", "escalated", "escalated"];
  for (let i = 0; i < log.length; i++) {
    assert.equal(projectOne(log.slice(0, i + 1), "bk-1")?.state, expected[i], `prefix of length ${i + 1}`);
  }
});

test("folding the same log twice is deterministic - what recovery relies on", () => {
  // The fold accumulates (cost, spans, rounds) so it is not idempotent under a
  // duplicated log, and it does not need to be: recovery re-reads one log and
  // folds it once. At-most-once for the *effectful* steps comes from the forge
  // and worktree being idempotent, not from the fold.
  const log = happyPath();
  assert.deepEqual(projectOne(log, "bk-1"), projectOne(structuredClone(log), "bk-1"));
});

test("cost is exactly the sum of span costs, whatever else the log contains", () => {
  const log = happyPath();
  const fromSpans = log
    .filter((e) => e.type === "span_end")
    .reduce((n, e) => n + (e as Extract<HarnessEvent, { type: "span_end" }>).cost_usd, 0);
  assert.equal(projectOne(log, "bk-1")?.cost_usd, Math.round(fromSpans * 1e6) / 1e6);
});

test("a duplicated backlog_add does not reset a task in flight", () => {
  const log = happyPath();
  const replayed = [...log, log[0]];
  assert.equal(projectOne(replayed, "bk-1")?.state, "escalated");
});

test("traces are isolated - a failure on one task leaves the other alone", () => {
  const log = [
    ...happyPath(),
    ev("bk-2", "backlog_add", { text: "other", origin: "untrusted", source: "open_issues" }),
    ev("bk-2", "task_failed", { reason: "underspecified" }),
  ];
  const tasks = project(log);
  assert.equal(tasks.get("bk-1")?.state, "escalated");
  assert.equal(tasks.get("bk-2")?.state, "failed");
  assert.equal(tasks.get("bk-2")?.origin, "untrusted");
});

test("an event for a trace that was never opened is ignored, not fatal", () => {
  const orphan = [ev("bk-99", "build_done", { files: ["x"], revision: 1 })];
  assert.equal(project(orphan).size, 0);
});

test("failed builder spans count rounds; successful ones clear the error", () => {
  const log = [
    ev("bk-1", "backlog_add", { text: "t", origin: "trusted", source: "human" }),
    ev("bk-1", "span_end", span("builder", 0.1, false)),
    ev("bk-1", "ladder_advanced", { from: 0, to: 1, reason: "boom" }),
    ev("bk-1", "span_end", span("builder", 0.1, false)),
    ev("bk-1", "span_end", span("builder", 0.1, true)),
  ];
  const t = projectOne(log, "bk-1");
  assert.equal(t?.rounds, 2);
  assert.equal(t?.ladder_step, 1);
  // A successful span does not clear the error: the stage is not done yet.
  // `build_done` and `task_planned` are what clear it, because they are the
  // events that mean the stage actually finished.
  assert.equal(t?.last_error, "boom");
  const cleared = projectOne([...log, ev("bk-1", "build_done", { files: ["a"], revision: 1 })], "bk-1");
  assert.equal(cleared?.last_error, null);
});

test("apply is pure - the input task is never mutated", () => {
  const before = projectOne(happyPath().slice(0, 1), "bk-1");
  assert.ok(before);
  const snapshot = structuredClone(before);
  apply(before, ev("bk-1", "build_done", { files: ["a"], revision: 1 }));
  assert.deepEqual(before, snapshot);
});

test("ids come from the log's high-water mark, so a gap is never reused", () => {
  assert.equal(nextTaskId([]), "bk-1");
  const log = [
    ev("bk-1", "backlog_add", { text: "a", origin: "trusted", source: "human" }),
    ev("bk-7", "backlog_add", { text: "b", origin: "trusted", source: "human" }),
  ];
  assert.equal(nextTaskId(log), "bk-8");
});

test("listTasks orders by creation, stably", () => {
  const log = [
    ev("bk-2", "backlog_add", { text: "second", origin: "trusted", source: "human" }),
    ev("bk-1", "backlog_add", { text: "first", origin: "trusted", source: "human" }),
  ];
  assert.deepEqual(listTasks(log).map((t) => t.id), ["bk-2", "bk-1"], "log order is creation order");
});

test("daily spend counts only spans inside the window", () => {
  const log = happyPath();
  const cutoff = log[4].ts; // the builder span
  assert.equal(spendSince(log, cutoff), 1.1, "builder + devops, not the planner");
  assert.equal(spendSince(log, "2999-01-01T00:00:00.000Z"), 0);
});

test("a partial final line from a killed process is skipped, not fatal", () => {
  const file = join(scratch(), "events.jsonl");
  emit(file, "bk-1", "backlog_add", { text: "t", origin: "trusted", source: "human" });
  emit(file, "bk-1", "build_done", { files: ["a"], revision: 1 });
  appendFileSync(file, '{"ts":"2026-01-01T00:00:00.000Z","trace_i');
  const events = readAll(file);
  assert.equal(events.length, 2);
  assert.equal(projectOne(events, "bk-1")?.state, "verifying");
});
