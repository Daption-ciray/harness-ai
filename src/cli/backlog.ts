import { loadPolicy } from "../policy.ts";
import { resolvePaths } from "../paths.ts";
import { advance } from "../pipeline.ts";
import { addBacklog, isActive, listTasks, readTask, type Origin } from "../task.ts";

export function backlogAdd(cwd: string, text: string, origin: Origin = "trusted"): string {
  if (!text.trim()) throw new Error("backlog add needs some text");
  const task = addBacklog(resolvePaths(cwd), { text: text.trim(), origin, source: "human" });
  return `${task.id}  queued  (${task.origin})  ${task.text}`;
}

export function tasks(cwd: string): string {
  const all = listTasks(resolvePaths(cwd));
  if (all.length === 0) return "no tasks — `harness backlog add \"<what to do>\"`";
  return all.map((t) => {
    const pr = t.pr ? ` ${t.pr.url}` : "";
    const cost = t.cost_usd > 0 ? ` $${t.cost_usd.toFixed(4)}` : "";
    const err = t.last_error ? `  ← ${t.last_error}` : "";
    return `${t.id.padEnd(8)} ${t.state.padEnd(10)} ${t.class.padEnd(8)} ${t.origin.padEnd(9)}${cost}${pr}  ${t.text}${err}`;
  }).join("\n");
}

/**
 * Advance one task by one stage, in the foreground. The daemon does the same
 * thing on a timer; this is how you watch a single stage without waiting.
 */
export async function runOnce(cwd: string, id?: string): Promise<string> {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);
  const task = id ? readTask(paths, id) : listTasks(paths).filter(isActive)[0];
  if (!task) return "nothing to advance";
  const before = task.state;
  const after = await advance(task, { policy, paths });
  const err = after.last_error ? `  ← ${after.last_error}` : "";
  return `${after.id}  ${before} → ${after.state}  $${after.cost_usd.toFixed(4)}${err}`;
}
