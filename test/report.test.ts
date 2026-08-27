import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessEvent } from "../src/events.ts";
import { parsePolicy } from "../src/policy.ts";
import { buildStats, buildTrace } from "../src/report.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
let clock = Date.parse("2026-04-01T09:00:00.000Z");
const at = (seconds: number) => new Date(clock + seconds * 1000).toISOString();

function span(id: string, role: string, from: number, to: number, cost: number, over: Record<string, unknown> = {}) {
  return [
    { ts: at(from), trace_id: "bk-1", type: "span_start", span_id: id, role, model: "claude-sonnet-5", effort: "medium", ladder_step: 0 },
    {
      ts: at(to), trace_id: "bk-1", type: "span_end", span_id: id, role, model: "claude-sonnet-5",
      effort: "medium", ladder_step: 0, cost_usd: cost, session_id: `s-${id}`, ok: true,
      subtype: "success", num_turns: 2, denials: 0, error: null, model_usage: {},
      cache_read_tokens: 9000, cache_creation_tokens: 1000, ...over,
    },
  ] as HarnessEvent[];
}

const RUN: HarnessEvent[] = [
  { ts: at(0), trace_id: "bk-1", type: "backlog_add", text: "add a flag", origin: "trusted", source: "human", fingerprint: "human:bk-1" },
  ...span("a", "planner", 1, 20, 0.2),
  { ts: at(20), trace_id: "bk-1", type: "task_planned", role: "planner", task_class: "routine", scope: ["src/**"], acceptance: ["x", "y"], steps: [], ladder_step: 0 },
  ...span("b", "builder", 21, 90, 0.3),
  { ts: at(50), trace_id: "bk-1", type: "tool_denied", span_id: "b", role: "builder", tool: "Bash", reason: "role `builder` may not run git or gh — only devops may", command: "git push" },
  { ts: at(90), trace_id: "bk-1", type: "build_done", files: ["src/a.ts"], revision: 1 },
  ...span("c", "adversary", 91, 150, 0.4),
  { ts: at(150), trace_id: "bk-1", type: "veto", role: "adversary", revision: 1, kind: "soft", reason: "empty input crashes", findings: [{ file: "src/a.ts", summary: "empty input crashes", severity: "blocker" }] },
  { ts: at(151), trace_id: "bk-1", type: "ladder_advanced", from: 0, to: 1, reason: "empty input crashes" },
];

test("a trace is a tree: denials hang under the span that tried them", () => {
  const trace = buildTrace(RUN, "bk-1");
  assert.ok(trace);
  assert.deepEqual(trace.spans.map((s) => s.role), ["planner", "builder", "adversary"]);

  const builder = trace.spans[1];
  assert.equal(builder.denials.length, 1);
  assert.equal(builder.denials[0].detail, "git push");
  assert.equal(trace.spans[0].denials.length, 0, "a denial belongs to one span, not to all of them");
});

test("what a span produced is attributed to that span", () => {
  const trace = buildTrace(RUN, "bk-1");
  assert.match(trace?.spans[0].outcome ?? "", /routine · 1 scope, 2 criteria/);
  assert.match(trace?.spans[1].outcome ?? "", /revision 1 · 1 files/);
  assert.match(trace?.spans[2].outcome ?? "", /VETO \(soft\) · 1 blocker/);
});

test("durations come from the pair, and an unclosed span reads as open", () => {
  const trace = buildTrace(RUN, "bk-1");
  assert.equal(trace?.spans[0].durationMs, 19_000);

  const killed = buildTrace(RUN.slice(0, 2), "bk-1");
  assert.equal(killed?.spans[0].durationMs, null, "a daemon killed mid-span leaves it open, and it should look open");
  assert.equal(killed?.spans[0].subtype, "open");
});

test("a trace for a task that does not exist is null, not an empty shell", () => {
  assert.equal(buildTrace(RUN, "bk-99"), null);
});

test("a trace ignores other tasks entirely", () => {
  const noisy: HarnessEvent[] = [...RUN, ...span("z", "builder", 200, 260, 9).map((e) => ({ ...e, trace_id: "bk-2" }))];
  assert.equal(buildTrace(noisy, "bk-1")?.spans.length, 3);
});

test("spend is attributed by role and by model", () => {
  const stats = buildStats(RUN, policy);
  assert.equal(stats.spend.total, 0.9);
  assert.equal(stats.spend.byRole.adversary, 0.4);
  assert.equal(stats.spend.byModel["claude-sonnet-5"], 0.9);
  assert.equal(stats.spend.byDay["2026-04-01"], 0.9);
});

test("the ladder is scored on whether the cheap rung held", () => {
  // If tasks routinely climb, the ladder starts on the wrong rung and every one
  // of them pays for that discovery twice.
  const climbed = buildStats([...RUN, { ts: at(300), trace_id: "bk-1", type: "task_failed", reason: "gave up" }], policy);
  assert.equal(climbed.ladder.finished, 1);
  assert.equal(climbed.ladder.onFirstAttempt, 0, "this task climbed");
  assert.equal(climbed.ladder.climbs, 1);

  const clean = RUN.filter((e) => e.type !== "ladder_advanced");
  const straight = buildStats([...clean, { ts: at(300), trace_id: "bk-1", type: "merge", sha: "abc", by: "human" }], policy);
  assert.equal(straight.ladder.onFirstAttempt, 1);
});

test("median time per role, because one stuck span ruins a mean", () => {
  const stats = buildStats(RUN, policy);
  assert.equal(stats.medianDurationMs.builder, 69_000);
  assert.equal(stats.medianDurationMs.planner, 19_000);
});

test("denials are counted by role and by reason, so a guard leak is visible", () => {
  const stats = buildStats(RUN, policy);
  assert.equal(stats.denials.byRole.builder, 1);
  assert.equal(Object.keys(stats.denials.byReason)[0], "role `builder` may not run git or gh");
});

test("the cache ratio is the silent-invalidator detector", () => {
  const stats = buildStats(RUN, policy);
  assert.equal(stats.cache.read, 27_000);
  assert.equal(Math.round(stats.cache.ratio * 100), 90);

  const cold = buildStats(RUN.map((e) =>
    e.type === "span_end" ? { ...e, cache_read_tokens: 0 } : e), policy);
  assert.equal(cold.cache.ratio, 0, "zero reads across many spans means the prefix is changing per spawn");
});

test("a window excludes what happened before it", () => {
  const stats = buildStats(RUN, policy, at(100));
  assert.equal(stats.spend.total, 0.4, "only the adversary span is inside the window");
  assert.equal(stats.tasks, 0, "and the task itself was opened before it");
});

test("what keeps blocking is surfaced as a rule, not a one-off", () => {
  const across: HarnessEvent[] = ["bk-1", "bk-2", "bk-3"].flatMap((id, i) => [
    { ts: at(400 + i), trace_id: id, type: "backlog_add", text: "t", origin: "trusted", source: "human", fingerprint: id },
    { ts: at(401 + i), trace_id: id, type: "veto", role: "review", revision: 1, kind: "soft", reason: "no error handling on the write path", findings: [{ file: `${id}.ts`, summary: "no error handling on the write path", severity: "blocker" }] },
  ]);
  const stats = buildStats(across, policy);
  assert.equal(stats.vetoes.recurring.length, 1);
  assert.equal(stats.vetoes.recurring[0].tasks.length, 3);
  assert.equal(stats.vetoes.byRole.review, 3);
});
