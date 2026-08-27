import { readAll } from "../events.ts";
import { resolvePaths } from "../paths.ts";
import { buildTrace } from "../report.ts";
import { ago, duration, money, tokens } from "./format.ts";

/**
 * One task's whole life, as a tree. Denials hang under the span that attempted
 * them and outcomes under the span that produced them, because "what did this
 * agent actually do" is the question being asked — a flat list of events makes
 * you reconstruct that in your head every time.
 */
export function trace(cwd: string, traceId: string): string {
  const paths = resolvePaths(cwd);
  const result = buildTrace(readAll(paths.eventsFile), traceId);
  if (!result) return `no such task: ${traceId}`;
  const { task, spans } = result;

  const lines = [
    `${task.id}  ${task.state}  ${money(task.cost_usd)}  ${duration(result.durationMs)}  ${ago(task.created_at)}`,
    `  ${task.text.split("\n")[0].slice(0, 88)}`,
    `  ${task.task_class} · origin ${task.origin} · source ${task.source}` +
      (task.quarantined ? " · QUARANTINED" : "") +
      (task.pr ? ` · #${task.pr.number}` : ""),
    "",
  ];

  for (const [i, span] of spans.entries()) {
    const last = i === spans.length - 1;
    const stem = last ? "└─" : "├─";
    const rail = last ? "   " : "│  ";
    lines.push(
      `${stem} ${span.role.padEnd(9)} ${span.model} · ${span.effort} · rung ${span.ladderStep}` +
      `  ${duration(span.durationMs).padStart(6)}  ${money(span.costUsd)}` +
      (span.cacheReadTokens ? `  ${tokens(span.cacheReadTokens)} cached` : "") +
      (span.ok ? "" : `  ← ${span.error ?? span.subtype}`),
    );
    for (const denial of span.denials) {
      lines.push(`${rail}├─ denied  ${denial.tool}  ${denial.detail.slice(0, 60)}`);
    }
    if (span.outcome) lines.push(`${rail}└─ ${span.outcome.slice(0, 100)}`);
  }

  for (const exchange of task.exchanges) {
    lines.push("", `?  ${exchange.question}`, `   ${exchange.answer ?? "(unanswered)"}`);
  }
  if (task.last_error && task.state === "failed") lines.push("", `!  ${task.last_error}`);

  const sessions = spans.filter((s) => s.spanId).length;
  lines.push("", `${spans.length} spans, ${sessions} transcripts. \`harness log\` for the raw events.`);
  return lines.join("\n");
}
