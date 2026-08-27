import type { HookCallbackMatcher, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { append } from "./events.ts";
import type { Policy, Role } from "./policy.ts";

/** Commands that reach `git`/`gh` however they are dressed up. */
const GIT_LIKE = /(^|[\s;&|(`$])(git|gh|gh-axi)(\s|$)/;

export type GuardContext = {
  role: Role;
  traceId: string;
  spanId: string;
  eventsFile: string;
  policy: Policy;
};

export type Denial = { tool: string; reason: string; input: unknown };

/**
 * Phase 1 guard: only `devops` may run git or gh. Every other role writes files
 * and nothing else, so branch/commit/push has exactly one writer and the
 * index.lock race cannot happen.
 *
 * ponytail: PreToolUse only, and only the git/gh rule. Phase 3 adds the rest of
 * `permissions.deny_all_roles`, never_edit, and the network allowlist here.
 */
export function bashCommandDenial(ctx: GuardContext, command: string): string | null {
  const gitAllowed = ctx.policy.permissions.git_allowed_for.includes(ctx.role);
  if (!gitAllowed && GIT_LIKE.test(command)) {
    return `role \`${ctx.role}\` may not run git or gh — only ${ctx.policy.permissions.git_allowed_for.join(", ")} may. ` +
      `Write files; the harness commits them.`;
  }
  if (isRecursiveForceRm(command)) {
    return "recursive force delete is denied for every role";
  }
  return null;
}

/** `-rf`, `-fr`, `-r -f`, `--recursive --force` are all the same command. */
function isRecursiveForceRm(command: string): boolean {
  const m = command.match(/\brm\s+((?:-{1,2}[a-zA-Z-]+\s+)+)/);
  if (!m) return false;
  const flags = m[1];
  const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(flags) || flags.includes("--recursive");
  const force = /(^|\s)-[a-zA-Z]*f/.test(flags) || flags.includes("--force");
  return recursive && force;
}

/** Records the denial and reports it, so a leak shows up in the trace. */
function record(ctx: GuardContext, tool: string, reason: string, input: unknown): void {
  append(ctx.eventsFile, {
    trace_id: ctx.traceId, span_id: ctx.spanId, type: "tool_denied",
    role: ctx.role, outcome: tool, reason,
    payload: { input },
  });
}

export function preToolUseHook(ctx: GuardContext, denials: Denial[]): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const pre = input as PreToolUseHookInput;
        if (pre.tool_name !== "Bash") return {};
        const command = String((pre.tool_input as { command?: unknown })?.command ?? "");
        const reason = bashCommandDenial(ctx, command);
        if (!reason) return {};
        record(ctx, pre.tool_name, reason, pre.tool_input);
        denials.push({ tool: pre.tool_name, reason, input: pre.tool_input });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      },
    ],
  };
}

/**
 * Last bariyer. The hook above resolves the known cases; anything that still
 * falls through to a prompt is denied rather than left hanging — an unattended
 * daemon has nobody to ask.
 */
export function canUseTool(ctx: GuardContext, denials: Denial[]) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (toolName === "Bash") {
      const reason = bashCommandDenial(ctx, String(input?.command ?? ""));
      if (reason) {
        record(ctx, toolName, reason, input);
        denials.push({ tool: toolName, reason, input });
        return { behavior: "deny", message: reason };
      }
    }
    return { behavior: "allow" };
  };
}
