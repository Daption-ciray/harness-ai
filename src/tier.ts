import { matchesGlob } from "node:path";
import type { Policy, Role } from "./policy.ts";
import type { Tier } from "./spawn.ts";

export type TaskClass = "trivial" | "routine" | "risky";

/**
 * A scope entry may be a concrete path (`package.json`) or a glob prefix
 * (`src/auth/**`). Probe the prefix so `src/auth/**` still matches `**\/auth/**`.
 */
function entryMatches(entry: string, pattern: string): boolean {
  if (matchesGlob(entry, pattern)) return true;
  if (!entry.includes("*")) return false;
  const probe = entry.replace(/\*+$/, "").replace(/\/+$/, "") + "/__probe__";
  return matchesGlob(probe, pattern);
}

function anyMatch(paths: string[], patterns: string[]): boolean {
  return paths.some((p) => patterns.some((g) => entryMatches(p, g)));
}

/**
 * Deterministic: file globs, source, file count. No model is asked which model
 * to use — the decision itself has to be free. Ties resolve toward `risky`.
 */
export function classify(
  policy: Policy,
  input: { paths: string[]; source?: string; fileCount?: number },
): TaskClass {
  const { risky, trivial } = policy.task_class;
  if (anyMatch(input.paths, risky.match)) return "risky";
  if (input.source && risky.source.includes(input.source)) return "risky";

  const countOk = trivial.max_files === undefined
    || (input.fileCount ?? input.paths.length) <= trivial.max_files;
  const trivialBySource = input.source !== undefined && trivial.source.includes(input.source);
  const trivialByPath = input.paths.length > 0
    && input.paths.every((p) => trivial.match.some((g) => entryMatches(p, g)));
  if (countOk && (trivialByPath || trivialBySource)) return "trivial";

  return "routine";
}

export function ladderStartFor(policy: Policy, cls: TaskClass): number {
  return policy.ladder_start[cls] ?? 0;
}

export type TierResolution =
  | { kind: "tier"; tier: Tier; ladderStep: number }
  | { kind: "escalate"; ladderStep: number };

/**
 * Role baseline, then the ladder rung, then the class override. `never_downgrade`
 * roles keep their baseline model whatever the ladder says — security never runs
 * on a cheaper model to save money.
 */
export function resolveTier(policy: Policy, role: Role, cls: TaskClass, ladderStep: number): TierResolution {
  const base = policy.roles[role];
  const step = policy.escalation_ladder[Math.min(ladderStep, policy.escalation_ladder.length - 1)];
  if (step.escalate_to_human) return { kind: "escalate", ladderStep };

  const override = policy.task_class[cls].override ?? {};
  const tier: Tier = {
    model: base.never_downgrade ? base.model : (override.model ?? step.model ?? base.model),
    effort: base.never_downgrade ? base.effort : (override.effort ?? step.effort ?? base.effort),
    maxTurns: base.maxTurns,
  };
  return { kind: "tier", tier, ladderStep };
}
