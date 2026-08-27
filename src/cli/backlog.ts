import { sdkRunner } from "../agent-runner.ts";
import { ghForge } from "../github.ts";
import { readFileSync } from "node:fs";
import { HUMAN_STATES, isActiveState, type Origin } from "../domain.ts";
import { emit, readAll } from "../events.ts";
import { LockBusy, withLock } from "../lock.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { addBacklog, advance, type Ctx } from "../pipeline.ts";
import { activeTasks, listTasks, nextTaskId, projectOne } from "../projection.ts";
import { money } from "./format.ts";

/**
 * What someone asks for, in their own words. A feature request rarely fits on one
 * argv line, so the text can also come from a file or from stdin — `harness ask <
 * spec.md` is the shape this is usually wanted in.
 */
export function ask(
  cwd: string,
  input: { text?: string; file?: string; stdin?: string },
  origin: Origin = "trusted",
): string {
  const text = (input.file ? readFileSync(input.file, "utf8") : (input.text || input.stdin || "")).trim();
  if (!text) {
    throw new Error('nothing to do: harness ask "<what you want>", --file <path>, or pipe it in');
  }
  const paths = resolvePaths(cwd);
  const id = nextTaskId(readAll(paths.eventsFile));
  addBacklog(paths.eventsFile, id, { text, origin, source: "human" });
  return `${id}  queued  ${text.split("\n")[0].slice(0, 60)}\n` +
    `        runs ahead of anything a sensor found. \`harness tasks\` to follow it.`;
}

/**
 * Answers the question a planner stopped on. Without this, a question is a dead
 * end and the person has to retype the whole request to say one thing.
 */
export function answer(cwd: string, id: string, text: string): string {
  const paths = resolvePaths(cwd);
  const task = projectOne(readAll(paths.eventsFile), id);
  if (!task) return `no such task: ${id}`;
  const pending = task.exchanges.find((e) => e.answer === null);
  if (!pending) return `${id} is not waiting on an answer (it is ${task.state})`;
  if (!text.trim()) throw new Error("an answer needs some text");

  emit(paths.eventsFile, id, "question_answered", { question: pending.question, answer: text.trim() });
  return `${id}  blocked → queued\n        Q: ${pending.question}\n        A: ${text.trim()}`;
}

/** Every task a person needs to look at, and why. */
export function waiting(cwd: string): string {
  const tasks = listTasks(readAll(resolvePaths(cwd).eventsFile))
    .filter((t) => HUMAN_STATES.includes(t.state));
  if (tasks.length === 0) return "nothing is waiting on you";
  return tasks.map((t) => {
    if (t.state === "blocked") {
      const q = t.exchanges.find((e) => e.answer === null)?.question ?? "(no question recorded)";
      return `${t.id}  needs an answer\n      ${q}\n      → harness answer ${t.id} "..."`;
    }
    return `${t.id}  needs review${t.pr ? `  ${t.pr.url}` : ""}\n      ${t.text.split("\n")[0].slice(0, 70)}`;
  }).join("\n\n");
}

/**
 * Drops a task. Recorded as an event like everything else - the log is
 * append-only, so a task is retired by saying so, never by deleting history.
 */
export function cancel(cwd: string, id: string, reason: string): string {
  const paths = resolvePaths(cwd);
  const task = projectOne(readAll(paths.eventsFile), id);
  if (!task) return `no such task: ${id}`;
  if (!isActiveState(task.state)) return `${id} is already ${task.state}`;
  emit(paths.eventsFile, id, "task_failed", { reason: `cancelled by human: ${reason}` });
  return `${id}  ${task.state} → failed  (${reason})`;
}

export function tasks(cwd: string, json = false): string {
  const all = listTasks(readAll(resolvePaths(cwd).eventsFile));
  if (json) {
    return JSON.stringify(all.map((t) => ({
      id: t.id, state: t.state, task_class: t.task_class, origin: t.origin,
      cost_usd: t.cost_usd, pr: t.pr, text: t.text, last_error: t.last_error,
    })));
  }
  if (all.length === 0) return 'no tasks — `harness backlog add "<what to do>"`';
  return all.map((t) => [
    t.id.padEnd(8), t.state.padEnd(10), t.task_class.padEnd(8), t.origin.padEnd(9),
    money(t.cost_usd).padEnd(9), t.pr ? `#${t.pr.number}` : "  -",
    ` ${t.text}`, t.last_error ? `  ← ${t.last_error}` : "",
  ].join(" ")).join("\n");
}

/**
 * Advance one task by one stage, in the foreground. Takes the same lock the
 * daemon does: without it, a manual run and a tick can drive the same task into
 * two worktrees and two pull requests.
 */
export async function runOnce(cwd: string, id?: string): Promise<string> {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);
  const events = readAll(paths.eventsFile);
  const task = id ? projectOne(events, id) : activeTasks(events)[0];
  if (!task) return id ? `no such task: ${id}` : "nothing to advance";

  const before = task.state;
  const ctx: Ctx = { policy, paths, runner: sdkRunner, forge: ghForge };
  try {
    const after = await withLock(paths.lockFile, "harness run", () => advance(task, ctx));
    return `${after.id}  ${before} → ${after.state}  ${money(after.cost_usd)}` +
      (after.last_error ? `  ← ${after.last_error}` : "");
  } catch (e) {
    if (e instanceof LockBusy) return `busy — ${e.message}`;
    throw e;
  }
}
