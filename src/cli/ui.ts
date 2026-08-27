import { createServer } from "node:http";
import { readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { describe } from "./format.ts";
import { readAll, type HarnessEvent } from "../events.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { buildStats } from "../report.ts";
import { listTasks } from "../projection.ts";

/**
 * A dashboard over the same functions the CLI uses — `node:http`, server-sent
 * events, one HTML file. No framework and no build step, because the thing being
 * looked at is a local append-only file and anything more would be scaffolding
 * around a `tail`.
 *
 * Read-only by construction: it serves the log and nothing else, so leaving it
 * open cannot change what the harness does.
 */
type Payload = {
  kind: "snapshot" | "delta";
  slug?: string;
  events: (HarnessEvent & { summary: string })[];
  tasks: ReturnType<typeof listTasks>;
  stats: ReturnType<typeof buildStats>;
};

function decorate(events: HarnessEvent[]): (HarnessEvent & { summary: string })[] {
  return events.map((e) => ({ ...e, summary: describe(e) }));
}

export function ui(cwd: string, port = 7777): Promise<void> {
  const paths = resolvePaths(cwd);
  const policy = loadPolicy(paths.policyFile);
  const html = readFileSync(join(import.meta.dirname, "..", "ui", "index.html"), "utf8");

  const snapshot = (from: number): Payload => {
    const all = readAll(paths.eventsFile);
    return {
      kind: from === 0 ? "snapshot" : "delta",
      slug: paths.slug,
      events: decorate(all.slice(from)),
      tasks: listTasks(all),
      stats: buildStats(all, policy),
    };
  };

  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url !== "/events") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let sent = 0;
    const push = () => {
      const total = readAll(paths.eventsFile).length;
      if (sent > 0 && total === sent) return;
      const payload = snapshot(sent);
      sent = total;
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    push();

    // Watching the file beats polling it, but a watcher can miss an event on
    // some platforms, so a slow tick backs it up rather than replacing it.
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      statSync(paths.eventsFile);
      watcher = watch(paths.eventsFile, () => push());
    } catch {
      // The log does not exist yet; the interval will pick it up.
    }
    const timer = setInterval(push, 3000);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 25_000);

    request.on("close", () => {
      watcher?.close();
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`harness ui · http://127.0.0.1:${port} · ${paths.slug} · ctrl-c to stop`);
    });
    const stop = () => { server.close(); resolve(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
