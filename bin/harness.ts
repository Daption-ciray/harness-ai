#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setPaused, start, stop } from "../src/daemon.ts";
import { backlogAdd, runOnce, tasks } from "../src/cli/backlog.ts";
import { init } from "../src/cli/init.ts";
import { status } from "../src/cli/status.ts";
import { version } from "../src/cli/version.ts";

const USAGE = `harness — multi-agent development harness

  harness init [--force]        write .harness/policy.yaml and the sidecar dirs
  harness start                 run the daemon in the foreground
  harness stop                  signal a running daemon to shut down
  harness pause | resume        idle or wake dispatch without stopping the daemon
  harness status                live state, policy summary, recent events
  harness backlog add "<text>"  queue a task (origin: trusted)
  harness tasks                 list every task and its state
  harness run [<id>]            advance one task by one stage, in the foreground
  harness version               display the CLI version
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    untrusted: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const [cmd, ...rest] = positionals;
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
  } else if (cmd === "tasks") {
    console.log(tasks(cwd));
  } else if (cmd === "run") {
    console.log(await runOnce(cwd, rest[0]));
  } else if (cmd === "backlog" && rest[0] === "add") {
    console.log(backlogAdd(cwd, rest.slice(1).join(" "), values.untrusted ? "untrusted" : "trusted"));
  } else if (cmd === "version") {
    console.log(version(cwd));
  } else {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
