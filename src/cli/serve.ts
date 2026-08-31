import { sdkRunner } from "../agent-runner.ts";
import { ensureSandbox, executorFor, preflight, verifyToolchain } from "../exec.ts";
import { ghForge } from "../github.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { createServer, loadToken } from "../server.ts";

/**
 * `127.0.0.1` by default. A flow running in a container reaches the host over a
 * bridge, not over loopback, so that case needs `--host 0.0.0.0` — stated
 * explicitly rather than made the default, because widening the bind is a
 * decision and the token is what makes it survivable.
 */
export function serve(cwd: string, port = 7788, host = "127.0.0.1"): Promise<void> {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);

  // The same refusals the daemon makes: isolation that silently falls back to
  // the host is worse than none.
  const check = preflight(policy, paths);
  if (!check.ok) throw new Error(check.detail);
  const sandbox = ensureSandbox(policy, paths);
  if (!sandbox.ok) throw new Error(sandbox.detail);
  const toolchain = verifyToolchain(policy, paths);
  if (!toolchain.ok) throw new Error(toolchain.detail);

  const token = loadToken(paths);
  const server = createServer(
    { policy, paths, runner: sdkRunner, forge: ghForge, exec: executorFor(policy, paths) },
    token,
  );

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      console.log(`harness serve · http://${host}:${port} · ${paths.slug}`);
      console.log(`isolation · ${sandbox.detail}`);
      console.log(`token · ${token}`);
      console.log(`  stored at ${paths.sidecar}/api-token — send it as: Authorization: Bearer <token>`);
      if (host === "127.0.0.1") {
        console.log(`  a flow in a container cannot reach loopback; use --host 0.0.0.0 for that`);
      }
    });
    const stop = () => { server.close(); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
