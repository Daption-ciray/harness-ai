import { join, matchesGlob } from "node:path";
import type { AgentRunner } from "./agent-runner.ts";
import {
  branchFiles, changedFiles, commitAll, diffStat, ensureWorktree, git, push,
  runWorktreeSetup, untrackedFiles,
} from "./git.ts";
import type { Forge } from "./github.ts";
import type { CommandExecutor } from "./exec.ts";
import { emit, readAll, type HarnessEvent } from "./events.ts";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { projectOne, type Task } from "./projection.ts";
import { appendDecision, loadDecisions, parseDecisions, renderContext, type Decision } from "./memory.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { SpanResult } from "./spawn.ts";
import {
  AVAILABLE_VERIFIERS, LadderExhausted, branchDiff, brief, budgetLeft, openBlockers,
  runBuilder, runDevops, runPlanner, runScribe, runVerifier, touchedPaths, wrap,
  type DevopsOutput, type PlanOutput, type ScribeOutput,
} from "./roles/run.ts";
import { classify, ladderStartFor } from "./tier.ts";
import { detectPublicApiChange, evaluateGate } from "./merge.ts";
import { resolveLease } from "./lease.ts";
import { concernsFor, currentRevision, detectStall, pendingVerifiers } from "./verify.ts";
import type { Finding } from "./domain.ts";
import type { Role } from "./policy.ts";

export type Ctx = {
  policy: Policy; paths: Paths; runner: AgentRunner; forge: Forge;
  /** Where the target repository's own commands run: host, or sandbox. */
  exec: CommandExecutor;
};


function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
}

export function branchFor(task: Task): string {
  return `harness/${task.id}-${slug(task.text)}`;
}




function fail(ctx: Ctx, task: Task, reason: string): void {
  emit(ctx.paths.eventsFile, task.id, "escalate", { reason });
  emit(ctx.paths.eventsFile, task.id, "task_failed", { reason });
}

/** A failed span climbs one rung; the ladder's last rung is a human. */
function climb(ctx: Ctx, task: Task, from: number, reason: string): void {
  emit(ctx.paths.eventsFile, task.id, "ladder_advanced", { from, to: from + 1, reason });
}

type Attempt<T> = { kind: "ok"; value: T } | { kind: "exhausted"; reason: string };

/**
 * A role whose ladder is exhausted stops the task rather than throwing through
 * the daemon. The role runner signals it; the orchestrator decides it is fatal.
 */
async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { kind: "ok", value: await run() };
  } catch (e) {
    if (e instanceof LadderExhausted) return { kind: "exhausted", reason: e.message };
    throw e;
  }
}

function spanFailure(span: SpanResult): string {
  return span.errors[0] ?? span.subtype;
}

async function plan(task: Task, ctx: Ctx): Promise<void> {
  const step = task.ladder_step;
  const run = await attempt(() => runPlanner(task, ctx));
  if (run.kind === "exhausted") return fail(ctx, task, run.reason);
  const { span, output: out } = run.value;

  if (!span.ok) return climb(ctx, task, step, spanFailure(span));
  if (!out) return climb(ctx, task, step, "planner returned no parseable JSON");
  if (out.blocked) {
    // A question is not a failure. Killing the task here would make a person
    // retype the whole request to answer one thing.
    emit(ctx.paths.eventsFile, task.id, "question_asked", { role: "planner", question: out.blocked });
    return;
  }
  if (!out.acceptance?.length || !out.scope?.length) {
    return fail(ctx, task, "planner produced no acceptance criteria or no scope — the task is underspecified");
  }

  // The class is only knowable once a scope exists, so the ladder's starting
  // rung is applied here. Otherwise a task reclassified as risky would keep
  // running the cheap rung its pre-planning guess had picked.
  const taskClass = classify(ctx.policy, { paths: out.scope, source: task.source });
  emit(ctx.paths.eventsFile, task.id, "task_planned", {
    role: "planner", task_class: taskClass, scope: out.scope,
    acceptance: out.acceptance, steps: out.steps ?? [],
    ladder_step: Math.max(step, ladderStartFor(ctx.policy, taskClass)),
  });
}

async function build(task: Task, ctx: Ctx): Promise<void> {
  const step = task.ladder_step;
  const branch = task.branch ?? branchFor(task);
  const dir = task.worktree ?? join(ctx.paths.worktreesDir, task.id);

  // Setup belongs to a fresh worktree only. On a retry the builder's own new
  // files are untracked too, and treating those as setup artifacts would
  // quietly drop the work from the commit.
  const { created } = ensureWorktree(ctx.paths.repoRoot, dir, branch, ctx.policy.repo.default_branch);
  if (created) {
    const setupError = runWorktreeSetup(dir, ctx.paths.repoRoot, ctx.policy.repo.worktree_setup_cmd, ctx.exec);
    emit(ctx.paths.eventsFile, task.id, "worktree_open", {
      branch, dir, setup_artifacts: untrackedFiles(dir), setup_error: setupError,
    });
  }
  const current = projectOne(readAll(ctx.paths.eventsFile), task.id) ?? task;
  const artifacts = current.setup_artifacts;

  const run = await attempt(() => runBuilder(current, ctx, dir));
  if (run.kind === "exhausted") return fail(ctx, current, run.reason);
  const span = run.value;

  if (!span.ok) return climb(ctx, current, step, spanFailure(span));

  const produced = changedFiles(dir).filter((f) => !artifacts.includes(f));
  if (produced.length === 0) {
    return fail(ctx, current, "builder finished without changing anything");
  }
  // Per trace, not per log: revisions belong to a task. Counting across every
  // task made the second one number its first build "2" while the gate asked
  // about "1", so a verifier that had already reported still looked pending.
  emit(ctx.paths.eventsFile, task.id, "build_done", {
    files: produced,
    revision: currentRevision(readAll(ctx.paths.eventsFile).filter((e) => e.trace_id === task.id)) + 1,
  });
}





/**
 * One verifier per call. The lease decides who goes first; `pendingVerifiers`
 * decides who must go at all. A lease that times out therefore reorders the
 * queue but can never let a required verifier be skipped.
 */
async function verify(task: Task, ctx: Ctx): Promise<void> {
  const dir = task.worktree;
  const branch = task.branch;
  if (!dir || !branch) return fail(ctx, task, "nothing to verify — the build stage left no worktree");
  const base = ctx.policy.repo.default_branch;
  const events = readAll(ctx.paths.eventsFile);

  const paths = touchedPaths(dir, base, task.setup_artifacts);
  const lease = resolveLease(events.filter((e) => e.trace_id === task.id), ctx.policy, Date.now());
  const pending = pendingVerifiers(events.filter((e) => e.trace_id === task.id),
    ctx.policy, paths, AVAILABLE_VERIFIERS, lease.holder);

  if (pending.length === 0) {
    emit(ctx.paths.eventsFile, task.id, "verified", {
      revision: task.revision, verifiers: AVAILABLE_VERIFIERS,
    });
    return;
  }

  const role = pending[0];

  emit(ctx.paths.eventsFile, task.id, "lease_acquired", {
    holder: lease.holder, reason: lease.reason, ttl_seconds: ctx.policy.runtime.lease_ttl_seconds,
  });

  const run = await attempt(() => runVerifier(role, task, ctx, dir));
  if (run.kind === "exhausted") return fail(ctx, task, run.reason);
  const { span, output: out } = run.value;

  if (!span.ok) return climb(ctx, task, task.ladder_step, spanFailure(span));
  if (!out?.verdict) return climb(ctx, task, task.ladder_step, `${role} returned no parseable verdict`);

  const findings = (out.findings ?? []).filter((f) => f?.file && f?.summary && f?.severity);
  const blockers = findings.filter((f) => f.severity === "blocker");

  // A block with no blocker is not a block. Treating it as one would let a
  // verifier stop a change without ever saying what is wrong with it.
  if (out.verdict === "block" && blockers.length > 0) {
    emit(ctx.paths.eventsFile, task.id, "veto", {
      role, revision: task.revision,
      kind: ctx.policy.veto[role]?.type ?? "soft",
      reason: blockers[0].summary,
      findings,
    });
    return;
  }

  emit(ctx.paths.eventsFile, task.id, "verdict", {
    role, revision: task.revision, findings,
    note: out.verdict === "block"
      ? `${role} said block but named no blocker; recorded as a pass with concerns`
      : (out.note ?? ""),
  });
}


/**
 * Writes the decision entry into the worktree so it merges in the same pull
 * request as the code it explains. Skipped for a quarantined change: nothing is
 * merging, so there is nothing to record as merged.
 *
 * `scribe` returns the entry; the harness writes the file. Memory has exactly
 * one writer for the same reason git does — enforced structurally rather than by
 * trusting a role to stay in its lane. It is also why `.harness/**` is in
 * never_edit: no agent can reach this file, including the one that authors it.
 */
async function scribe(task: Task, ctx: Ctx): Promise<void> {
  const dir = task.worktree;
  const base = ctx.policy.repo.default_branch;
  if (!dir) return fail(ctx, task, "nothing to record — the build stage left no worktree");

  const changed = touchedPaths(dir, base, task.setup_artifacts);
  const onRecord = parseDecisions(loadDecisions(ctx.paths.decisionsFile));

  const run = await attempt(() => runScribe(task, ctx, dir));
  if (run.kind === "exhausted") return fail(ctx, task, run.reason);
  const { span, output: out } = run.value;

  if (!span.ok) return climb(ctx, task, task.ladder_step, spanFailure(span));
  if (!out?.title || !out?.why) {
    return climb(ctx, task, task.ladder_step, "scribe returned no parseable entry");
  }

  // Claims are checked against the tree before they become memory. Writing a
  // hallucination into a permanent record is the most expensive kind of mistake
  // this system can make, because everything downstream then believes it.
  const claimed = (out.anchors ?? []).map((a) => a.trim()).filter(Boolean);
  const verified = claimed.filter((a) => changed.includes(a.split(":")[0]));
  if (claimed.length > 0 && verified.length === 0) {
    emit(ctx.paths.eventsFile, task.id, "flag", {
      kind: "unverified_anchors",
      detail: `scribe named ${JSON.stringify(claimed)}, none of which is in this change`,
    });
  }
  const anchors = verified.length ? verified : changed;

  if (out.contradicts && onRecord.some((d) => d.id === out.contradicts)) {
    // Visibility, not authority: scribe has no veto, so this is a note a human
    // and the planner will see, not a block.
    emit(ctx.paths.eventsFile, task.id, "flag", {
      kind: "contradiction",
      detail: `${task.id} overturns ${out.contradicts}: ${out.title}`,
    });
  }

  const decision: Decision = {
    id: task.id, title: out.title, anchors,
    body: out.why, constraint: out.constraint?.trim() || null,
  };
  // A repository can reach this point without the file: `harness init` creates
  // it, but it can be deleted, and losing a decision because a directory was
  // missing would be a poor trade.
  const file = join(dir, relative(ctx.paths.repoRoot, ctx.paths.decisionsFile));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, appendDecision(loadDecisions(file), decision), "utf8");

  emit(ctx.paths.eventsFile, task.id, "decision_written", {
    title: decision.title, anchors: decision.anchors, constraint: decision.constraint,
  });
}

/** Files the builder touched that the plan did not authorise. */
/** Merges of harness pull requests so far, which is how autonomy is earned. */
export function mergeCount(events: ReturnType<typeof readAll>): number {
  return events.filter((e) => e.type === "merge").length;
}

export function scopeViolations(files: string[], scope: string[]): string[] {
  return files.filter((f) => !scope.some((g) => matchesGlob(f, g)));
}

async function integrate(task: Task, ctx: Ctx): Promise<void> {
  const dir = task.worktree;
  const branch = task.branch;
  if (!dir || !branch) return fail(ctx, task, "no worktree to integrate — the build stage left no branch");
  const base = ctx.policy.repo.default_branch;

  // devops judges what the pull request will contain: the whole branch, not
  // just what is still uncommitted. A re-run has already committed part of the
  // work, and showing only the working tree makes that part look missing.
  const pending = changedFiles(dir).filter((f) => !task.setup_artifacts.includes(f));
  const files = [...new Set([...branchFiles(dir, base), ...pending])];
  const violations = scopeViolations(files, task.scope)
    .filter((f) => f !== relative(ctx.paths.repoRoot, ctx.paths.decisionsFile));
  const diff = [
    git(["diff", "--stat", `${base}...HEAD`], dir),
    git(["diff", `${base}...HEAD`], dir).slice(0, 15000),
    pending.length ? `\n--- not yet committed ---\n${git(["diff"], dir).slice(0, 5000)}` : "",
  ].filter(Boolean).join("\n\n");

  const run = await attempt(() => runDevops(task, ctx, dir, violations));
  if (run.kind === "exhausted") return fail(ctx, task, run.reason);
  const { span, output: out } = run.value;
  if (!out?.commit_message) {
    return climb(ctx, task, task.ladder_step, span.ok ? "devops returned no commit message" : spanFailure(span));
  }

  // Everything the builder produced is committed, including what fell outside
  // the declared scope.
  //
  // Trimming the out-of-scope files looked like enforcement and was worse than
  // no enforcement: on the first unattended run the planner left the test
  // directory out of scope, the builder wrote tests as it is told to, and they
  // were dropped — producing a pull request with the feature and none of its
  // tests. A partial commit is a lie about what was written. Scope creep is
  // surfaced instead: reported as a concern, and the pull request stays a draft
  // so a person decides whether the extra file belongs.
  const sha = commitAll(dir, out.commit_message, pending);
  push(dir, branch);

  const stat = diffStat(dir, base);
  const concerns = [
    ...concernsFor(readAll(ctx.paths.eventsFile), task.revision),
    ...(out.concerns ?? []),
    ...violations.map((v) => `outside declared scope: ${v}`),
  ];
  // A hard veto never merges and never silently disappears: the pull request
  // still opens, as a draft, so the finding reaches a human with the code.
  const ready = !task.quarantined && out.ready !== false && violations.length === 0;
  const body = prBody(task, concerns, stat, hardVetoFindings(readAll(ctx.paths.eventsFile)));

  const pr = ctx.forge.createPr(dir, { branch, base, title: out.pr_title ?? out.commit_message, body, draft: !ready });
  ctx.forge.addLabels(dir, pr.number, ready
    ? ["harness", "needs:human"]
    : ["harness", task.quarantined ? "blocked:security" : "blocked:devops"]);

  emit(ctx.paths.eventsFile, task.id, "pr_opened", {
    number: pr.number, url: pr.url, draft: !ready, sha,
    files: stat.files, lines: stat.lines,
  });

  // A draft never merges itself: devops or a scope violation parked it, and
  // parking it means a person looks.
  const gate = ready
    ? evaluateGate(ctx.policy, task, readAll(ctx.paths.eventsFile), {
      files, diffLines: stat.lines,
      mergesSoFar: mergeCount(readAll(ctx.paths.eventsFile)),
      publicApiChange: detectPublicApiChange(git(["diff", `${base}...HEAD`], dir)),
    })
    : { escalate: true, reasons: ["the pull request is a draft"] };

  emit(ctx.paths.eventsFile, task.id, "merge_gate", gate);
  if (gate.escalate) {
    emit(ctx.paths.eventsFile, task.id, "escalate", { reason: gate.reasons.join("; ") });
  }
}

/** Blockers from a hard veto, which lead the pull request rather than trailing it. */
export function hardVetoFindings(events: ReturnType<typeof readAll>): Finding[] {
  return events
    .filter((e) => e.type === "veto" && e.kind === "hard")
    .flatMap((e) => (e as Extract<HarnessEvent, { type: "veto" }>).findings)
    .filter((f) => f.severity === "blocker");
}

export function prBody(
  task: Task, concerns: string[], stat: { files: number; lines: number }, blockers: Finding[] = [],
): string {
  return [
    ...(task.quarantined
      ? [
        `> **Quarantined by \`security\`.** This change does not merge until a human`,
        `> releases it. The findings below are hard vetoes, not suggestions.`, ``,
        ...blockers.map((f) => `- **${f.file}${f.line ? `:${f.line}` : ""}** — ${f.summary}`), ``,
      ]
      : []),
    `## What`, task.text, ``,
    `## Why`, `Backlog item \`${task.id}\` — origin ${task.origin}, source ${task.source}, class ${task.task_class}.`, ``,
    `## Acceptance criteria`, ...task.acceptance.map((a) => `- ${a}`), ``,
    `## Unresolved`, concerns.length ? concerns.map((c) => `- ${c}`).join("\n") : "- none reported", ``,
    `## Risk`, `${stat.files} files, ${stat.lines} lines. Spend on this task: $${task.cost_usd.toFixed(4)}.`, ``,
    `---`, `Opened by harness-ai. Trace \`${task.id}\` — \`harness trace ${task.id}\`.`,
  ].join("\n");
}

/**
 * Advances one task by exactly one stage. Every stage writes events and nothing
 * else; the returned task is re-derived from the log, so what the caller sees is
 * what a fresh process would reconstruct.
 */
export async function advance(task: Task, ctx: Ctx): Promise<Task> {
  const reread = (): Task => projectOne(readAll(ctx.paths.eventsFile), task.id) ?? task;

  // The daily rail lives in the daemon, which is the thing that can actually
  // stop. Keeping a second copy here would give two places to drift.
  if (budgetLeft(ctx, task) <= 0) {
    emit(ctx.paths.eventsFile, task.id, "budget_pause", {
      spent_usd: task.cost_usd, limit_usd: ctx.policy.budget.per_task_usd, window: "task",
    });
    fail(ctx, task, `task budget of $${ctx.policy.budget.per_task_usd.toFixed(2)} is spent`);
    return reread();
  }

  // Before any stage, not just before verification: a veto returns the task to
  // the builder, so a check placed at the verify step would pay for another
  // build before noticing the loop had stopped converging.
  const stall = detectStall(readAll(ctx.paths.eventsFile).filter((e) => e.trace_id === task.id), ctx.policy);
  if (stall) {
    emit(ctx.paths.eventsFile, task.id, "stalled", stall);
    emit(ctx.paths.eventsFile, task.id, "escalate", { reason: `${stall.kind}: ${stall.detail}` });
    return reread();
  }

  switch (task.state) {
    case "queued": await plan(task, ctx); break;
    case "planned": await build(task, ctx); break;
    case "verifying": await verify(task, ctx); break;
    case "scribing": await scribe(task, ctx); break;
    case "integrating": await integrate(task, ctx); break;
    default: break;
  }
  return reread();
}

/** Appends a task to the log. There is no separate backlog store to keep in step. */
export function addBacklog(
  eventsFile: string,
  id: string,
  input: { text: string; origin: "trusted" | "untrusted"; source: string; fingerprint?: string },
): HarnessEvent {
  return emit(eventsFile, id, "backlog_add", {
    ...input,
    // A human asking twice means they want it twice.
    fingerprint: input.fingerprint ?? `${input.source}:${id}`,
  });
}
