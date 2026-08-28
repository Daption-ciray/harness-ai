import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../policy.ts";
import { decisionsHeader } from "../memory.ts";
import { applyProfile, detectRepo, renderProfile } from "../scout.ts";
import { originUrl, resolvePaths, WORKTREES_DIR } from "../paths.ts";

export function init(cwd = process.cwd(), force = false): string[] {
  const paths = resolvePaths(cwd);
  const out: string[] = [];

  mkdirSync(paths.harnessDir, { recursive: true });

  // Detection is deterministic: reading package.json does not need a model, and
  // paying one to guess a test command is the reflex this project refuses.
  const profile = detectRepo(paths.repoRoot);
  const template = readFileSync(join(import.meta.dirname, "..", "default-policy.yaml"), "utf8");

  if (existsSync(paths.policyFile) && !force) {
    out.push(`kept    ${paths.policyFile} (already exists, --force to overwrite)`);
  } else {
    writeFileSync(paths.policyFile, applyProfile(template, profile), "utf8");
    out.push(`wrote   ${paths.policyFile}`);
  }
  out.push(`repo    ${profile.ecosystem} · tests ${profile.test_cmd ?? "NOT DETECTED"}`);
  for (const note of profile.notes) out.push(`        note: ${note}`);

  if (!existsSync(paths.decisionsFile)) {
    writeFileSync(paths.decisionsFile, decisionsHeader(), "utf8");
    out.push(`wrote   ${paths.decisionsFile}`);
  }

  for (const dir of [paths.sidecar, paths.worktreesDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // A git worktree inside the working tree must be ignored, or every task's
  // files show up as untracked in the repository it is working on.
  const gitignore = join(paths.repoRoot, ".gitignore");
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!ignored.split("\n").some((l) => l.trim() === WORKTREES_DIR)) {
    writeFileSync(gitignore, `${ignored.replace(/\s*$/, "")}\n${WORKTREES_DIR}\n`, "utf8");
    out.push(`wrote   ${gitignore} (+ ${WORKTREES_DIR})`);
  }

  writeFileSync(
    paths.repoProfileFile,
    renderProfile(profile, loadPolicy(paths.policyFile).repo.default_branch),
    "utf8",
  );
  out.push(`sidecar ${paths.sidecar}`);

  loadPolicy(paths.policyFile); // fail loudly now rather than at first tick
  out.push(`policy  valid`);

  if (!originUrl(paths.repoRoot)) {
    out.push(`WARNING no \`origin\` remote — \`harness start\` will refuse until one exists`);
  }
  return out;
}
