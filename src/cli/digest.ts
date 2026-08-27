import { readAll, type HarnessEvent } from "../events.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { listTasks } from "../projection.ts";
import { buildStats } from "../report.ts";
import { costBasis, costLabel } from "../billing.ts";
import { ago, money } from "./format.ts";

/**
 * What happened while nobody was watching. Thirty seconds in the morning: what
 * the harness merged on its own, what it is holding for you, and what it spent.
 *
 * Merges it made itself lead, because those are the ones nobody approved.
 */
export function digest(cwd: string, hours = 24): string {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const events = readAll(paths.eventsFile);
  const window = events.filter((e) => e.ts >= since);
  const tasks = listTasks(events);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const merges = window.filter((e): e is Extract<HarnessEvent, { type: "merge" }> => e.type === "merge");
  const auto = merges.filter((m) => m.by === "harness");
  const stats = buildStats(events, policy, since);

  const lines = [`harness · last ${hours}h · ${paths.slug}`, ""];

  lines.push(`merged by the harness itself: ${auto.length}`);
  for (const m of auto) {
    const task = byId.get(m.trace_id);
    lines.push(`  ${m.trace_id}  ${ago(m.ts).padEnd(9)} ${task?.text.split("\n")[0].slice(0, 62) ?? ""}`);
    lines.push(`         ${m.sha.slice(0, 8)} · harness revert ${m.trace_id} "why"`);
  }
  if (auto.length === 0) lines.push("  (none — every change went to a person)");
  lines.push("");

  const waiting = tasks.filter((t) => t.state === "escalated" || t.state === "blocked");
  lines.push(`waiting on you: ${waiting.length}`);
  for (const t of waiting) {
    const why = t.state === "blocked"
      ? (t.exchanges.find((e) => e.answer === null)?.question ?? "a question")
      : (t.last_error ?? "review");
    lines.push(`  ${t.id}  ${t.state.padEnd(10)} ${why.slice(0, 62)}`);
  }
  if (waiting.length === 0) lines.push("  (nothing)");
  lines.push("");

  const failed = tasks.filter((t) => t.state === "failed" && t.updated_at >= since);
  if (failed.length) {
    lines.push(`gave up: ${failed.length}`);
    for (const t of failed) lines.push(`  ${t.id}  ${(t.last_error ?? "").slice(0, 70)}`);
    lines.push("");
  }

  lines.push(`spent ~${money(stats.spend.total)} across ${stats.tasks} task(s)`);
  lines.push(`  ${costLabel(costBasis())}`);
  if (stats.vetoes.recurring.length) {
    lines.push("", "keeps blocking — worth a policy rule rather than a model round:");
    for (const p of stats.vetoes.recurring) lines.push(`  ${p.tasks.length}× ${p.summary.slice(0, 66)}`);
  }
  return lines.join("\n");
}
