import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ROLES = [
  "planner", "builder", "adversary", "review", "security", "devops", "scribe",
] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_OWNER: Role = "planner";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const Effort = z.enum(EFFORTS);
const TaskClass = z.enum(["trivial", "routine", "risky"]);
const Origin = z.enum(["trusted", "untrusted"]);

/**
 * `preempt` lives on the role, not on a routing entry: only one role ever
 * preempts, and the lease scheduler reads it as a role property.
 */
const RoleTier = z.object({
  model: z.string(),
  effort: Effort,
  maxTurns: z.number().int().positive(),
  tools: z.array(z.string()).optional(),
  never_downgrade: z.boolean().default(false),
  preempt: z.boolean().default(false),
});

const LadderStep = z.object({
  model: z.string().optional(),
  effort: Effort.optional(),
  include_adversary_report: z.boolean().default(false),
  escalate_to_human: z.boolean().default(false),
});

const TaskClassRule = z.object({
  match: z.array(z.string()).default([]),
  source: z.array(z.string()).default([]),
  max_files: z.number().int().positive().optional(),
  override: z.object({ model: z.string().optional(), effort: Effort.optional() }).optional(),
});

const RoutingRule = z.object({
  match: z.string().optional(),
  on: z.string().optional(),
  default: z.boolean().default(false),
  owner: z.enum(ROLES),
});

const VetoRule = z.object({
  type: z.enum(["hard", "soft"]),
  max_rounds: z.number().int().positive().optional(),
});

const EscalateRule = z.object({
  first_n_merges: z.number().int().nonnegative().optional(),
  origin: Origin.optional(),
  task_class: TaskClass.optional(),
  security_finding: z.literal("any").optional(),
  review_rounds: z.string().optional(),
  diff_files: z.string().optional(),
  diff_lines: z.string().optional(),
  public_api_change: z.boolean().optional(),
  acceptance_unmet: z.literal("any").optional(),
  path_touched: z.string().optional(),
});

const Sensor = z.object({
  enabled: z.boolean(),
  every: z.string(),
  origin: Origin,
});

export const PolicySchema = z.object({
  version: z.literal(1),

  repo: z.object({
    default_branch: z.string().default("main"),
    test_cmd: z.string(),
    build_cmd: z.string().optional(),
    lint_cmd: z.string().optional(),
    /** Run once in each fresh worktree. `$HARNESS_REPO_ROOT` points at the main checkout. */
    worktree_setup_cmd: z.string().optional(),
  }),

  runtime: z.object({
    sandbox: z.enum(["none", "container"]).default("none"),
    max_concurrent_builders: z.number().int().positive().default(4),
    tick_seconds: z.number().int().positive().default(60),
    lease_ttl_seconds: z.number().int().positive().default(900),
  }),

  roles: z.object({
    planner: RoleTier, builder: RoleTier, adversary: RoleTier,
    review: RoleTier, security: RoleTier, devops: RoleTier, scribe: RoleTier,
  }),

  escalation_ladder: z.array(LadderStep).min(1),
  ladder_start: z.record(TaskClass, z.number().int().nonnegative()),

  task_class: z.object({
    risky: TaskClassRule, trivial: TaskClassRule, routine: TaskClassRule,
  }),

  routing: z.array(RoutingRule).min(1),
  /** Only roles that actually hold a veto need an entry. */
  veto: z.object({
    planner: VetoRule, builder: VetoRule, adversary: VetoRule,
    review: VetoRule, security: VetoRule, devops: VetoRule, scribe: VetoRule,
  }).partial(),

  budget: z.object({
    per_task_usd: z.number().positive(),
    per_day_usd: z.number().positive(),
    on_exceed: z.enum(["pause", "notify"]).default("pause"),
  }),

  merge: z.object({
    auto: z.boolean(),
    max_pending_escalated: z.number().int().positive().default(3),
    escalate_when: z.array(EscalateRule).default([]),
  }),

  sensors: z.record(z.string(), Sensor),

  permissions: z.object({
    deny_all_roles: z.array(z.string()).default([]),
    git_allowed_for: z.array(z.enum(ROLES)).default(["devops"]),
    never_edit: z.array(z.string()).default([]),
    write_scope: z.enum(["repo_only"]).default("repo_only"),
    network_allowlist: z.array(z.string()).default([]),
  }),
});

export type Policy = z.infer<typeof PolicySchema>;

export class PolicyError extends Error {}

export function parsePolicy(text: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new PolicyError(`policy.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new PolicyError(`policy.yaml failed validation:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function loadPolicy(file: string): Policy {
  if (!existsSync(file)) {
    throw new PolicyError(`no policy at ${file} - run \`harness init\` first`);
  }
  return parsePolicy(readFileSync(file, "utf8"));
}

/** The one role allowed to preempt, derived rather than hardcoded twice. */
export function preemptingRoles(policy: Policy): Role[] {
  return ROLES.filter((r) => policy.roles[r].preempt);
}
