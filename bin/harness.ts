#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setPaused, start, stop } from "../src/daemon.ts";
import { answer, ask, cancel, runOnce, tasks, waiting } from "../src/cli/backlog.ts";
import { readFileSync } from "node:fs";
import { init } from "../src/cli/init.ts";
import { status } from "../src/cli/status.ts";

const USAGE = `harness — multi-agent development harness

  harness init [--force]        write .harness/policy.yaml and the sidecar dirs
  harness start                 run the daemon in the foreground
  harness stop                  signal a running daemon to shut down
  harness pause | resume        idle or wake dispatch without stopping the daemon
  harness status                live state, policy summary, recent events
  harness ask "<what you want>"  ask for a change; also --file <path> or stdin
  harness answer <id> "<text>"  answer a question the planner stopped on
  harness waiting               everything that needs you, and why
  harness tasks                 list every task and its state
  harness run [<id>]            advance one task by one stage, in the foreground
  harness cancel <id> "<why>"   retire a task; recorded, never deleted
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    file: { type: "string" },
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
  } else if (cmd === "ask" || (cmd === "backlog" && rest[0] === "add")) {
    const words = cmd === "ask" ? rest : rest.slice(1);
    const piped = !process.stdin.isTTY && !words.length && !values.file
      ? readFileSync(0, "utf8")
      : undefined;
    console.log(ask(cwd, { text: words.join(" "), file: values.file, stdin: piped },
      values.untrusted ? "untrusted" : "trusted"));
  } else if (cmd === "answer") {
    if (!rest[0]) throw new Error('answer needs a task id: harness answer bk-1 "..."');
    console.log(answer(cwd, rest[0], rest.slice(1).join(" ")));
  } else if (cmd === "waiting") {
    console.log(waiting(cwd));
  } else if (cmd === "cancel") {
    if (!rest[0]) throw new Error('cancel needs a task id: harness cancel bk-1 "why"');
    console.log(cancel(cwd, rest[0], rest.slice(1).join(" ") || "no reason given"));
  } else {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
