#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setPaused, start, stop } from "../src/daemon.ts";
import { init } from "../src/cli/init.ts";
import { status } from "../src/cli/status.ts";

const USAGE = `harness — multi-agent development harness

  harness init [--force]   write .harness/policy.yaml and the sidecar dirs
  harness start            run the daemon in the foreground
  harness stop             signal a running daemon to shut down
  harness pause | resume   idle or wake dispatch without stopping the daemon
  harness status           live state, policy summary, recent events
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { force: { type: "boolean", default: false }, help: { type: "boolean", default: false } },
});

const cmd = positionals[0];
const cwd = process.cwd();

try {
  if (values.help || !cmd) {
    console.log(USAGE);
  } else if (cmd === "init") {
    console.log(init(cwd, values.force).join("\n"));
  } else if (cmd === "start") {
    await start(cwd);
  } else if (cmd === "stop") {
    console.log(stop(cwd));
  } else if (cmd === "pause") {
    console.log(setPaused(cwd, true));
  } else if (cmd === "resume") {
    console.log(setPaused(cwd, false));
  } else if (cmd === "status") {
    console.log(status(cwd));
  } else {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
