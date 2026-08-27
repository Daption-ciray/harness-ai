import type { Role } from "../policy.ts";

/**
 * `allowedTools` auto-approves; it does NOT restrict — an unlisted tool simply
 * falls through to the permission mode. Restriction is `disallowedTools`, so
 * every role that must not do something names it here explicitly.
 */
const MUTATING = ["Write", "Edit", "NotebookEdit", "Bash"];
const RESEARCH = ["WebFetch", "WebSearch"];
const READING = ["Read", "Glob", "Grep"];
const DELEGATION = ["Agent", "Task"];

export type ToolPolicy = { allow?: string[]; deny: string[] };

export const ROLE_TOOLS: Record<Role, ToolPolicy> = {
  // Reads the repo and plans. Cannot edit, cannot shell out.
  planner: { allow: READING, deny: [...MUTATING, ...RESEARCH, ...DELEGATION] },
  // The only role that writes code. git and gh are blocked by the PreToolUse guard.
  builder: { deny: [...RESEARCH, ...DELEGATION] },
  // Writes and runs tests to prove a defect; never fixes the code.
  adversary: { deny: [...RESEARCH, ...DELEGATION] },
  // Pure judgement over material it is handed. No tools at all.
  review: { allow: [], deny: [...MUTATING, ...RESEARCH, ...READING, ...DELEGATION] },
  security: { allow: READING, deny: [...MUTATING, ...RESEARCH, ...DELEGATION] },
  // Thin judgement over thick plumbing: it decides, the harness runs git.
  devops: { allow: [], deny: [...MUTATING, ...RESEARCH, ...READING, ...DELEGATION] },
  scribe: { allow: READING, deny: [...MUTATING, ...RESEARCH, ...DELEGATION] },
};
