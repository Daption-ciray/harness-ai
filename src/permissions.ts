import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import type { Policy, Role } from "./policy.ts";

/**
 * Three layers, with different jobs. None of them is sufficient alone.
 *
 * 1. The OS sandbox (`sandboxSettings`) is the only real enforcement over Bash.
 *    A regex cannot make a shell safe — `echo x > ~/.ssh/authorized_keys` defeats
 *    any pattern — so the kernel draws that boundary, over every child process.
 * 2. Permission deny rules (`denyRules`) stop the in-process file tools, which
 *    the Bash sandbox does not cover.
 * 3. This module's `screenTool` is our own policy and our audit trail: it runs
 *    first in the permission flow, records every denial to the trace, and still
 *    holds on a platform where the sandbox is unavailable.
 */

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

export function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Resolves a path the way the filesystem will, not the way it looks.
 *
 * A path is checked after symlinks are followed, because a symlink planted
 * inside the worktree that points at `~/.ssh` would otherwise pass a textual
 * check and then write exactly where it was not allowed to. The target may not
 * exist yet, so the nearest existing ancestor is what gets resolved.
 */
export function realResolve(cwd: string, path: string): string {
  // `~` is expanded on the TARGET as well as on the pattern. A tool input of
  // `~/.ssh/id_rsa` would otherwise resolve under the working directory and
  // sail past a check written against the home directory.
  const expanded = expandHome(path);
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  let probe = absolute;
  const tail: string[] = [];
  while (!existsSync(probe) && dirname(probe) !== probe) {
    tail.unshift(probe.slice(dirname(probe).length + 1));
    probe = dirname(probe);
  }
  try {
    return resolve(realpathSync(probe), ...tail);
  } catch {
    return absolute;
  }
}

/**
 * Roots must be resolved the same way targets are, or containment is decided
 * between two different spellings of the same directory. On macOS `/var` is a
 * symlink to `/private/var`, so a worktree under `/var/folders/...` never
 * contains its own files once those are resolved — every legitimate write is
 * denied, and the layer looks like it works while protecting nothing useful.
 */
function canonical(roots: string[]): string[] {
  return roots.map((root) => realResolve(root, root));
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Read and write scopes are separate on purpose. A builder must READ the main
 * checkout, because its worktree's dependency directory is a symlink into it,
 * but it must never WRITE there — that is the tree every other task branches
 * from.
 */
export type Guard = {
  role: Role;
  policy: Policy;
  /** Where the agent runs. */
  cwd: string;
  roots: { write: string[]; read: string[] };
};

/** Every built-in tool that writes files is governed together. */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

function pathFrom(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
    const value = input?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

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

export function screenWrite(guard: Guard, path: string): string | null {
  const target = realResolve(guard.cwd, path);
  const roots = canonical(guard.roots.write);

  if (!roots.some((root) => isWithin(root, target))) {
    return `writing outside the working tree is denied (${target}). ` +
      `Everything this task may change lives under ${guard.roots.write[0] ?? "(nothing writable)"}.`;
  }
  for (const root of roots) {
    if (!isWithin(root, target)) continue;
    const rel = relative(root, target);
    for (const pattern of guard.policy.permissions.never_edit) {
      if (matchesGlob(rel, pattern)) {
        return `\`${rel}\` is in never_edit: the harness may propose a change here, never apply one`;
      }
    }
  }
  return null;
}

export function screenRead(guard: Guard, path: string): string | null {
  const target = realResolve(guard.cwd, path);
  for (const pattern of guard.policy.permissions.never_read) {
    const expanded = expandHome(pattern);
    if (matchesGlob(target, expanded) || matchesGlob(target, `${expanded}/**`)) {
      return `reading \`${target}\` is denied: it matches never_read (${pattern})`;
    }
  }
  return null;
}

/** The single entry point the runner calls, for every tool. */
export function screenTool(
  guard: Guard,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName === "Bash") {
    return screenCommand(guard.policy, guard.role, String(input?.command ?? ""));
  }
  const path = pathFrom(input);
  if (!path) return null;
  if (WRITE_TOOLS.has(toolName)) return screenWrite(guard, path);
  if (READ_TOOLS.has(toolName)) return screenRead(guard, path);
  return null;
}

/**
 * Deny rules for the in-process file tools, which the Bash sandbox does not
 * cover. `Edit(...)` governs every file-writing tool including `Write` and
 * `NotebookEdit` — a `Write(...)` rule is never matched by the file permission
 * checks, so writing one would silently protect nothing. `//` anchors the
 * pattern at the filesystem root rather than at the rule's source.
 */
export function denyRules(guard: Guard): string[] {
  const rules: string[] = [];
  for (const root of canonical([...guard.roots.write, ...guard.roots.read])) {
    for (const pattern of guard.policy.permissions.never_edit) {
      rules.push(`Edit(//${resolve(root, pattern)})`);
    }
  }
  for (const pattern of guard.policy.permissions.never_read) {
    rules.push(`Read(//${expandHome(pattern)})`);
  }
  return rules;
}

/**
 * `failIfUnavailable` stays at its default of true: an unattended daemon must
 * not quietly fall back to running unsandboxed. `allowUnsandboxedCommands` is
 * turned OFF against its default, because otherwise the model can set
 * `dangerouslyDisableSandbox` on a tool call and step outside the boundary it
 * is the whole point of.
 */
export function sandboxSettings(guard: Guard): Record<string, unknown> | undefined {
  if (guard.policy.runtime.sandbox === "none") return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    excludedCommands: [],
    filesystem: {
      allowWrite: canonical(guard.roots.write),
      allowRead: canonical(guard.roots.read),
      denyWrite: guard.policy.permissions.never_edit.flatMap(
        (pattern) => canonical([...guard.roots.write, ...guard.roots.read])
          .map((root) => resolve(root, pattern)),
      ),
      denyRead: guard.policy.permissions.never_read.map(expandHome),
    },
    network: {
      allowedDomains: guard.policy.permissions.network_allowlist,
      strictAllowlist: true,
      allowLocalBinding: false,
      allowUnixSockets: [],
    },
  };
}
