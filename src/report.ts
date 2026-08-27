import type { TaskState } from "./domain.ts";
import type { HarnessEvent } from "./events.ts";
import { pitfalls, type Pitfall } from "./memory.ts";
import type { Policy, Role } from "./policy.ts";
import { listTasks, projectOne, type Task } from "./projection.ts";

/**
 * Everything the trace view, the stats view and the dashboard read.
 *
 * One place, because three copies of the same aggregation drift apart, and the
 * first time they disagree nobody knows which one is lying. Pure functions over
 * the event log: no IO, so every number below is testable without a daemon.
 */

export type Denial = { tool: string; reason: string; detail: string };

export type Span = {
  spanId: string;
  role: Role;
  model: string;
  effort: string;
  ladderStep: number;
  startedAt: string;
  endedAt: string | null;
  /** Null while a span is still open — which is how a killed daemon looks. */
  durationMs: number | null;
  costUsd: number;
  cacheReadTokens: number;
  numTurns: number;
  ok: boolean;
  subtype: string;
  error: string | null;
  denials: Denial[];
  /** What the span produced: a verdict, a veto, a plan, a pull request. */
  outcome: string | null;
};

export type Trace = { task: Task; spans: Span[]; events: HarnessEvent[]; durationMs: number };

/** What an event says about the span that just closed, in one line. */
function outcomeOf(event: HarnessEvent): string | null {
  switch (event.type) {
    case "task_planned":
      return `${event.task_class} · ${event.scope.length} scope, ${event.acceptance.length} criteria`;
    case "build_done": return `revision ${event.revision} · ${event.files.length} files`;
    case "verdict":
      return `pass${event.findings.length ? ` · ${event.findings.length} concern(s)` : ""}`;
    case "veto":
      return `VETO (${event.kind}) · ${event.findings.filter((f) => f.severity === "blocker").length} blocker(s) · ${event.reason}`;
    case "decision_written": return `recorded: ${event.title}`;
    case "pr_opened": return `#${event.number} ${event.draft ? "draft" : "ready"} · ${event.url}`;
    case "question_asked": return `ASKS: ${event.question}`;
    case "ladder_advanced": return `rung ${event.from} → ${event.to} · ${event.reason}`;
    default: return null;
  }
}

export function buildTrace(events: HarnessEvent[], traceId: string): Trace | null {
  const mine = events.filter((e) => e.trace_id === traceId);
  const task = projectOne(mine, traceId);
  if (!task) return null;

  const spans = new Map<string, Span>();
  let lastSpanId: string | null = null;

  for (const event of mine) {
    if (event.type === "span_start") {
      lastSpanId = event.span_id;
      spans.set(event.span_id, {
        spanId: event.span_id, role: event.role, model: event.model,
        effort: event.effort, ladderStep: event.ladder_step,
        startedAt: event.ts, endedAt: null, durationMs: null,
        costUsd: 0, cacheReadTokens: 0, numTurns: 0,
        ok: false, subtype: "open", error: null, denials: [], outcome: null,
      });
      continue;
    }
    if (event.type === "tool_denied") {
      spans.get(event.span_id)?.denials.push({
        tool: event.tool, reason: event.reason, detail: event.command,
      });
      continue;
    }
    if (event.type === "span_end") {
      const span = spans.get(event.span_id);
      if (!span) continue;
      span.endedAt = event.ts;
      span.durationMs = Date.parse(event.ts) - Date.parse(span.startedAt);
      span.costUsd = event.cost_usd;
      span.cacheReadTokens = event.cache_read_tokens;
      span.numTurns = event.num_turns;
      span.ok = event.ok;
      span.subtype = event.subtype;
      span.error = event.error;
      continue;
    }
    // Anything else that carries meaning is attributed to the span it followed.
    const outcome = outcomeOf(event);
    if (outcome && lastSpanId) {
      const span = spans.get(lastSpanId);
      if (span && span.outcome === null) span.outcome = outcome;
    }
  }

  const first = mine[0]?.ts ?? task.created_at;
  const last = mine.at(-1)?.ts ?? first;
  return {
    task, events: mine, spans: [...spans.values()],
    durationMs: Date.parse(last) - Date.parse(first),
  };
}

export type Stats = {
  tasks: number;
  outcomes: Record<string, number>;
  spend: { total: number; byRole: Record<string, number>; byModel: Record<string, number>; byDay: Record<string, number> };
  /**
   * How often the cheap-first bet pays off. If tasks routinely climb, the
   * ladder is starting on the wrong rung and every task is paying for the
   * discovery twice.
   */
  ladder: { finished: number; onFirstAttempt: number; climbs: number };
  vetoes: { byRole: Record<string, number>; recurring: Pitfall[] };
  denials: { byRole: Record<string, number>; byReason: Record<string, number> };
  cache: { read: number; created: number; ratio: number };
  /** Median wall-clock per role. The mean is useless here; one stuck span skews it. */
  medianDurationMs: Record<string, number>;
  stalls: Record<string, number>;
};

function bump(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function buildStats(events: HarnessEvent[], policy: Policy, since = ""): Stats {
  const window = events.filter((e) => e.ts >= since);
  const tasks = listTasks(window);

  const stats: Stats = {
    tasks: tasks.length,
    outcomes: {},
    spend: { total: 0, byRole: {}, byModel: {}, byDay: {} },
    ladder: { finished: 0, onFirstAttempt: 0, climbs: 0 },
    vetoes: { byRole: {}, recurring: pitfalls(window, policy.memory.pitfall_threshold) },
    denials: { byRole: {}, byReason: {} },
    cache: { read: 0, created: 0, ratio: 0 },
    medianDurationMs: {},
    stalls: {},
  };

  for (const task of tasks) bump(stats.outcomes, task.state as TaskState);

  const durations: Record<string, number[]> = {};
  const openSpans = new Map<string, string>();

  for (const event of window) {
    if (event.type === "span_start") openSpans.set(event.span_id, event.ts);
    if (event.type === "span_end") {
      stats.spend.total = Math.round((stats.spend.total + event.cost_usd) * 1e6) / 1e6;
      bump(stats.spend.byRole, event.role, event.cost_usd);
      bump(stats.spend.byModel, event.model, event.cost_usd);
      bump(stats.spend.byDay, event.ts.slice(0, 10), event.cost_usd);
      stats.cache.read += event.cache_read_tokens;
      stats.cache.created += event.cache_creation_tokens;
      const started = openSpans.get(event.span_id);
      if (started) {
        (durations[event.role] ??= []).push(Date.parse(event.ts) - Date.parse(started));
      }
    }
    if (event.type === "veto") bump(stats.vetoes.byRole, event.role);
    if (event.type === "tool_denied") {
      bump(stats.denials.byRole, event.role);
      bump(stats.denials.byReason, event.reason.split("—")[0].trim().slice(0, 60));
    }
    if (event.type === "ladder_advanced") stats.ladder.climbs += 1;
    if (event.type === "stalled") bump(stats.stalls, event.kind);
  }

  for (const [role, values] of Object.entries(durations)) {
    stats.medianDurationMs[role] = median(values);
  }

  const climbedIds = new Set(
    window.filter((e) => e.type === "ladder_advanced").map((e) => e.trace_id),
  );
  for (const task of tasks) {
    if (!["merged", "escalated", "failed"].includes(task.state)) continue;
    stats.ladder.finished += 1;
    if (!climbedIds.has(task.id)) stats.ladder.onFirstAttempt += 1;
  }

  const cacheTotal = stats.cache.read + stats.cache.created;
  stats.cache.ratio = cacheTotal === 0 ? 0 : stats.cache.read / cacheTotal;
  return stats;
}
