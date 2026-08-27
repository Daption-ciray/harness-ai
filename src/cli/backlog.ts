import { sdkRunner } from "../agent-runner.ts";
import { ghForge } from "../github.ts";
import { isActiveState, type Origin } from "../domain.ts";
import { emit, readAll } from "../events.ts";
import { LockBusy, withLock } from "../lock.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { addBacklog, advance, type Ctx } from "../pipeline.ts";
import { activeTasks, listTasks, nextTaskId, projectOne } from "../projection.ts";
import { money } from "./format.ts";

export function backlogAdd(cwd: string, text: string, origin: Origin = "trusted"): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("backlog add needs some text");
  const paths = resolvePaths(cwd);
  const id = nextTaskId(readAll(paths.eventsFile));
  addBacklog(paths.eventsFile, id, { text: trimmed, origin, source: "human" });
  return `${id}  queued  (${origin})  ${trimmed}`;
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

export function tasks(cwd: string): string {
  const all = listTasks(readAll(resolvePaths(cwd).eventsFile));
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
