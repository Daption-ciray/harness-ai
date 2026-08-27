import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../policy.ts";
import { originUrl, resolvePaths } from "../paths.ts";

const DECISIONS_HEADER = `# Decisions

Append-only. Written by \`scribe\`, one entry per merged change, in the same PR as
the code it describes — so approving the code approves the memory.

Each entry records **why**, not what. The diff already records what.

---
`;

export function init(cwd = process.cwd(), force = false): string[] {
  const paths = resolvePaths(cwd);
  const out: string[] = [];

  mkdirSync(paths.harnessDir, { recursive: true });

  if (existsSync(paths.policyFile) && !force) {
    out.push(`kept    ${paths.policyFile} (already exists, --force to overwrite)`);
  } else {
    copyFileSync(join(import.meta.dirname, "..", "default-policy.yaml"), paths.policyFile);
    out.push(`wrote   ${paths.policyFile}`);
  }

  if (!existsSync(paths.decisionsFile)) {
    writeFileSync(paths.decisionsFile, DECISIONS_HEADER, "utf8");
    out.push(`wrote   ${paths.decisionsFile}`);
  }

  for (const dir of [paths.sidecar, paths.worktreesDir]) {
    mkdirSync(dir, { recursive: true });
  }
  out.push(`sidecar ${paths.sidecar}`);

  loadPolicy(paths.policyFile); // fail loudly now rather than at first tick
  out.push(`policy  valid`);

  if (!originUrl(paths.repoRoot)) {
    out.push(`WARNING no \`origin\` remote — \`harness start\` will refuse until one exists`);
  }
  return out;
}
