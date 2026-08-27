import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DAEMON_TRACE, emit, readAll } from "./events.ts";
import { sdkRunner, type AgentRunner } from "./agent-runner.ts";
import { ghForge, type Forge } from "./github.ts";
import { LockBusy, withLock } from "./lock.ts";
import { listTasks, spendSince } from "./projection.ts";
import { removeWorktree } from "./git.ts";
import { runSensors } from "./sensors.ts";
import { isActiveState } from "./domain.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { originUrl, resolvePaths, type Paths } from "./paths.ts";
import { advance } from "./pipeline.ts";

export type DaemonStatus = "running" | "paused" | "stopped";

export type State = {
  status: DaemonStatus;
  pid: number | null;
  started_at: string | null;
  last_tick: string | null;
  tick_count: number;
};

const EMPTY_STATE: State = {
  status: "stopped", pid: null, started_at: null, last_tick: null, tick_count: 0,
};

export function readState(file: string): State {
  if (!existsSync(file)) return { ...EMPTY_STATE };
  try {
    return { ...EMPTY_STATE, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function writeState(file: string, patch: Partial<State>): State {
  const next = { ...readState(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** A stopped daemon can leave a stale pid behind; treat a dead pid as stopped. */
export function isAlive(state: State): boolean {
  if (state.pid === null || state.status === "stopped") return false;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function requireOrigin(paths: Paths): string {
  const url = originUrl(paths.repoRoot);
  if (!url) {
    throw new Error(
      "no `origin` remote. harness needs a GitHub remote - the PR is the approval surface.\n" +
        "  fix: gh repo create <name> --private, then git remote add origin <url>",
    );
  }
  return url;
}

export type Tick = { policy: Policy; paths: Paths; state: State; count: number; runner: AgentRunner; forge: Forge };

/**
 * One scheduler pass: advance a single task by one stage. Phase 1 is
 * deliberately sequential - the lease scheduler and concurrent builders land in
 * phase 2, and racing them before the chain is proven only hides bugs.
 *
 * Liveness is the state file's last_tick, not a `tick` event: an idle always-on
 * daemon should not grow its own log.
 */
/**
 * The daily window starts at the later of twenty-four hours ago and the last
 * manual resume. Without that, resuming a daemon that paused on budget would
 * pause it again on the very next tick, and the only way out would be waiting
 * for the window to roll — so the control the human just used would not work.
 */
export function budgetWindowStart(events: ReturnType<typeof readAll>, now: number): string {
  const rolling = new Date(now - 24 * 3600 * 1000).toISOString();
  const resumed = [...events].reverse().find((e) => e.type === "resumed");
  return resumed && resumed.ts > rolling ? resumed.ts : rolling;
}

/** Worktrees are only disposable once a task can no longer be advanced. */
function reapWorktrees(ctx: Tick, tasks: ReturnType<typeof listTasks>): void {
  for (const task of tasks) {
    if (task.worktree === null) continue;
    if (task.state !== "failed" && task.state !== "merged") continue;
    try {
      removeWorktree(ctx.paths.repoRoot, task.worktree);
      emit(ctx.paths.eventsFile, task.id, "worktree_close", { dir: task.worktree });
    } catch (e) {
      console.error(`could not remove worktree for ${task.id}: ${(e as Error).message}`);
    }
  }
}

/**
 * One scheduler pass. Phase 1 kept this sequential on purpose; concurrent
 * builders arrive with a real dispatcher, and racing them before the chain was
 * proven would only have hidden bugs.
 *
 * Liveness is the state file's last_tick, not a `tick` event: an idle always-on
 * daemon should not grow its own log.
 */
export async function tick(ctx: Tick): Promise<void> {
  const events = readAll(ctx.paths.eventsFile);

  // The rail comes first. Everything below this line spends money.
  const spent = spendSince(events, budgetWindowStart(events, Date.now()));
  if (spent >= ctx.policy.budget.per_day_usd) {
    emit(ctx.paths.eventsFile, DAEMON_TRACE, "budget_pause", {
      spent_usd: spent, limit_usd: ctx.policy.budget.per_day_usd, window: "day",
    });
    if (ctx.policy.budget.on_exceed === "pause") {
      writeState(ctx.paths.stateFile, { status: "paused" });
      emit(ctx.paths.eventsFile, DAEMON_TRACE, "paused", { reason: "daily budget" });
      console.error(
        `daily budget of $${ctx.policy.budget.per_day_usd.toFixed(2)} spent ` +
        `($${spent.toFixed(2)}); paused. \`harness resume\` starts a fresh window.`,
      );
    }
    return;
  }

  runSensors({ policy: ctx.policy, paths: ctx.paths, forge: ctx.forge }, Date.now());

  const tasks = listTasks(readAll(ctx.paths.eventsFile));
  reapWorktrees(ctx, tasks);

  const pendingHuman = tasks.filter((t) => t.state === "escalated").length;
  const active = tasks.filter((t) => isActiveState(t.state));

  // WIP limit: a full review queue stops NEW work, but work already in flight
  // still finishes - otherwise tasks strand halfway with an open worktree.
  const pool = pendingHuman >= ctx.policy.merge.max_pending_escalated
    ? active.filter((t) => t.state !== "queued")
    : active;

  const next = pool[0];
  if (!next) return;
  await advance(next, { policy: ctx.policy, paths: ctx.paths, runner: ctx.runner, forge: ctx.forge });
}

export async function start(cwd = process.cwd()): Promise<void> {
  const paths = resolvePaths(cwd);
  requireOrigin(paths);

  const prior = readState(paths.stateFile);
  if (isAlive(prior)) {
    throw new Error(`daemon already running (pid ${prior.pid}) - use \`harness stop\` first`);
  }

  let policy = loadPolicy(paths.policyFile);
  for (const dir of [paths.sidecar, paths.worktreesDir]) {
    mkdirSync(dir, { recursive: true });
  }

  writeState(paths.stateFile, {
    status: "running",
    pid: process.pid,
    started_at: new Date().toISOString(),
    tick_count: 0,
  });
  emit(paths.eventsFile, DAEMON_TRACE, "daemon_start", {
    pid: process.pid, slug: paths.slug, tick_seconds: policy.runtime.tick_seconds,
  });
  console.log(`harness running · ${paths.slug} · tick ${policy.runtime.tick_seconds}s · pid ${process.pid}`);

  let busy = false;
  const timer = setInterval(() => {
    const state = readState(paths.stateFile);
    // Re-read policy each tick so edits apply live; keep the last good one on error.
    try {
      policy = loadPolicy(paths.policyFile);
    } catch (e) {
      console.error(`policy reload failed, keeping previous: ${(e as Error).message}`);
    }
    const count = state.tick_count + 1;
    writeState(paths.stateFile, { last_tick: new Date().toISOString(), tick_count: count });
    if (state.status === "paused" || busy) return;
    busy = true;
    // The lock, not `busy`, is what keeps a CLI invocation out; `busy` only
    // stops this daemon from overlapping itself when a stage outlives a tick.
    void withLock(paths.lockFile, "harness daemon", () => tick({ policy, paths, state, count, runner: sdkRunner, forge: ghForge }))
      .catch((e) => {
        if (!(e instanceof LockBusy)) console.error(`tick failed: ${(e as Error).message}`);
      })
      .finally(() => { busy = false; });
  }, policy.runtime.tick_seconds * 1000);

  const shutdown = (signal: string) => {
    clearInterval(timer);
    emit(paths.eventsFile, DAEMON_TRACE, "daemon_stop", { signal });
    writeState(paths.stateFile, { status: "stopped", pid: null });
    console.log(`\nharness stopped (${signal})`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {}); // run until signalled
}

export function stop(cwd = process.cwd()): string {
  const paths = resolvePaths(cwd);
  const state = readState(paths.stateFile);
  if (!isAlive(state)) {
    writeState(paths.stateFile, { status: "stopped", pid: null });
    return "not running";
  }
  process.kill(state.pid as number, "SIGTERM");
  return `sent SIGTERM to pid ${state.pid}`;
}

export function setPaused(cwd: string, paused: boolean): string {
  const paths = resolvePaths(cwd);
  const state = readState(paths.stateFile);
  if (!isAlive(state)) return "daemon is not running";
  if ((state.status === "paused") === paused) return `already ${paused ? "paused" : "running"}`;
  writeState(paths.stateFile, { status: paused ? "paused" : "running" });
  emit(paths.eventsFile, DAEMON_TRACE, paused ? "paused" : "resumed", { reason: "manual" });
  return paused ? "paused - sensors and dispatch idle" : "resumed";
}
