import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AgentRunner } from "./agent-runner.ts";
import { costBasis, costLabel } from "./billing.ts";
import type { Origin } from "./domain.ts";
import { emit, readAll } from "./events.ts";
import type { CommandExecutor } from "./exec.ts";
import {
  branchFiles, changedFiles, commitAll, diffStat, ensureWorktree, git, push,
  runWorktreeSetup, untrackedFiles,
} from "./git.ts";
import type { Forge } from "./github.ts";
import { resolveLease, resolveOwner } from "./lease.ts";
import { appendDecision, loadDecisions, parseDecisions, type Decision } from "./memory.ts";
import { detectPublicApiChange, evaluateGate } from "./merge.ts";
import type { Paths } from "./paths.ts";
import type { Policy, Role } from "./policy.ts";
import { addBacklog, branchFor, mergeCount, prBody, scopeViolations } from "./pipeline.ts";
import { listTasks, nextTaskId, projectOne, type Task } from "./projection.ts";
import {
  AVAILABLE_VERIFIERS, runBuilder, runDevops, runPlanner, runScribe, runVerifier,
  touchedPaths, type RoleCtx,
} from "./roles/run.ts";
import { classify, ladderStartFor } from "./tier.ts";
import { concernsFor, currentRevision, detectStall, pendingVerifiers } from "./verify.ts";

/**
 * The capability surface an external flow drives.
 *
 * The split is deliberate: the caller owns SEQUENCING — which step comes next,
 * what to branch on, when to ask a person — and this owns SEMANTICS. Anything
 * that must not be skippable lives on this side of the line: the sandbox and
 * permission screen inside every role call, git having one writer, and the merge
 * gate. A flow cannot merge by wiring around the gate, because merging is only
 * reachable through the endpoint that evaluates it.
 *
 * Every endpoint records itself in the same event log the built-in pipeline
 * writes, so `harness trace`, `stats` and `digest` keep working whoever is
 * driving.
 */
export type ServerDeps = {
  policy: Policy;
  paths: Paths;
  runner: AgentRunner;
  forge: Forge;
  exec: CommandExecutor;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * A local API that rewrites a git repository and spends an allowance is not
 * something to leave open. The token is generated once and kept in the sidecar,
 * out of the repository, and compared in constant time.
 */
export function loadToken(paths: Paths): string {
  const file = join(paths.sidecar, "api-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function authorised(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "body is not valid JSON");
  }
}

function roleCtx(deps: ServerDeps): RoleCtx {
  return { policy: deps.policy, paths: deps.paths, runner: deps.runner, exec: deps.exec };
}

function taskOr404(deps: ServerDeps, id: string): Task {
  const task = projectOne(readAll(deps.paths.eventsFile), id);
  if (!task) throw new ApiError(404, `no such task: ${id}`);
  return task;
}

function worktreeOr409(task: Task): { dir: string; branch: string } {
  if (!task.worktree || !task.branch) {
    throw new ApiError(409, `${task.id} has no worktree yet — POST /v1/tasks/${task.id}/worktree first`);
  }
  return { dir: task.worktree, branch: task.branch };
}

/** Re-read after acting, so a caller always sees what a fresh process would. */
function reread(deps: ServerDeps, id: string): Task {
  return projectOne(readAll(deps.paths.eventsFile), id) as Task;
}

type Handler = (deps: ServerDeps, params: string[], body: Record<string, unknown>) => Promise<unknown>;

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [];
function route(method: string, pattern: RegExp, handler: Handler): void {
  ROUTES.push({ method, pattern, handler });
}

// ── read ────────────────────────────────────────────────────────────────────

route("GET", /^\/v1\/health$/, async (deps) => ({
  ok: true,
  slug: deps.paths.slug,
  repo: deps.paths.repoRoot,
  merge_auto: deps.policy.merge.auto,
  sandbox: deps.policy.runtime.sandbox,
  cost_basis: costBasis(),
  cost_note: costLabel(costBasis()),
  verifiers: AVAILABLE_VERIFIERS,
}));

route("GET", /^\/v1\/tasks$/, async (deps) => listTasks(readAll(deps.paths.eventsFile)));
route("GET", /^\/v1\/tasks\/([\w.-]+)$/, async (deps, [id]) => taskOr404(deps, id));

route("GET", /^\/v1\/events$/, async (deps) => readAll(deps.paths.eventsFile));

/** Which role policy routes these paths to. The flow branches on it. */
route("GET", /^\/v1\/routing$/, async (deps, _p, body) => {
  const paths = String((body.paths as string) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return resolveOwner(deps.policy, { paths });
});

/** Who still owes a verdict on the current revision, lease holder first. */
route("GET", /^\/v1\/tasks\/([\w.-]+)\/verifiers$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const events = readAll(deps.paths.eventsFile).filter((e) => e.trace_id === id);
  const { dir } = worktreeOr409(task);
  const paths = touchedPaths(dir, deps.policy.repo.default_branch, task.setup_artifacts);
  const lease = resolveLease(events, deps.policy, Date.now());
  return {
    revision: currentRevision(events),
    lease,
    pending: pendingVerifiers(events, deps.policy, paths, AVAILABLE_VERIFIERS, lease.holder),
    stall: detectStall(events, deps.policy),
  };
});

// ── task lifecycle ──────────────────────────────────────────────────────────

route("POST", /^\/v1\/tasks$/, async (deps, _p, body) => {
  const text = String(body.text ?? "").trim();
  if (!text) throw new ApiError(400, "text is required");
  const events = readAll(deps.paths.eventsFile);
  const id = nextTaskId(events);
  addBacklog(deps.paths.eventsFile, id, {
    text,
    origin: (body.origin as Origin) ?? "trusted",
    source: String(body.source ?? "api"),
    fingerprint: body.fingerprint ? String(body.fingerprint) : undefined,
  });
  return reread(deps, id);
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/cancel$/, async (deps, [id], body) => {
  const task = taskOr404(deps, id);
  emit(deps.paths.eventsFile, id, "task_failed", {
    reason: `cancelled: ${String(body.reason ?? "no reason given")}`,
  });
  return reread(deps, task.id);
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/answer$/, async (deps, [id], body) => {
  const task = taskOr404(deps, id);
  const pending = task.exchanges.find((e) => e.answer === null);
  if (!pending) throw new ApiError(409, `${id} is not waiting on an answer (it is ${task.state})`);
  const answer = String(body.answer ?? "").trim();
  if (!answer) throw new ApiError(400, "answer is required");
  emit(deps.paths.eventsFile, id, "question_answered", { question: pending.question, answer });
  return reread(deps, id);
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/fail$/, async (deps, [id], body) => {
  taskOr404(deps, id);
  emit(deps.paths.eventsFile, id, "task_failed", { reason: String(body.reason ?? "no reason given") });
  return reread(deps, id);
});

// ── roles ───────────────────────────────────────────────────────────────────

route("POST", /^\/v1\/tasks\/([\w.-]+)\/plan$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const { span, output } = await runPlanner(task, roleCtx(deps));
  if (!span.ok || !output) {
    return { ok: false, reason: span.errors[0] ?? "planner returned no parseable JSON", cost_usd: span.costUsd };
  }
  if (output.blocked) {
    emit(deps.paths.eventsFile, id, "question_asked", { role: "planner", question: output.blocked });
    return { ok: false, blocked: output.blocked, task: reread(deps, id), cost_usd: span.costUsd };
  }
  if (!output.acceptance?.length || !output.scope?.length) {
    return { ok: false, reason: "no acceptance criteria or no scope — the task is underspecified", cost_usd: span.costUsd };
  }
  const taskClass = classify(deps.policy, { paths: output.scope, source: task.source });
  emit(deps.paths.eventsFile, id, "task_planned", {
    role: "planner", task_class: taskClass, scope: output.scope,
    acceptance: output.acceptance, steps: output.steps ?? [],
    ladder_step: Math.max(task.ladder_step, ladderStartFor(deps.policy, taskClass)),
  });
  return { ok: true, task: reread(deps, id), cost_usd: span.costUsd };
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/worktree$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const branch = task.branch ?? branchFor(task);
  const dir = task.worktree ?? join(deps.paths.worktreesDir, task.id);
  const { created } = ensureWorktree(deps.paths.repoRoot, dir, branch, deps.policy.repo.default_branch);
  if (created) {
    const setupError = runWorktreeSetup(dir, deps.paths.repoRoot, deps.policy.repo.worktree_setup_cmd, deps.exec);
    emit(deps.paths.eventsFile, id, "worktree_open", {
      branch, dir, setup_artifacts: untrackedFiles(dir), setup_error: setupError,
    });
  }
  return { dir, branch, created, task: reread(deps, id) };
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/build$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const { dir } = worktreeOr409(task);
  const span = await runBuilder(task, roleCtx(deps), dir);
  if (!span.ok) return { ok: false, reason: span.errors[0] ?? span.subtype, cost_usd: span.costUsd };

  const produced = changedFiles(dir).filter((f) => !task.setup_artifacts.includes(f));
  if (produced.length === 0) {
    return { ok: false, reason: "builder finished without changing anything", cost_usd: span.costUsd };
  }
  // Per trace, not per log: a revision belongs to a task.
  emit(deps.paths.eventsFile, id, "build_done", {
    files: produced,
    revision: currentRevision(readAll(deps.paths.eventsFile).filter((e) => e.trace_id === id)) + 1,
  });
  return { ok: true, files: produced, task: reread(deps, id), cost_usd: span.costUsd };
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/verify$/, async (deps, [id], body) => {
  const task = taskOr404(deps, id);
  const { dir } = worktreeOr409(task);
  const role = String(body.role ?? "") as Role;
  if (!AVAILABLE_VERIFIERS.includes(role)) {
    throw new ApiError(400, `role must be one of ${AVAILABLE_VERIFIERS.join(", ")}`);
  }
  const base = deps.policy.repo.default_branch;
  const violations = scopeViolations(touchedPaths(dir, base, task.setup_artifacts), task.scope);

  const { span, output } = await runVerifier(role, task, roleCtx(deps), dir, violations);
  if (!span.ok || !output?.verdict) {
    return { ok: false, reason: span.errors[0] ?? `${role} returned no parseable verdict`, cost_usd: span.costUsd };
  }

  const findings = (output.findings ?? []).filter((f) => f?.file && f?.summary && f?.severity);
  const blockers = findings.filter((f) => f.severity === "blocker");

  // A block with no blocker is not a block: it would stop a change without
  // saying what is wrong with it, leaving the builder nothing to act on.
  if (output.verdict === "block" && blockers.length > 0) {
    emit(deps.paths.eventsFile, id, "veto", {
      role, revision: task.revision,
      kind: deps.policy.veto[role]?.type ?? "soft",
      reason: blockers[0].summary, findings,
    });
    return { ok: true, verdict: "block", findings, task: reread(deps, id), cost_usd: span.costUsd };
  }
  emit(deps.paths.eventsFile, id, "verdict", {
    role, revision: task.revision, findings,
    note: output.verdict === "block"
      ? `${role} said block but named no blocker; recorded as a pass with concerns`
      : (output.note ?? ""),
  });
  return { ok: true, verdict: "pass", findings, task: reread(deps, id), cost_usd: span.costUsd };
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/verified$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  emit(deps.paths.eventsFile, id, "verified", {
    revision: task.revision, verifiers: AVAILABLE_VERIFIERS,
  });
  return reread(deps, id);
});

route("POST", /^\/v1\/tasks\/([\w.-]+)\/scribe$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const { dir } = worktreeOr409(task);
  const base = deps.policy.repo.default_branch;
  const changed = touchedPaths(dir, base, task.setup_artifacts);
  const onRecord = parseDecisions(loadDecisions(deps.paths.decisionsFile));

  const { span, output } = await runScribe(task, roleCtx(deps), dir);
  if (!span.ok || !output?.title || !output?.why) {
    return { ok: false, reason: span.errors[0] ?? "scribe returned no parseable entry", cost_usd: span.costUsd };
  }

  // Claims are checked against the tree before they become memory.
  const claimed = (output.anchors ?? []).map((a) => a.trim()).filter(Boolean);
  const verified = claimed.filter((a) => changed.includes(a.split(":")[0]));
  if (claimed.length > 0 && verified.length === 0) {
    emit(deps.paths.eventsFile, id, "flag", {
      kind: "unverified_anchors",
      detail: `scribe named ${JSON.stringify(claimed)}, none of which is in this change`,
    });
  }
  if (output.contradicts && onRecord.some((d) => d.id === output.contradicts)) {
    emit(deps.paths.eventsFile, id, "flag", {
      kind: "contradiction",
      detail: `${id} overturns ${output.contradicts}: ${output.title}`,
    });
  }

  const decision: Decision = {
    id, title: output.title, anchors: verified.length ? verified : changed,
    body: output.why, constraint: output.constraint?.trim() || null,
  };
  const file = join(dir, relative(deps.paths.repoRoot, deps.paths.decisionsFile));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, appendDecision(loadDecisions(file), decision), "utf8");

  emit(deps.paths.eventsFile, id, "decision_written", {
    title: decision.title, anchors: decision.anchors, constraint: decision.constraint,
  });
  return { ok: true, decision, task: reread(deps, id), cost_usd: span.costUsd };
});

/** Judgement only. Committing and opening the pull request is `/integrate`. */
route("POST", /^\/v1\/tasks\/([\w.-]+)\/devops$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  const { dir } = worktreeOr409(task);
  const base = deps.policy.repo.default_branch;
  const violations = scopeViolations(touchedPaths(dir, base, task.setup_artifacts), task.scope);

  const { span, output } = await runDevops(task, roleCtx(deps), dir, violations);
  if (!span.ok || !output?.commit_message) {
    return { ok: false, reason: span.errors[0] ?? "devops returned no commit message", cost_usd: span.costUsd };
  }
  return { ok: true, ...output, violations, cost_usd: span.costUsd };
});

// ── git, pull request, merge ────────────────────────────────────────────────

route("POST", /^\/v1\/tasks\/([\w.-]+)\/integrate$/, async (deps, [id], body) => {
  const task = taskOr404(deps, id);
  const { dir, branch } = worktreeOr409(task);
  const base = deps.policy.repo.default_branch;
  const message = String(body.commit_message ?? "").trim();
  if (!message) throw new ApiError(400, "commit_message is required");

  const decisionPath = relative(deps.paths.repoRoot, deps.paths.decisionsFile);
  const pending = changedFiles(dir).filter((f) => !task.setup_artifacts.includes(f));
  const files = [...new Set([...branchFiles(dir, base), ...pending])];
  const violations = scopeViolations(files, task.scope).filter((f) => f !== decisionPath);

  // Everything the builder produced is committed, out-of-scope files included:
  // a partial commit is a lie about what was written. Scope creep is surfaced
  // instead, and it parks the pull request.
  const sha = commitAll(dir, message, pending);
  push(dir, branch);

  const stat = diffStat(dir, base);
  const concerns = [
    ...concernsFor(readAll(deps.paths.eventsFile), task.revision),
    ...((body.concerns as string[]) ?? []),
    ...violations.map((v) => `outside declared scope: ${v}`),
  ];
  const ready = body.ready !== false && violations.length === 0 && !task.quarantined;
  const pr = deps.forge.createPr(dir, {
    branch, base,
    title: String(body.pr_title ?? message),
    body: prBody(task, concerns, stat),
    draft: !ready,
  });
  deps.forge.addLabels(dir, pr.number, ready
    ? ["harness", "needs:human"]
    : ["harness", task.quarantined ? "blocked:security" : "blocked:devops"]);

  emit(deps.paths.eventsFile, id, "pr_opened", {
    number: pr.number, url: pr.url, draft: !ready, sha, files: stat.files, lines: stat.lines,
  });

  const gate = ready
    ? evaluateGate(deps.policy, task, readAll(deps.paths.eventsFile), {
      files, diffLines: stat.lines,
      mergesSoFar: mergeCount(readAll(deps.paths.eventsFile)),
      publicApiChange: detectPublicApiChange(git(["diff", `${base}...HEAD`], dir)),
    })
    : { escalate: true, reasons: ["the pull request is a draft"] };

  emit(deps.paths.eventsFile, id, "merge_gate", gate);
  if (gate.escalate) emit(deps.paths.eventsFile, id, "escalate", { reason: gate.reasons.join("; ") });

  return { pr, gate, violations, files: stat.files, lines: stat.lines, task: reread(deps, id) };
});

/**
 * The one way a change reaches the default branch. Every precondition is
 * evaluated here, so no arrangement of flow steps can route around them.
 */
route("POST", /^\/v1\/tasks\/([\w.-]+)\/merge$/, async (deps, [id]) => {
  const task = taskOr404(deps, id);
  if (!task.pr) throw new ApiError(409, `${id} has no pull request`);
  const { dir } = worktreeOr409(task);

  const blocked = (reason: string) => {
    emit(deps.paths.eventsFile, id, "merge_blocked", { reason });
    return { ok: false, reason, task: reread(deps, id) };
  };

  if (task.state !== "awaiting_merge") {
    return blocked(`${id} is ${task.state}, not cleared to merge`);
  }
  const status = deps.forge.mergeability(deps.paths.repoRoot, task.pr.number);
  if (status.draft) return blocked("the pull request is a draft");
  if (status.mergeable !== "MERGEABLE" || !["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(status.state)) {
    return { ok: false, retry: true, reason: `GitHub reports ${status.mergeable}/${status.state}` };
  }

  // The verifiers' report that tests pass is a model's account. Nothing reaches
  // the default branch on an account.
  const command = deps.policy.repo.test_cmd;
  if (!command) return blocked("no test command configured; refusing to merge unverified");
  const result = deps.exec({ cwd: dir, command, timeoutMs: 15 * 60_000 });
  if (!result.ok) {
    return blocked(result.timedOut ? "the test command timed out" : `tests failed: ${result.output.slice(-300)}`);
  }

  const sha = deps.forge.mergePr(deps.paths.repoRoot, task.pr.number);
  emit(deps.paths.eventsFile, id, "merge", { sha, by: "harness" });
  return { ok: true, sha, task: reread(deps, id) };
});

// ── plumbing ────────────────────────────────────────────────────────────────

export function createServer(deps: ServerDeps, token: string): Server {
  return createHttpServer(async (request, response) => {
    const send = (status: number, payload: unknown) => {
      const text = JSON.stringify(payload, null, 2);
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(text);
    };

    try {
      if (!authorised(request, token)) return send(401, { error: "bad or missing bearer token" });

      const url = new URL(request.url ?? "/", "http://local");
      const match = ROUTES.find((r) =>
        r.method === (request.method ?? "GET") && r.pattern.test(url.pathname));
      if (!match) return send(404, { error: `no route for ${request.method} ${url.pathname}` });

      const params = (url.pathname.match(match.pattern) ?? []).slice(1);
      const body = request.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : await readJson(request);

      send(200, await match.handler(deps, params, body));
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      send(500, { error: (e as Error).message });
    }
  });
}
