import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append } from "./events.ts";
import type { Paths } from "./paths.ts";
import type { TaskClass } from "./tier.ts";

export type Origin = "trusted" | "untrusted";

export type TaskState =
  | "queued"      // needs planner
  | "planned"     // needs builder
  | "built"       // needs devops
  | "escalated"   // PR open, waiting on a human
  | "merged"
  | "failed";

export type Task = {
  id: string; // also the trace_id, and one-to-one with the PR
  text: string;
  origin: Origin;
  source: string;
  state: TaskState;
  class: TaskClass;
  scope: string[];
  acceptance: string[];
  steps: string[];
  branch: string | null;
  worktree: string | null;
  pr: { number: number; url: string } | null;
  rounds: number;
  ladder_step: number;
  cost_usd: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function taskFile(paths: Paths, id: string): string {
  return join(paths.tasksDir, `${id}.json`);
}

export function listTasks(paths: Paths): Task[] {
  if (!existsSync(paths.tasksDir)) return [];
  return readdirSync(paths.tasksDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(paths.tasksDir, f), "utf8")) as Task)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function readTask(paths: Paths, id: string): Task {
  return JSON.parse(readFileSync(taskFile(paths, id), "utf8")) as Task;
}

export function writeTask(paths: Paths, task: Task): Task {
  const next = { ...task, updated_at: new Date().toISOString() };
  mkdirSync(paths.tasksDir, { recursive: true });
  writeFileSync(taskFile(paths, next.id), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function nextId(paths: Paths): string {
  const used = listTasks(paths)
    .map((t) => Number(t.id.replace(/^bk-/, "")))
    .filter((n) => Number.isFinite(n));
  return `bk-${(used.length ? Math.max(...used) : 0) + 1}`;
}

export function addBacklog(
  paths: Paths,
  input: { text: string; origin: Origin; source: string },
): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: nextId(paths), text: input.text, origin: input.origin, source: input.source,
    state: "queued", class: "routine", scope: [], acceptance: [], steps: [],
    branch: null, worktree: null, pr: null,
    rounds: 0, ladder_step: 0, cost_usd: 0, last_error: null,
    created_at: now, updated_at: now,
  };
  mkdirSync(paths.sidecar, { recursive: true });
  append(paths.backlogFile, {
    trace_id: task.id, type: "backlog_add",
    reason: input.source, outcome: input.origin, payload: { text: input.text },
  });
  append(paths.eventsFile, {
    trace_id: task.id, type: "backlog_add",
    reason: input.source, outcome: input.origin, payload: { text: input.text },
  });
  return writeTask(paths, task);
}

export const ACTIVE_STATES: TaskState[] = ["queued", "planned", "built"];

export function isActive(t: Task): boolean {
  return ACTIVE_STATES.includes(t.state);
}
