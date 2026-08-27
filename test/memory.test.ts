import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Finding } from "../src/domain.ts";
import type { HarnessEvent } from "../src/events.ts";
import {
  appendDecision, decisionsHeader, isLive, parseDecisions, pitfalls,
  renderContext, renderDecision, type Decision,
} from "../src/memory.ts";
import { parsePolicy, type Policy } from "../src/policy.ts";
import { scratch } from "./helpers.ts";

const policy = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "bk-12",
  title: "Retries are bounded at three attempts",
  anchors: ["src/http/retry.ts"],
  body: "Unbounded retries turned a transient 502 into a forty-minute stall.",
  constraint: "no retry loop without an explicit ceiling",
  ...over,
});

let clock = 0;
const veto = (trace: string, findings: Finding[]): HarnessEvent => ({
  ts: new Date((clock += 1000)).toISOString(), trace_id: trace, type: "veto",
  role: "adversary", revision: 1, kind: "soft", reason: findings[0].summary, findings,
});
const blocker = (file: string, summary: string): Finding => ({ file, summary, severity: "blocker" });

test("a decision round-trips through the file format", () => {
  const parsed = parseDecisions(decisionsHeader() + "\n" + renderDecision(decision()));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], decision());
});

test("appending never rewrites what is already on record", () => {
  let text = decisionsHeader();
  text = appendDecision(text, decision({ id: "bk-1", title: "First" }));
  const afterFirst = text;
  text = appendDecision(text, decision({ id: "bk-2", title: "Second" }));
  assert.ok(text.startsWith(afterFirst.replace(/\s*$/, "")), "the earlier entry is untouched");
  assert.deepEqual(parseDecisions(text).map((d) => d.id), ["bk-1", "bk-2"]);
});

test("a decision with no constraint is still a valid entry", () => {
  const d = decision({ constraint: null });
  assert.equal(parseDecisions(renderDecision(d))[0].constraint, null);
});

test("an entry whose anchors are all gone stops being asserted as current", () => {
  // Memory that has quietly gone stale is worse than none, because it is believed.
  const repo = scratch();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/present.ts"), "");

  assert.equal(isLive(decision({ anchors: ["src/present.ts"] }), repo), true);
  assert.equal(isLive(decision({ anchors: ["src/present.ts:44"] }), repo), true, "a line anchor still names a file");
  assert.equal(isLive(decision({ anchors: ["src/deleted.ts"] }), repo), false);
  assert.equal(isLive(decision({ anchors: ["src/deleted.ts", "src/present.ts"] }), repo), true,
    "one surviving anchor keeps the entry alive");
  assert.equal(isLive(decision({ anchors: [] }), repo), true, "an entry about nothing in particular does not expire");
});

test("a finding on enough separate tasks becomes a standing pitfall", () => {
  const events = [
    veto("bk-1", [blocker("a.ts", "async cleanup is never awaited")]),
    veto("bk-2", [blocker("b.ts", "async cleanup is never awaited")]),
    veto("bk-3", [blocker("c.ts", "something else")]),
  ];
  assert.deepEqual(pitfalls(events, 2).map((p) => p.summary), ["async cleanup is never awaited"]);
  assert.deepEqual(pitfalls(events, 3), [], "two tasks is not yet a pattern");
});

test("one task repeating itself is not a pattern across the codebase", () => {
  const events = [
    veto("bk-1", [blocker("a.ts", "same complaint")]),
    veto("bk-1", [blocker("a.ts", "same complaint")]),
    veto("bk-1", [blocker("a.ts", "same complaint")]),
  ];
  assert.deepEqual(pitfalls(events, 2), [], "distinct tasks are what make it a property of the code");
});

test("concerns are never promoted to pitfalls", () => {
  const events = ["bk-1", "bk-2", "bk-3"].map((t) =>
    veto(t, [{ file: "a.ts", summary: "naming", severity: "concern" }]));
  assert.deepEqual(pitfalls(events, 2), []);
});

function context(over: { decisions?: string; events?: HarnessEvent[]; policy?: Policy; repoRoot?: string } = {}): string {
  return renderContext({
    repoRoot: over.repoRoot ?? scratch(),
    decisionsText: over.decisions ?? decisionsHeader(),
    events: over.events ?? [],
    policy: over.policy ?? policy,
  });
}

test("the brief always describes how to build and test the repository", () => {
  const rendered = context();
  assert.match(rendered, /# Project brief/);
  assert.match(rendered, /npm test/);
});

test("the brief carries constraints and pitfalls, phrased for a builder", () => {
  const repo = scratch();
  mkdirSync(join(repo, "src/http"), { recursive: true });
  writeFileSync(join(repo, "src/http/retry.ts"), "");
  const rendered = context({
    repoRoot: repo,
    decisions: appendDecision(decisionsHeader(), decision()),
    events: ["bk-1", "bk-2", "bk-3"].map((t) => veto(t, [blocker("a.ts", "async cleanup is never awaited")])),
  });
  assert.match(rendered, /no retry loop without an explicit ceiling/);
  assert.match(rendered, /async cleanup is never awaited/);
  assert.match(rendered, /Retries are bounded/);
});

test("an expired decision leaves the brief, taking its constraint with it", () => {
  const repo = scratch(); // the anchor file does not exist here
  const rendered = context({ repoRoot: repo, decisions: appendDecision(decisionsHeader(), decision()) });
  assert.ok(!rendered.includes("no retry loop"));
  assert.ok(!rendered.includes("Retries are bounded"));
});

test("the budget drops whole sections rather than cutting a sentence in half", () => {
  // A brief that ends mid-thought reads as a fact.
  const repo = scratch();
  mkdirSync(join(repo, "src/http"), { recursive: true });
  writeFileSync(join(repo, "src/http/retry.ts"), "");
  const tiny = { ...policy, memory: { ...policy.memory, context_budget_chars: 200 } };
  const rendered = context({
    repoRoot: repo, policy: tiny,
    decisions: appendDecision(decisionsHeader(), decision({ body: "x".repeat(4000) })),
  });
  assert.ok(rendered.length <= 200, `budget exceeded: ${rendered.length}`);
  assert.ok(!rendered.includes("xxxx"), "the oversized section was dropped, not truncated");
});

test("the brief is byte-stable while the decisions are - which is what keeps the prefix cached", () => {
  // This text is the tail of the cached prefix on every spawn. One changing byte
  // in it invalidates the cache for every agent that follows, so it carries no
  // timestamps, ids or counters.
  const repo = scratch();
  const decisions = appendDecision(decisionsHeader(), decision({ anchors: [] }));
  const first = context({ repoRoot: repo, decisions });

  const noisy: HarnessEvent[] = [
    { ts: new Date().toISOString(), trace_id: "bk-9", type: "span_start", span_id: "s", role: "builder", model: "m", effort: "high", ladder_step: 0 },
    { ts: new Date().toISOString(), trace_id: "bk-9", type: "escalate", reason: "unrelated" },
    { ts: new Date().toISOString(), trace_id: "bk-9", type: "backlog_add", text: "other work", origin: "trusted", source: "human" },
  ];
  assert.equal(context({ repoRoot: repo, decisions, events: noisy }), first,
    "unrelated activity must not move a single byte of the brief");

  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(first), "no dates");
  assert.ok(!/bk-\d+/.test(first), "no task ids");
});

test("a merged decision does move the brief - that is the only thing that should", () => {
  const repo = scratch();
  const before = context({ repoRoot: repo, decisions: decisionsHeader() });
  const after = context({
    repoRoot: repo,
    decisions: appendDecision(decisionsHeader(), decision({ anchors: [] })),
  });
  assert.notEqual(before, after);
});
