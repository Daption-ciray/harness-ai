import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cleanEnv } from "./env.ts";
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

/**
 * Learns what happened to the pull requests it opened.
 *
 * Without this a task sits in `escalated` for ever: its worktree is never
 * reclaimed, and — worse — `escalated` suppresses that fingerprint, so the
 * sensor which found the problem can never queue it again. A merged fix would
 * permanently blind the harness to the next occurrence of the same problem.
 */
function reconcilePullRequests(ctx: Tick, tasks: ReturnType<typeof listTasks>): void {
  const open = tasks.filter((t) => t.state === "escalated" && t.pr !== null);
  if (open.length === 0) return;

  let states: Map<number, string>;
  try {
    states = ctx.forge.prStates(ctx.paths.repoRoot);
  } catch (e) {
    // A forge that is down must not take the loop down with it.
    console.error(`could not read pull request states: ${(e as Error).message}`);
    return;
  }

  for (const task of open) {
    const state = states.get((task.pr as { number: number }).number);
    if (state === "MERGED") {
      emit(ctx.paths.eventsFile, task.id, "merge", { sha: task.pr?.url ?? "", by: "human" });
    } else if (state === "CLOSED") {
      emit(ctx.paths.eventsFile, task.id, "task_failed", {
        reason: "the pull request was closed without merging",
      });
    }
  }
}

/** How long to wait for GitHub to decide a pull request is mergeable. */
const MERGEABILITY_TIMEOUT_MS = 30 * 60_000;

/**
 * Runs the branch's own test command before anything is merged.
 *
 * The adversary reports that tests pass; that report is a model's account of
 * what it saw. Nothing reaches the default branch on an account. This is the
 * one check that is mechanical, and it is the last thing standing between an
 * automated pipeline and a broken main.
 */
function branchTestsPass(ctx: Tick, dir: string): { ok: boolean; detail: string } {
  const command = ctx.policy.repo.test_cmd;
  if (!command) return { ok: false, detail: "no test command configured; refusing to merge unverified" };
  try {
    execFileSync(command, {
      cwd: dir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(), timeout: 15 * 60_000,
    });
    return { ok: true, detail: "green" };
  } catch (e) {
    const err = e as { signal?: string; stdout?: string; stderr?: string };
    if (err.signal === "SIGTERM") return { ok: false, detail: "the test command timed out" };
    return { ok: false, detail: `tests failed: ${`${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(-300)}` };
  }
}

/**
 * Merges what the gate cleared. Every precondition must hold; any one of them
 * failing sends the change to a person rather than through.
 */
function attemptMerges(ctx: Tick, tasks: ReturnType<typeof listTasks>): void {
  for (const task of tasks.filter((t) => t.state === "awaiting_merge")) {
    if (!task.pr || !task.worktree) {
      emit(ctx.paths.eventsFile, task.id, "merge_blocked", { reason: "no pull request or worktree to merge" });
      continue;
    }

    let status: { mergeable: string; state: string; draft: boolean };
    try {
      status = ctx.forge.mergeability(ctx.paths.repoRoot, task.pr.number);
    } catch (e) {
      console.error(`could not read #${task.pr.number}: ${(e as Error).message}`);
      continue; // a forge hiccup is not a verdict
    }

    if (status.draft) {
      emit(ctx.paths.eventsFile, task.id, "merge_blocked", { reason: "the pull request is a draft" });
      continue;
    }
    if (status.mergeable !== "MERGEABLE" || !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(status.state)) {
      // UNKNOWN right after creation is normal; GitHub is still computing.
      const cleared = readAll(ctx.paths.eventsFile)
        .find((e) => e.trace_id === task.id && e.type === "merge_gate");
      const waited = cleared ? Date.now() - Date.parse(cleared.ts) : 0;
      if (waited > MERGEABILITY_TIMEOUT_MS) {
        emit(ctx.paths.eventsFile, task.id, "merge_blocked", {
          reason: `GitHub reports ${status.mergeable}/${status.state}; it has not become mergeable`,
        });
      }
      continue;
    }

    const tests = branchTestsPass(ctx, task.worktree);
    if (!tests.ok) {
      emit(ctx.paths.eventsFile, task.id, "merge_blocked", { reason: tests.detail });
      continue;
    }

    try {
      const sha = ctx.forge.mergePr(ctx.paths.repoRoot, task.pr.number);
      emit(ctx.paths.eventsFile, task.id, "merge", { sha, by: "harness" });
      console.log(`merged #${task.pr.number} (${task.id}) — tests green, no escalation rule matched`);
    } catch (e) {
      emit(ctx.paths.eventsFile, task.id, "merge_blocked", { reason: `merge failed: ${(e as Error).message}` });
    }
  }
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

  let tasks = listTasks(readAll(ctx.paths.eventsFile));
  reconcilePullRequests(ctx, tasks);
  attemptMerges(ctx, listTasks(readAll(ctx.paths.eventsFile)));
  tasks = listTasks(readAll(ctx.paths.eventsFile));
  reapWorktrees(ctx, tasks);

  const pendingHuman = tasks.filter((t) => t.state === "escalated").length;
  const active = tasks.filter((t) => isActiveState(t.state));

  // WIP limit: a full review queue stops NEW BACKGROUND work, but work already
  // in flight still finishes - otherwise tasks strand halfway with an open
  // worktree - and a person's own request is never held up by the harness's
  // backlog. Somebody asking for something is an instruction, not a suggestion;
  // the daily budget is what caps them, not this.
  const queueFull = pendingHuman >= ctx.policy.merge.max_pending_escalated;
  const pool = queueFull
    ? active.filter((t) => t.state !== "queued" || t.source === "human")
    : active;

  // Human intent first, then oldest first. A feature someone asked for should
  // not wait behind three things a sensor noticed.
  const next = [...pool].sort((a, b) =>
    Number(b.source === "human") - Number(a.source === "human")
    || a.created_at.localeCompare(b.created_at))[0];
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
