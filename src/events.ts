import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Effort, Role } from "./policy.ts";
import type { Finding, Origin, TaskClass } from "./domain.ts";

/**
 * The event log is the ONLY source of truth for task state. Everything a reader
 * needs — `harness status`, `harness trace`, the daemon's next decision — is a
 * fold over this log (see projection.ts). There is deliberately no second
 * mutable store to drift out of step with it.
 *
 * Each shape carries everything the fold needs, so the fold never has to infer
 * a transition from the absence of something.
 */
export type EventShapes = {
  daemon_start: { pid: number; slug: string; tick_seconds: number };
  daemon_stop: { signal: string };
  paused: { reason: string };
  resumed: { reason: string };

  /**
   * `fingerprint` is what stops a sensor queueing the same problem every time it
   * looks. Stable for the problem, not for the observation.
   */
  backlog_add: { text: string; origin: Origin; source: string; fingerprint: string };
  sensor_ran: { sensor: string; found: number; queued: number; detail: string };
  task_planned: {
    role: Role; task_class: TaskClass; scope: string[];
    acceptance: string[]; steps: string[]; ladder_step: number;
  };
  ladder_advanced: { from: number; to: number; reason: string };
  /** The planner could not write acceptance criteria without an answer. */
  question_asked: { role: Role; question: string };
  question_answered: { question: string; answer: string };
  build_done: { files: string[]; revision: number };
  verified: { revision: number; verifiers: Role[] };
  decision_written: { title: string; anchors: string[]; constraint: string | null };
  worktree_open: { branch: string; dir: string; setup_artifacts: string[]; setup_error: string | null };
  worktree_close: { dir: string };

  span_start: { span_id: string; role: Role; model: string; effort: Effort; ladder_step: number };
  span_end: {
    span_id: string; role: Role; model: string; effort: Effort; ladder_step: number;
    cost_usd: number; session_id: string; ok: boolean; subtype: string;
    num_turns: number; denials: number; error: string | null;
    cache_read_tokens: number; cache_creation_tokens: number;
    model_usage: Record<string, unknown>;
  };
  tool_denied: { span_id: string; role: Role; tool: string; reason: string; command: string };

  /** A verifier passed the current revision. Concerns may still be attached. */
  verdict: { role: Role; revision: number; findings: Finding[]; note: string };
  /** A verifier blocked the current revision. `findings` is never empty. */
  veto: { role: Role; revision: number; kind: "hard" | "soft"; reason: string; findings: Finding[] };
  stalled: { kind: "max_rounds" | "ping_pong" | "no_progress"; role: Role; detail: string };
  preempt: { from: Role; to: Role; reason: string };
  lease_acquired: { holder: Role; reason: string; ttl_seconds: number };
  lease_released: { holder: Role; reason: string };

  pr_opened: { number: number; url: string; draft: boolean; sha: string | null; files: number; lines: number };
  ci_result: { ok: boolean; summary: string };
  /** Every escalation rule that matched, and why. Empty means auto-merge. */
  merge_gate: { escalate: boolean; reasons: string[] };
  merge: { sha: string; by: "human" | "harness" };
  merge_blocked: { reason: string };
  escalate: { reason: string };
  task_failed: { reason: string };
  budget_pause: { spent_usd: number; limit_usd: number; window: "task" | "day" };
  flag: { kind: string; detail: string };
  revert: { sha: string; reason: string };
};

export type EventType = keyof EventShapes;

export type HarnessEvent = {
  [K in EventType]: { ts: string; trace_id: string; type: K } & EventShapes[K];
}[EventType];

/** The trace id used for events that belong to the daemon rather than a task. */
export const DAEMON_TRACE = "daemon";

/**
 * Synchronous and durable, and written BEFORE the action it describes. A crash
 * between the write and the action replays as "attempted"; a crash after
 * replays as "done". Both are recoverable — a missing event is not.
 */
export function emit<K extends EventType>(
  file: string,
  trace_id: string,
  type: K,
  fields: EventShapes[K],
): HarnessEvent {
  const event = { ts: new Date().toISOString(), trace_id, type, ...fields } as HarnessEvent;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  return event;
}

/**
 * A corrupt line is skipped rather than fatal: a daemon killed mid-write can
 * leave a partial last line, and refusing to start because of it would turn a
 * recoverable crash into an unrecoverable one.
 */
export function readAll(file: string): HarnessEvent[] {
  if (!existsSync(file)) return [];
  const out: HarnessEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as HarnessEvent);
    } catch {
      // partial write at the tail of a killed process
    }
  }
  return out;
}

export function readTrace(file: string, traceId: string): HarnessEvent[] {
  return readAll(file).filter((e) => e.trace_id === traceId);
}

/** Narrows a heterogeneous log to one event type without a cast at the call site. */
export function isType<K extends EventType>(
  event: HarnessEvent,
  type: K,
): event is Extract<HarnessEvent, { type: K }> {
  return event.type === type;
}
