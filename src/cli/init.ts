import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy } from "../policy.ts";
import { decisionsHeader } from "../memory.ts";
import { originUrl, resolvePaths } from "../paths.ts";

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
    writeFileSync(paths.decisionsFile, decisionsHeader(), "utf8");
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
