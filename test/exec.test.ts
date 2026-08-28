import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureSandbox, executorFor, hostExecutor, preflight, sandboxExecutor,
  sandboxName, verifyToolchain, type ExecResult, type Spawn,
} from "../src/exec.ts";
import { parsePolicy, type Policy } from "../src/policy.ts";
import type { Paths } from "../src/paths.ts";

const shipped = parsePolicy(readFileSync(join(import.meta.dirname, "../src/default-policy.yaml"), "utf8"));
const contained: Policy = { ...shipped, runtime: { ...shipped.runtime, sandbox: "container" } };
const paths = { repoRoot: "/work/repo", slug: "acme__widget" } as Paths;

/** Records what would have been run, so the wiring is testable without Docker. */
function recorder(result: Partial<ExecResult> = {}): Spawn & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: Spawn = (file, args) => {
    calls.push({ file, args });
    return { ok: true, output: "", timedOut: false, ...result };
  };
  return Object.assign(spawn, { calls });
}

test("host execution runs the command through a shell, and nothing else", () => {
  const spawn = recorder();
  hostExecutor(spawn)({ cwd: "/work/repo", command: "npm test", timeoutMs: 1000 });
  assert.deepEqual(spawn.calls[0], { file: "/bin/sh", args: ["-c", "npm test"] });
});

test("sandbox execution names the sandbox and preserves the working directory", () => {
  // The workspace is mounted at the same path inside, which is what lets a
  // worktree path be passed through unchanged.
  const spawn = recorder();
  sandboxExecutor({ name: "harness-acme", workspace: "/work/repo" }, spawn)({
    cwd: "/work/repo/.harness-worktrees/bk-1", command: "npm test", timeoutMs: 1000,
  });
  const { file, args } = spawn.calls[0];
  assert.equal(file, "docker");
  assert.deepEqual(args.slice(0, 3), ["sandbox", "exec", "harness-acme"]);
  assert.match(args.at(-1) as string, /cd "\/work\/repo\/\.harness-worktrees\/bk-1" && npm test/);
});

test("environment reaches the sandbox as flags, not as the harness's own env", () => {
  const spawn = recorder();
  sandboxExecutor({ name: "s", workspace: "/w" }, spawn)({
    cwd: "/w", command: "true", env: { HARNESS_REPO_ROOT: "/w" }, timeoutMs: 1000,
  });
  assert.deepEqual(spawn.calls[0].args.slice(2, 4), ["-e", "HARNESS_REPO_ROOT=/w"]);
});

test("policy decides where a command runs", () => {
  const host = recorder();
  executorFor(shipped, paths, host)({ cwd: "/work/repo", command: "npm test", timeoutMs: 1 });
  assert.equal(host.calls[0].file, "/bin/sh");

  const sandbox = recorder();
  executorFor(contained, paths, sandbox)({ cwd: "/work/repo", command: "npm test", timeoutMs: 1 });
  assert.equal(sandbox.calls[0].file, "docker");
});

test("one sandbox per repository, named stably and legally", () => {
  assert.equal(sandboxName(paths), "harness-acme__widget");
  assert.match(sandboxName({ ...paths, slug: "a/b c" } as Paths), /^harness-a-b-c$/);
  assert.ok(sandboxName({ ...paths, slug: "x".repeat(200) } as Paths).length <= 60);
});

test("container mode refuses to start rather than falling back to the host", () => {
  // The same reasoning as failIfUnavailable: an operator who asked for
  // isolation must not end up believing in a boundary that is not there.
  const missing = recorder({ ok: false, output: "cannot connect to the Docker daemon" });
  const check = preflight(contained, paths, missing);
  assert.equal(check.ok, false);
  assert.match(check.detail, /Docker daemon is not reachable/);
  assert.match(check.detail, /set runtime\.sandbox to `os`/);
});

test("the preflight probe needs the daemon, not just the plugin", () => {
  // `docker sandbox version` answers with no daemon running, so checking it
  // proved only that the plugin was installed — and `create` then hung for five
  // minutes waiting for a daemon that was never coming.
  const spawn = recorder();
  preflight(contained, paths, spawn);
  assert.deepEqual(spawn.calls[0].args, ["sandbox", "ls"]);
});

test("a probe that hangs is reported as a hang, not as an unknown error", () => {
  const stuck = recorder({ ok: false, timedOut: true, output: "" });
  assert.match(preflight(contained, paths, stuck).detail, /timed out/);
});

test("host mode needs no docker at all", () => {
  const spawn = recorder({ ok: false, output: "docker: command not found" });
  assert.equal(preflight(shipped, paths, spawn).ok, true);
  assert.equal(spawn.calls.length, 0, "and does not even look for it");
});

test("the sandbox is created once and its egress policy is default-deny", () => {
  const spawn = recorder();
  const result = ensureSandbox(contained, paths, spawn);
  assert.equal(result.ok, true);

  // `--name` is an option of `create`, so it precedes the agent subcommand.
  const created = spawn.calls.find((c) => c.args[1] === "create");
  assert.deepEqual(created?.args,
    ["sandbox", "create", "--name", "harness-acme__widget", "claude", "/work/repo"]);

  const proxy = spawn.calls.find((c) => c.args[1] === "network");
  assert.ok(proxy);
  assert.deepEqual(proxy.args.slice(0, 6),
    ["sandbox", "network", "proxy", "harness-acme__widget", "--policy", "deny"]);
  for (const host of shipped.permissions.network_allowlist) {
    assert.ok(proxy.args.includes(host), `${host} should be allowed through`);
  }
});

test("an existing sandbox is reused rather than recreated", () => {
  const spawn = recorder({ ok: true, output: "harness-acme__widget  running" });
  ensureSandbox(contained, paths, spawn);
  assert.ok(!spawn.calls.some((c) => c.args[1] === "create"), "creating it again would discard its state");
});

test("a sandbox that cannot be created or locked down is a hard failure", () => {
  const brokenCreate: Spawn = (_f, args) => args[1] === "create"
    ? { ok: false, output: "no space left on device", timedOut: false }
    : { ok: true, output: "", timedOut: false };
  assert.equal(ensureSandbox(contained, paths, brokenCreate).ok, false);

  const brokenProxy: Spawn = (_f, args) => args[1] === "network"
    ? { ok: false, output: "proxy unavailable", timedOut: false }
    : { ok: true, output: "", timedOut: false };
  const result = ensureSandbox(contained, paths, brokenProxy);
  assert.equal(result.ok, false, "unrestricted egress is not an acceptable degradation");
  assert.match(result.detail, /egress policy/);
});

test("a sandbox that cannot build the repository is a startup failure, not a red suite", () => {
  // A container is a different machine. If its toolchain does not match, the
  // command fails inside and passes outside — and the harness would read a
  // healthy repository as permanently broken: a phantom "the suite is failing"
  // task on a loop, and every automatic merge blocked by a test run that could
  // never have passed.
  const mismatch: Spawn = (file) => file === "docker"
    ? { ok: false, output: "Unknown file extension \".ts\"", timedOut: false }
    : { ok: true, output: "", timedOut: false };

  const result = verifyToolchain(contained, paths, mismatch);
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not carry this repository's toolchain/);
  assert.match(result.detail, /runtime\.sandbox_image/);
});

test("a suite that is red everywhere is the sensor's business, not a startup failure", () => {
  const redEverywhere: Spawn = () => ({ ok: false, output: "1 failing", timedOut: false });
  assert.equal(verifyToolchain(contained, paths, redEverywhere).ok, true);
});

test("a working sandbox passes the toolchain check without touching the host", () => {
  const fine = recorder();
  assert.equal(verifyToolchain(contained, paths, fine).ok, true);
  assert.ok(fine.calls.every((c) => c.file === "docker"), "the host is only consulted when the sandbox fails");
});

test("a custom image is passed through to create", () => {
  const spawn = recorder();
  ensureSandbox({ ...contained, runtime: { ...contained.runtime, sandbox_image: "node:24" } }, paths, spawn);
  const created = spawn.calls.find((c) => c.args[1] === "create");
  assert.deepEqual(created?.args.slice(4, 6), ["--template", "node:24"]);
});
