import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scriptedRunner, type ScriptedStep } from "../src/agent-runner.ts";
import { readState, tick, writeState, type Tick } from "../src/daemon.ts";
import { readAll } from "../src/events.ts";
import { memoryForge } from "../src/github.ts";
import { addBacklog } from "../src/pipeline.ts";
import type { Policy } from "../src/policy.ts";
import { listTasks, projectOne } from "../src/projection.ts";
import { fencedJson, toyRepo } from "./helpers.ts";

const PLAN = { scope: ["src/**"], acceptance: ["test: npm test passes"], steps: ["edit"] };
const PASS = { verdict: "pass", note: "ok", findings: [] };
const ENTRY = { title: "T", why: "Because the previous shape did not hold.", anchors: ["src/greet.js"], constraint: null, contradicts: null };
const DEVOPS = { commit_message: "feat: change", pr_title: "Change", ready: true, concerns: [] };

const CHAIN = (n: number): ScriptedStep[] => Array.from({ length: n }).flatMap(() => [
  { role: "planner" as const, text: fencedJson(PLAN) },
  { role: "builder" as const, act: (cwd: string) => writeFileSync(join(cwd, "src/greet.js"), `// ${Math.random()}\n`) },
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
    addBacklog(h.paths.eventsFile, id, { text: `work ${id}`, origin: "trusted", source: "human" });
  }

  await h.pump(12);
  const tasks = listTasks(readAll(h.paths.eventsFile));
  assert.equal(tasks[0].state, "escalated", "the first task ran to a pull request");
  assert.equal(tasks[1].state, "queued", "the second never started: the queue was full");
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
  await h.pump(8);

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
