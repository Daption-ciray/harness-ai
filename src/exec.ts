import { execFileSync } from "node:child_process";
import { cleanEnv } from "./env.ts";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";

/**
 * Where a command belonging to the TARGET repository runs.
 *
 * Three places execute repository code as a subprocess of the harness: the
 * worktree setup command, the broken-tests sensor, and the test run that
 * precedes an automatic merge. The last one runs code the agents just wrote,
 * moments before it reaches the default branch, and on the host it had no
 * isolation at all — the OS sandbox covers the agents' own tool use, not the
 * harness's subprocesses.
 *
 * `runtime.sandbox: container` moves all three into a Docker sandbox, whose
 * proxy enforces default-deny egress. That closes the residual risk the OS
 * sandbox leaves: its proxy does not terminate TLS and decides from the
 * client-supplied hostname, so a broad allowed domain can be fronted.
 */
export type ExecInput = {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs: number;
};

export type ExecResult = { ok: boolean; output: string; timedOut: boolean };

export type Spawn = (file: string, args: string[], input: ExecInput) => ExecResult;

export const systemSpawn: Spawn = (file, args, input) => {
  try {
    const output = execFileSync(file, args, {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv(input.env),
      timeout: input.timeoutMs,
      ...(file === "" ? { shell: true } : {}),
    });
    return { ok: true, output, timedOut: false };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; signal?: string; message: string };
    return {
      ok: false,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message,
      timedOut: err.signal === "SIGTERM",
    };
  }
};

export type CommandExecutor = (input: ExecInput) => ExecResult;

/** Straight onto the host, with the harness's own environment stripped out. */
export function hostExecutor(spawn: Spawn = systemSpawn): CommandExecutor {
  return (input) => spawn("/bin/sh", ["-c", input.command], input);
}

export type SandboxConfig = { name: string; workspace: string };

/**
 * `docker sandbox exec` runs inside a VM-backed sandbox whose workspace is
 * mounted at the same path as on the host — which is why the command's `cwd`
 * can be passed through unchanged.
 */
export function sandboxExecutor(config: SandboxConfig, spawn: Spawn = systemSpawn): CommandExecutor {
  return (input) => spawn("docker", [
    "sandbox", "exec",
    ...Object.entries(input.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    config.name,
    "/bin/sh", "-c", `cd ${JSON.stringify(input.cwd)} && ${input.command}`,
  ], input);
}

/** A stable name per repository, so one sandbox is reused across tasks. */
export function sandboxName(paths: Paths): string {
  return `harness-${paths.slug}`.replace(/[^A-Za-z0-9._+-]/g, "-").slice(0, 60);
}

export function isContainerMode(policy: Policy): boolean {
  return policy.runtime.sandbox === "container";
}

export function executorFor(policy: Policy, paths: Paths, spawn: Spawn = systemSpawn): CommandExecutor {
  return isContainerMode(policy)
    ? sandboxExecutor({ name: sandboxName(paths), workspace: paths.repoRoot }, spawn)
    : hostExecutor(spawn);
}

export type Preflight = { ok: boolean; detail: string };

/**
 * Checked before the daemon starts, and fatal when it fails.
 *
 * The same reasoning as the OS sandbox's `failIfUnavailable`: a harness asked
 * for container isolation must refuse to run without it rather than quietly
 * falling back to the host. Silently downgrading an isolation boundary is worse
 * than not offering one.
 */
export function preflight(policy: Policy, paths: Paths, spawn: Spawn = systemSpawn): Preflight {
  if (!isContainerMode(policy)) return { ok: true, detail: "host execution" };

  // `docker sandbox version` answers without a daemon, so checking it proves
  // only that the plugin is installed — and creating a sandbox then hangs for
  // minutes waiting for a daemon that is not there. `ls` needs the daemon, and
  // a short timeout turns a five-minute hang into an immediate, readable no.
  const probe = spawn("docker", ["sandbox", "ls"], { cwd: paths.repoRoot, command: "", timeoutMs: 20_000 });
  if (!probe.ok) {
    return {
      ok: false,
      detail: "runtime.sandbox is `container` but the Docker daemon is not reachable — " +
        "start Docker Desktop, or set runtime.sandbox to `os` in .harness/policy.yaml.\n  " +
        (probe.timedOut ? "docker sandbox ls timed out" : probe.output.split("\n")[0]),
    };
  }
  return { ok: true, detail: `docker sandbox · ${sandboxName(paths)}` };
}

/**
 * Creates the sandbox if it does not exist and applies the egress policy.
 * Default-deny with an allowlist, so a command that wants an unlisted host is
 * refused at the proxy rather than trusted not to ask.
 */
export function ensureSandbox(policy: Policy, paths: Paths, spawn: Spawn = systemSpawn): Preflight {
  if (!isContainerMode(policy)) return { ok: true, detail: "host execution" };
  const name = sandboxName(paths);
  const base: ExecInput = { cwd: paths.repoRoot, command: "", timeoutMs: 300_000 };

  const existing = spawn("docker", ["sandbox", "ls"], base);
  if (!existing.output.includes(name)) {
    // `--name` belongs to `create`, before the agent subcommand. Putting it
    // after the workspace is rejected outright, which is how this was caught.
    const created = spawn("docker", [
      "sandbox", "create", "--name", name,
      ...(policy.runtime.sandbox_image ? ["--template", policy.runtime.sandbox_image] : []),
      "claude", paths.repoRoot,
    ], base);
    if (!created.ok) return { ok: false, detail: `could not create sandbox: ${created.output.split("\n")[0]}` };
  }

  const proxy = spawn("docker", [
    "sandbox", "network", "proxy", name,
    "--policy", "deny",
    ...policy.permissions.network_allowlist.flatMap((host) => ["--allow-host", host]),
  ], base);
  if (!proxy.ok) return { ok: false, detail: `could not apply egress policy: ${proxy.output.split("\n")[0]}` };

  return { ok: true, detail: `${name} · deny by default, ${policy.permissions.network_allowlist.length} host(s) allowed` };
}

/**
 * Confirms the sandbox can actually run this repository's test command.
 *
 * A container is a different machine. If its toolchain does not match what the
 * repository needs, the command fails there and passes on the host — and the
 * harness would then read a healthy repository as permanently broken: the
 * sensor queues a phantom "the suite is failing" task on a loop, and every
 * automatic merge is blocked by a test run that could never have passed.
 *
 * Wrong answers delivered confidently are the failure mode worth refusing to
 * start over.
 */
export function verifyToolchain(
  policy: Policy, paths: Paths, spawn: Spawn = systemSpawn,
): Preflight {
  const command = policy.repo.test_cmd;
  if (!isContainerMode(policy) || !command) return { ok: true, detail: "not checked" };

  const inside: ExecInput = { cwd: paths.repoRoot, command, timeoutMs: 10 * 60_000 };
  if (executorFor(policy, paths, spawn)(inside).ok) return { ok: true, detail: "the sandbox can build and test this repository" };

  // It failed inside. Only a mismatch if the same command passes outside; a
  // genuinely red suite is the sensor's business, not a startup failure.
  if (!hostExecutor(spawn)(inside).ok) {
    return { ok: true, detail: "the suite is red on the host too — that is the sensor's job, not a startup failure" };
  }
  return {
    ok: false,
    detail: `\`${command}\` passes on the host and fails inside the sandbox, so the sandbox image ` +
      `does not carry this repository's toolchain.\n  ` +
      `Set runtime.sandbox_image to an image that does, or set runtime.sandbox to \`os\`.`,
  };
}
