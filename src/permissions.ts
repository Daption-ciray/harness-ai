import type { Policy, Role } from "./policy.ts";

/** Reaches `git`/`gh` however it is dressed up: separators, subshells, backticks. */
const GIT_LIKE = /(^|[\s;&|(`$])(git|gh|gh-axi)(\s|$)/;

/** `-rf`, `-fr`, `-r -f` and `--recursive --force` are the same command. */
function isRecursiveForceRm(command: string): boolean {
  const m = command.match(/\brm\s+((?:-{1,2}[a-zA-Z-]+\s+)+)/);
  if (!m) return false;
  const flags = m[1];
  const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(flags) || flags.includes("--recursive");
  const force = /(^|\s)-[a-zA-Z]*f/.test(flags) || flags.includes("--force");
  return recursive && force;
}

/**
 * Pure: returns the reason a command must not run, or null to allow it.
 *
 * Only `devops` may run git or gh, which is what gives branch, commit and push
 * exactly one writer and makes the index.lock race structurally impossible
 * rather than merely unlikely.
 *
 * ponytail: phase 1 screens Bash only. `permissions.deny_all_roles`,
 * `never_edit` and the network allowlist join it in phase 3, at which point this
 * grows a tool-name argument.
 */
export function screenCommand(policy: Policy, role: Role, command: string): string | null {
  if (!policy.permissions.git_allowed_for.includes(role) && GIT_LIKE.test(command)) {
    return `role \`${role}\` may not run git or gh — only ${policy.permissions.git_allowed_for.join(", ")} may. ` +
      `Write files; the harness commits them.`;
  }
  if (isRecursiveForceRm(command)) {
    return "recursive force delete is denied for every role";
  }
  return null;
}
