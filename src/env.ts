/**
 * The harness runs commands that belong to the target repository — its test
 * command, its worktree setup. Those must not inherit the harness's own
 * execution context.
 *
 * This is not hypothetical. Running the harness from inside a Node test runner
 * leaks `NODE_TEST_CONTEXT` into the repository's `node --test`, which then
 * reports to the parent runner instead of exiting non-zero: a red suite comes
 * back green, and the sensor sees nothing wrong. The same class of leak comes
 * from `NODE_OPTIONS`, coverage variables, and npm's `npm_*` block, which points
 * a child `npm` at whichever package invoked us.
 */
const STRIPPED_EXACT = new Set([
  "NODE_TEST_CONTEXT",
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
  "NODE_REPL_EXTERNAL_MODULE",
  "INIT_CWD",
]);

const STRIPPED_PREFIXES = ["npm_", "NODE_TEST_"];

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (STRIPPED_EXACT.has(key)) continue;
    if (STRIPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
