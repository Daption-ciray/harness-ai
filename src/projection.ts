import type { HarnessEvent } from "./events.ts";
import { DAEMON_TRACE } from "./events.ts";
import type { Origin, TaskClass, TaskState } from "./domain.ts";
import { isActiveState } from "./domain.ts";

/**
 * A task is not stored anywhere. It is the fold of its own events, so there is
 * no second copy to drift, and a daemon killed at any point recovers exactly
 * the state its log describes.
 */
export type Task = {
  id: string; // the trace id, and one-to-one with the pull request
  text: string;
  origin: Origin;
  source: string;
  fingerprint: string;
  state: TaskState;
  task_class: TaskClass;
  scope: string[];
  acceptance: string[];
  steps: string[];
  branch: string | null;
  worktree: string | null;
  /** Left behind by worktree_setup_cmd: never the builder's doing. */
  setup_artifacts: string[];
  pr: { number: number; url: string; draft: boolean } | null;
  /** Set by a hard veto. Only a human clears it. */
  quarantined: boolean;
  /** Failed builder attempts. */
  rounds: number;
  /** Bumped by every build; verdicts are always about one revision. */
  revision: number;
  ladder_step: number;
  cost_usd: number;
  spans: number;
  /** Question and answer pairs, in order, from every time the planner stalled. */
  exchanges: { question: string; answer: string | null }[];
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function seed(id: string, ts: string, event: Extract<HarnessEvent, { type: "backlog_add" }>): Task {
  return {
    id, text: event.text, origin: event.origin, source: event.source, fingerprint: event.fingerprint,
    state: "queued", task_class: "routine",
    scope: [], acceptance: [], steps: [],
    branch: null, worktree: null, setup_artifacts: [], pr: null, quarantined: false,
    rounds: 0, revision: 0, ladder_step: 0, cost_usd: 0, spans: 0,
    exchanges: [], last_error: null,
    created_at: ts, updated_at: ts,
  };
}

/** Cost is summed in cents to keep the fold associative and free of float drift. */
function addCost(current: number, delta: number): number {
  return Math.round((current + delta) * 1e6) / 1e6;
}

/**
 * Fold one event into a task. Pure and total: an event for an unknown trace, or
 * one that says nothing about task state, leaves the accumulator untouched.
 */
export function apply(task: Task, event: HarnessEvent): Task {
  const next = (patch: Partial<Task>): Task => ({ ...task, ...patch, updated_at: event.ts });

  switch (event.type) {
    case "backlog_add":
      return task; // the seed already carries it
    case "task_planned":
      return next({
        state: "planned", task_class: event.task_class, scope: event.scope,
        acceptance: event.acceptance, steps: event.steps,
        ladder_step: event.ladder_step, last_error: null,
      });
    case "question_asked":
      return next({
        state: "blocked",
        exchanges: [...task.exchanges, { question: event.question, answer: null }],
        last_error: event.question,
      });
    case "question_answered":
      // Back to the front of the queue: the person is waiting on this.
      return next({
        state: "queued", last_error: null,
        exchanges: task.exchanges.map((e) =>
          e.question === event.question && e.answer === null ? { ...e, answer: event.answer } : e),
      });
    case "ladder_advanced":
      return next({ ladder_step: event.to, last_error: event.reason });
    case "worktree_open":
      return next({
        branch: event.branch, worktree: event.dir,
        setup_artifacts: event.setup_artifacts,
      });
    case "worktree_close":
      return next({ worktree: null });
    case "build_done":
      return next({ state: "verifying", revision: event.revision, last_error: null });
    case "verified":
      return next({ state: "scribing", last_error: null });
    case "decision_written":
      return next({ state: "integrating" });
    case "verdict":
      return task; // trace history; the gate is computed, not stored
    case "veto":
      // A soft veto sends the work back to the builder. A hard veto quarantines
      // it, and only a human or `security` releases that.
      return event.kind === "soft"
        ? next({ state: "planned", last_error: `${event.role}: ${event.reason}` })
        // A hard veto skips the remaining verifiers - security said stop, so
        // there is nothing left to weigh - and goes straight to a draft pull
        // request, because a finding a human never sees protects nobody.
        : next({
          state: "integrating", quarantined: true,
          last_error: `${event.role} (hard veto): ${event.reason}`,
        });
    case "stalled":
      return next({ state: "failed", last_error: `${event.kind}: ${event.detail}` });
    case "span_end":
      return next({
        cost_usd: addCost(task.cost_usd, event.cost_usd),
        spans: task.spans + 1,
        rounds: event.role === "builder" && !event.ok ? task.rounds + 1 : task.rounds,
        last_error: event.ok ? task.last_error : (event.error ?? event.subtype),
      });
    case "pr_opened":
      // The gate decides where this lands; until it speaks, the pull request
      // exists but nothing has been concluded about it.
      return next({ pr: { number: event.number, url: event.url, draft: event.draft } });
    case "merge_gate":
      // The reason travels with the task, not only in the log. Why a change is
      // waiting on you is the most useful thing `harness waiting` can tell you,
      // and reconstructing it from events every time is how it gets lost.
      return next({
        state: event.escalate ? "escalated" : "awaiting_merge",
        last_error: event.escalate ? event.reasons.join("; ") : null,
      });
    case "merge_blocked":
      // A blocked merge is not a failure, it is a change that needs a person.
      return next({ state: "escalated", last_error: event.reason });
    case "merge":
      return next({ state: "merged" });
    case "task_failed":
      return next({ state: "failed", last_error: event.reason });
    case "revert":
      return next({ state: "failed", last_error: `reverted: ${event.reason}` });
    default:
      // span_start, tool_denied, veto, lease_*, ci_result, escalate, flag,
      // budget_pause and the daemon events are trace history, not task state.
      return task;
  }
}

/** Folds the whole log into every task it describes, in log order. */
export function project(events: HarnessEvent[]): Map<string, Task> {
  const tasks = new Map<string, Task>();
  for (const event of events) {
    if (event.trace_id === DAEMON_TRACE) continue;
    if (event.type === "backlog_add") {
      // A replayed backlog_add for a known trace must not reset it.
      if (!tasks.has(event.trace_id)) {
        tasks.set(event.trace_id, seed(event.trace_id, event.ts, event));
      }
      continue;
    }
    const current = tasks.get(event.trace_id);
    if (!current) continue; // an event whose task was never opened
    tasks.set(event.trace_id, apply(current, event));
  }
  return tasks;
}

export function projectOne(events: HarnessEvent[], traceId: string): Task | null {
  return project(events.filter((e) => e.trace_id === traceId)).get(traceId) ?? null;
}

export function listTasks(events: HarnessEvent[]): Task[] {
  return [...project(events).values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function activeTasks(events: HarnessEvent[]): Task[] {
  return listTasks(events).filter((t) => isActiveState(t.state));
}

/** `bk-N`, allocated from the highest id the log has ever used. */
export function nextTaskId(events: HarnessEvent[]): string {
  const used = events
    .filter((e) => e.type === "backlog_add")
    .map((e) => Number(e.trace_id.replace(/^bk-/, "")))
    .filter((n) => Number.isFinite(n));
  return `bk-${(used.length ? Math.max(...used) : 0) + 1}`;
}

/**
 * States a sensor must not queue over. A problem already in flight, or already
 * sitting in front of a human, does not need queueing again; one the harness
 * failed at does not need retrying at full price every time the sensor looks.
 */
const SUPPRESSING: readonly TaskState[] = ["queued", "planned", "verifying", "scribing", "integrating", "escalated", "failed"];

/**
 * Whether this problem is already accounted for. `merged` is absent on purpose:
 * if a sensor still sees a problem after a fix merged, that is new information.
 */
export function isFingerprintSuppressed(events: HarnessEvent[], fingerprint: string): boolean {
  return listTasks(events).some((t) => t.fingerprint === fingerprint && SUPPRESSING.includes(t.state));
}

/** Total spend inside a rolling window, for the daily budget rail. */
export function spendSince(events: HarnessEvent[], sinceIso: string): number {
  return events
    .filter((e) => e.type === "span_end" && e.ts >= sinceIso)
    .reduce((sum, e) => addCost(sum, (e as Extract<HarnessEvent, { type: "span_end" }>).cost_usd), 0);
}
