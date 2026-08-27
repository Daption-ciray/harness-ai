import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const EVENT_TYPES = [
  "daemon_start", "daemon_stop", "paused", "resumed",
  "backlog_add", "task_planned",
  "span_start", "span_end",
  "tool_denied",
  "veto", "preempt", "lease_acquired", "lease_released",
  "worktree_open", "worktree_close",
  "pr_opened", "pr_ready", "ci_result", "merge",
  "escalate", "budget_pause", "flag", "revert",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type HarnessEvent = {
  ts: string;
  /** Backlog item id. Maps one-to-one onto a PR. */
  trace_id: string;
  /** One agent run. */
  span_id?: string;
  parent_span?: string;
  type: EventType;
  role?: string;
  task_id?: string;
  model?: string;
  effort?: string;
  ladder_step?: number;
  cost_usd?: number;
  /** Agent SDK session id - the door to the raw transcript. */
  session_id?: string;
  outcome?: string;
  reason?: string;
  payload?: unknown;
};

/**
 * Append durably and synchronously. Every state transition is written BEFORE
 * the action it describes, so a crashed daemon can replay the log on restart.
 * ponytail: plain JSONL, no rotation. Add rotation when a log actually gets big.
 */
export function append(file: string, event: Omit<HarnessEvent, "ts"> & { ts?: string }): HarnessEvent {
  const full: HarnessEvent = { ts: new Date().toISOString(), ...event };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function readAll(file: string): HarnessEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as HarnessEvent);
}

export function readTrace(file: string, traceId: string): HarnessEvent[] {
  return readAll(file).filter((e) => e.trace_id === traceId);
}
