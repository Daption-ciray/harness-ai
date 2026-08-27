import { emit, readAll, type HarnessEvent } from "../events.ts";
import { git } from "../git.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { projectOne } from "../projection.ts";

/**
 * Undoes a merge the harness made.
 *
 * This pushes straight to the default branch, which is the point: it is the
 * emergency path, and routing an undo through review would mean the thing being
 * undone stays live while somebody reviews the fix. A revert is itself
 * revertible, so the worst case is recoverable — unlike leaving a bad change in
 * place because the undo was inconvenient.
 *
 * Only harness merges can be reverted this way. Anything else is a person's
 * commit and not this tool's to rewrite.
 */
export function revert(cwd: string, traceId: string, reason: string): string {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);
  const events = readAll(paths.eventsFile);
  const task = projectOne(events, traceId);
  if (!task) return `no such task: ${traceId}`;

  const merge = events
    .filter((e): e is Extract<HarnessEvent, { type: "merge" }> => e.trace_id === traceId && e.type === "merge")
    .at(-1);
  if (!merge) return `${traceId} has nothing merged to revert (it is ${task.state})`;
  if (merge.by !== "harness") {
    return `${traceId} was merged by a person, not by the harness — revert it yourself so the intent is recorded as yours`;
  }
  if (!merge.sha) return `${traceId} has no merge commit recorded; revert it by hand`;

  git(["fetch", "origin", policy.repo.default_branch], paths.repoRoot);
  git(["checkout", policy.repo.default_branch], paths.repoRoot);
  git(["pull", "--ff-only", "origin", policy.repo.default_branch], paths.repoRoot);
  git(["revert", "--no-edit", merge.sha], paths.repoRoot);
  const head = git(["rev-parse", "HEAD"], paths.repoRoot);
  git(["push", "origin", policy.repo.default_branch], paths.repoRoot);

  emit(paths.eventsFile, traceId, "revert", { sha: merge.sha, reason });
  return `reverted ${merge.sha.slice(0, 8)} on ${policy.repo.default_branch} as ${head.slice(0, 8)}\n` +
    `        ${reason}`;
}
