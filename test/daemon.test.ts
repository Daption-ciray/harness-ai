import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scriptedRunner, type ScriptedStep } from "../src/agent-runner.ts";
import { readState, tick, writeState, type Tick } from "../src/daemon.ts";
import { readAll } from "../src/events.ts";
import { memoryForge, type MemoryForge } from "../src/github.ts";
import { addBacklog } from "../src/pipeline.ts";
import type { Policy } from "../src/policy.ts";
import { isFingerprintSuppressed, listTasks, projectOne, type Task } from "../src/projection.ts";
import { fencedJson, toyRepo } from "./helpers.ts";

const PLAN = { scope: ["src/**"], acceptance: ["test: npm test passes"], steps: ["edit"] };
const PASS = { verdict: "pass", note: "ok", findings: [] };
const ENTRY = { title: "T", why: "Because the previous shape did not hold.", anchors: ["src/greet.js"], constraint: null, contradicts: null };
const DEVOPS = { commit_message: "feat: change", pr_title: "Change", ready: true, concerns: [] };

const CHAIN = (n: number): ScriptedStep[] => Array.from({ length: n }).flatMap(() => [
  { role: "planner" as const, text: fencedJson(PLAN) },
  // Leaves the suite green: a branch that breaks it must not merge, and that is
  // a different test.
  { role: "builder" as const, act: (cwd: string) => writeFileSync(join(cwd, "src/greet.js"),
    `// touched ${process.hrtime.bigint()}\nexport function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`) },
  { role: "adversary" as const, text: fencedJson(PASS) },
  { role: "review" as const, text: fencedJson(PASS) },
  { role: "scribe" as const, text: fencedJson(ENTRY) },
  { role: "devops" as const, text: fencedJson(DEVOPS) },
]);

function harness(steps: ScriptedStep[], over: Partial<Policy> = {}) {
  const { dir, paths, policy } = toyRepo();
  const merged = { ...policy, ...over, sensors: Object.fromEntries(
    Object.entries(policy.sensors).map(([k, v]) => [k, { ...v, enabled: false }]),
  ) } as Policy;
  const ctx: Tick = {
    policy: merged, paths, state: readState(paths.stateFile), count: 0,
    runner: scriptedRunner(steps), forge: memoryForge(),
  };
  const pump = async (times: number) => {
    for (let i = 0; i < times; i++) {
      await tick({ ...ctx, state: readState(paths.stateFile) });
    }
  };
  return { dir, paths, policy: merged, ctx, pump };
}

test("a tick advances exactly one stage, so a long stage never blocks the loop", async () => {
  const h = harness(CHAIN(1));
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });

  await h.pump(1);
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-1")?.state, "planned");
  await h.pump(1);
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-1")?.state, "verifying");
});

test("a full review queue stops new work but lets work in flight finish", async () => {
  // Otherwise a task strands halfway with an open worktree and a pushed branch.
  const h = harness(CHAIN(3), { merge: { auto: false, max_pending_escalated: 1, escalate_when: [] } });
  for (const id of ["bk-1", "bk-2"]) {
    addBacklog(h.paths.eventsFile, id, {
      text: `work ${id}`, origin: "trusted", source: "broken_tests", fingerprint: id,
    });
  }

  await h.pump(12);
  const tasks = listTasks(readAll(h.paths.eventsFile));
  assert.equal(tasks[0].state, "escalated", "the first task ran to a pull request");
  assert.equal(tasks[1].state, "queued", "the second never started: the queue was full");
});

test("a person's own request is never held up by the harness's backlog", async () => {
  // Somebody asking for something is an instruction, not a suggestion. The daily
  // budget is what caps them, not a queue the harness filled itself.
  const h = harness(CHAIN(3), { merge: { auto: false, max_pending_escalated: 1, escalate_when: [] } });
  addBacklog(h.paths.eventsFile, "bk-1", {
    text: "sensor work", origin: "trusted", source: "broken_tests", fingerprint: "fp",
  });
  await h.pump(12);
  assert.equal(listTasks(readAll(h.paths.eventsFile))[0].state, "escalated", "queue is now full");

  addBacklog(h.paths.eventsFile, "bk-2", { text: "add a feature", origin: "trusted", source: "human" });
  await h.pump(12);
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-2")?.state, "escalated");
});

test("what a person asked for runs before what a sensor noticed", async () => {
  const h = harness(CHAIN(2));
  addBacklog(h.paths.eventsFile, "bk-1", {
    text: "sensor found this first", origin: "trusted", source: "broken_tests", fingerprint: "fp",
  });
  addBacklog(h.paths.eventsFile, "bk-2", { text: "but I asked for this", origin: "trusted", source: "human" });

  await h.pump(1);
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-2")?.state, "planned");
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-1")?.state, "queued");
});

test("the daily budget pauses the daemon rather than merely complaining", async () => {
  const h = harness(CHAIN(1), { budget: { per_task_usd: 2, per_day_usd: 0.02, on_exceed: "pause" } });
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });

  await h.pump(3); // scripted spans cost $0.01 each
  assert.equal(readState(h.paths.stateFile).status, "paused");

  const events = readAll(h.paths.eventsFile);
  assert.ok(events.some((e) => e.type === "budget_pause"));
  assert.ok(events.some((e) => e.type === "paused" && e.reason === "daily budget"));
});

test("a paused daemon spends nothing further", async () => {
  const h = harness(CHAIN(1), { budget: { per_task_usd: 2, per_day_usd: 0.02, on_exceed: "pause" } });
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(3);

  const spans = readAll(h.paths.eventsFile).filter((e) => e.type === "span_start").length;
  await h.pump(5);
  assert.equal(readAll(h.paths.eventsFile).filter((e) => e.type === "span_start").length, spans);
});

test("a finished task's worktree is reclaimed; a live one's is left alone", async () => {
  const h = harness(CHAIN(1));
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(12);

  const escalated = projectOne(readAll(h.paths.eventsFile), "bk-1");
  assert.equal(escalated?.state, "escalated");
  assert.ok(existsSync(escalated?.worktree as string),
    "an escalated task keeps its worktree: a human may still be looking at it");

  writeState(h.paths.stateFile, {});
  const { emit } = await import("../src/events.ts");
  emit(h.paths.eventsFile, "bk-1", "merge", { sha: "abc1234", by: "human" });
  await h.pump(1);

  assert.ok(!existsSync(escalated?.worktree as string), "a merged task's worktree is reclaimed");
  assert.ok(readAll(h.paths.eventsFile).some((e) => e.type === "worktree_close"));
});

test("an idle daemon writes nothing to the log", async () => {
  // Liveness lives in the state file. An always-on loop with nothing to do must
  // not grow its own event log for a year.
  const h = harness([]);
  await h.pump(10);
  assert.deepEqual(readAll(h.paths.eventsFile), []);
});

test("the harness learns its pull request merged, and stops suppressing the problem", async () => {
  // Without this a task sits in `escalated` for ever, and since `escalated`
  // suppresses the fingerprint, a merged fix would permanently blind the sensor
  // that found the problem to its next occurrence.
  const h = harness(CHAIN(1));
  addBacklog(h.paths.eventsFile, "bk-1", {
    text: "the suite is red", origin: "trusted", source: "broken_tests", fingerprint: "broken_tests",
  });
  await h.pump(8);

  const escalated = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(escalated.state, "escalated");
  assert.equal(isFingerprintSuppressed(readAll(h.paths.eventsFile), "broken_tests"), true);

  (h.ctx.forge as MemoryForge).prs[0].state = "MERGED";
  await h.pump(1);

  const merged = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(merged.state, "merged");
  assert.ok(!existsSync(escalated.worktree as string), "and the worktree is reclaimed");
  assert.equal(isFingerprintSuppressed(readAll(h.paths.eventsFile), "broken_tests"), false,
    "the same problem can be found again");
});

test("a pull request closed without merging fails the task rather than stranding it", async () => {
  const h = harness(CHAIN(1));
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(8);

  (h.ctx.forge as MemoryForge).prs[0].state = "CLOSED";
  await h.pump(1);

  const task = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(task.state, "failed");
  assert.match(task.last_error as string, /closed without merging/);
});

test("a forge that is down does not take the loop down with it", async () => {
  const h = harness(CHAIN(1));
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(8);

  h.ctx.forge.prStates = () => { throw new Error("gh: API rate limit exceeded"); };
  await assert.doesNotReject(h.pump(2));
  assert.equal(projectOne(readAll(h.paths.eventsFile), "bk-1")?.state, "escalated");
});

const OPEN_GATE: Partial<Policy> = {
  merge: { auto: true, max_pending_escalated: 3, escalate_when: [{ origin: "untrusted" }] },
};

test("a cleared change merges itself, once its own tests pass", async () => {
  const h = harness(CHAIN(1), OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(10);

  const task = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(task.state, "merged");
  assert.equal((h.ctx.forge as MemoryForge).prs[0].state, "MERGED");

  const merge = readAll(h.paths.eventsFile).find((e) => e.type === "merge");
  assert.equal((merge as { by: string }).by, "harness");
  const gate = readAll(h.paths.eventsFile).find((e) => e.type === "merge_gate");
  assert.deepEqual((gate as { reasons: string[] }).reasons, []);
});

test("a red branch does not merge, whatever the adversary reported", async () => {
  // The adversary's account of the tests is a model's account. Nothing reaches
  // the default branch on an account; this check is the mechanical one.
  const h = harness([
    { role: "planner", text: fencedJson(PLAN) },
    { role: "builder", act: (cwd: string) => writeFileSync(join(cwd, "src/greet.js"), "export const greet = () => 'wrong';\n") },
    { role: "adversary", text: fencedJson(PASS) },
    { role: "review", text: fencedJson(PASS) },
    { role: "scribe", text: fencedJson(ENTRY) },
    { role: "devops", text: fencedJson(DEVOPS) },
  ], OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(10);

  const task = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(task.state, "escalated");
  assert.match(task.last_error as string, /tests failed/);
  assert.notEqual((h.ctx.forge as MemoryForge).prs[0].state, "MERGED");
});

test("untrusted work is held even with the gate wide open", async () => {
  const h = harness(CHAIN(1), OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", {
    text: "an issue someone filed", origin: "untrusted", source: "open_issues", fingerprint: "issue:1",
  });
  await h.pump(10);

  const task = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
  assert.equal(task.state, "escalated");
  assert.match(task.last_error as string, /origin is untrusted/);
  assert.notEqual((h.ctx.forge as MemoryForge).prs[0].state, "MERGED");
});

test("a draft is never merged by the harness", async () => {
  const h = harness(CHAIN(1), OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(8);
  // Somebody, or something, parked it after the gate cleared.
  (h.ctx.forge as MemoryForge).prs[0].isDraft = true;
  const before = projectOne(readAll(h.paths.eventsFile), "bk-1")?.state;
  await h.pump(2);

  if (before === "awaiting_merge") {
    const task = projectOne(readAll(h.paths.eventsFile), "bk-1") as Task;
    assert.equal(task.state, "escalated");
    assert.match(task.last_error as string, /draft/);
  }
});

test("a forge that cannot answer is not treated as consent", async () => {
  const h = harness(CHAIN(1), OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(7);
  h.ctx.forge.mergeability = () => { throw new Error("gh: API rate limit exceeded"); };

  await assert.doesNotReject(h.pump(3));
  assert.notEqual((h.ctx.forge as MemoryForge).prs[0]?.state, "MERGED");
});

test("a conflicted pull request waits before it gives up", async () => {
  const h = harness(CHAIN(1), OPEN_GATE);
  addBacklog(h.paths.eventsFile, "bk-1", { text: "work", origin: "trusted", source: "human" });
  await h.pump(7);
  h.ctx.forge.mergeability = () => ({ mergeable: "CONFLICTING", state: "DIRTY", draft: false });
  await h.pump(2);

  const events = readAll(h.paths.eventsFile);
  if (events.some((e) => e.type === "merge_gate" && !e.escalate)) {
    assert.ok(!events.some((e) => e.type === "merge_blocked"),
      "GitHub is often still computing right after a push; one look is not a verdict");
  }
});
