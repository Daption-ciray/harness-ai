import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Works out how to build and test a repository, so `harness init` produces a
 * policy that fits the repo rather than one that assumes Node.
 *
 * Deliberately deterministic — reading `package.json` does not need a model, and
 * paying one to guess a test command would be exactly the reflex this project
 * refuses. Where detection genuinely cannot tell, it says so and leaves a
 * placeholder for a human, which is cheaper than a confident wrong answer.
 */
export type RepoProfile = {
  ecosystem: string;
  test_cmd: string | null;
  build_cmd: string | null;
  lint_cmd: string | null;
  /** Gitignored directories a worktree needs linked in before tests can run. */
  worktree_setup_cmd: string | null;
  notes: string[];
};

const UNKNOWN: RepoProfile = {
  ecosystem: "unknown", test_cmd: null, build_cmd: null,
  lint_cmd: null, worktree_setup_cmd: null, notes: [],
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `npm`, or whichever manager the lockfile in the repo points at. */
function nodeRunner(root: string): { run: string; install: string } {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return { run: "pnpm", install: "pnpm install" };
  if (existsSync(join(root, "yarn.lock"))) return { run: "yarn", install: "yarn install" };
  if (existsSync(join(root, "bun.lockb"))) return { run: "bun run", install: "bun install" };
  return { run: "npm run", install: "npm ci" };
}

function makeTargets(root: string): Set<string> {
  const file = join(root, "Makefile");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.match(/^([A-Za-z0-9_.-]+):/)?.[1])
      .filter((t): t is string => Boolean(t)),
  );
}

export function detectRepo(root: string): RepoProfile {
  const has = (f: string) => existsSync(join(root, f));

  if (has("package.json")) {
    const pkg = readJson(join(root, "package.json"));
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
    const { run, install } = nodeRunner(root);
    const script = (name: string) =>
      scripts[name] ? (run === "npm run" && name === "test" ? "npm test" : `${run} ${name}`) : null;
    return {
      ecosystem: "node",
      test_cmd: script("test"),
      build_cmd: script("build"),
      lint_cmd: script("lint") ?? script("typecheck"),
      // A worktree has no node_modules, so the test command would fail before
      // the builder ever ran. Linking is cheaper than a fresh install per task.
      worktree_setup_cmd: "ln -sfn $HARNESS_REPO_ROOT/node_modules node_modules",
      notes: scripts.test ? [] : [`no \`test\` script in package.json (${install} may still be needed)`],
    };
  }

  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return {
      ...UNKNOWN, ecosystem: "python",
      test_cmd: "pytest -q",
      lint_cmd: has("pyproject.toml") ? "ruff check ." : null,
      notes: ["assumed pytest; correct `repo.test_cmd` if this repository uses something else"],
    };
  }

  if (has("go.mod")) {
    return { ...UNKNOWN, ecosystem: "go", test_cmd: "go test ./...", build_cmd: "go build ./...", lint_cmd: "go vet ./..." };
  }

  if (has("Cargo.toml")) {
    return { ...UNKNOWN, ecosystem: "rust", test_cmd: "cargo test", build_cmd: "cargo build", lint_cmd: "cargo clippy" };
  }

  const targets = makeTargets(root);
  if (targets.size) {
    return {
      ...UNKNOWN, ecosystem: "make",
      test_cmd: targets.has("test") ? "make test" : null,
      build_cmd: targets.has("build") ? "make build" : null,
      lint_cmd: targets.has("lint") ? "make lint" : null,
    };
  }

  return {
    ...UNKNOWN,
    notes: ["could not tell how this repository is built or tested — set `repo.test_cmd` by hand before starting"],
  };
}

/** The prose form, for the brief every agent is handed. */
export function renderProfile(profile: RepoProfile, defaultBranch: string): string {
  return [
    `- ecosystem: ${profile.ecosystem}`,
    `- default branch: ${defaultBranch}`,
    ...(profile.test_cmd ? [`- tests: \`${profile.test_cmd}\``] : ["- tests: not configured"]),
    ...(profile.build_cmd ? [`- build: \`${profile.build_cmd}\``] : []),
    ...(profile.lint_cmd ? [`- lint: \`${profile.lint_cmd}\``] : []),
    ...profile.notes.map((n) => `- note: ${n}`),
  ].join("\n");
}

/** Rewrites the `repo:` block of a freshly copied policy template in place. */
export function applyProfile(policyYaml: string, profile: RepoProfile): string {
  const set = (text: string, key: string, value: string | null): string => {
    if (value === null) return text;
    const pattern = new RegExp(`^(  ${key}: ).*$`, "m");
    return pattern.test(text) ? text.replace(pattern, `$1"${value}"`) : text;
  };
  let out = policyYaml;
  out = set(out, "test_cmd", profile.test_cmd);
  out = set(out, "build_cmd", profile.build_cmd);
  out = set(out, "lint_cmd", profile.lint_cmd);
  out = set(out, "worktree_setup_cmd", profile.worktree_setup_cmd ?? "");
  return out;
}
