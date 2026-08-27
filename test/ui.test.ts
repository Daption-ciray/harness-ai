import assert from "node:assert/strict";
import { test } from "node:test";
import { addBacklog } from "../src/pipeline.ts";
import { ui } from "../src/cli/ui.ts";
import { readFileSync } from "node:fs";
import { toyRepo } from "./helpers.ts";

/** A free port, so the suite never collides with a dashboard someone left open. */
function port(): number {
  return 7800 + Math.floor(process.pid % 150);
}

test("the dashboard serves itself and streams the log, and changes nothing", async () => {
  const { dir, paths } = toyRepo();
  addBacklog(paths.eventsFile, "bk-1", { text: "watch me", origin: "trusted", source: "human" });

  const p = port();
  const server = ui(dir, p);
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 40; i++) {
    try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 25)); }
  }

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>harness<\/title>/);
  assert.match(html, /EventSource\("\/events"\)/);

  assert.equal((await fetch(`${base}/nope`)).status, 404);

  // One SSE frame is enough: it must be a complete snapshot on connect, so a
  // dashboard opened halfway through a run is not blind to what came before.
  const stream = await fetch(`${base}/events`);
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  await reader.cancel();

  const payload = JSON.parse(frame.replace(/^data: /, "").trim());
  assert.equal(payload.kind, "snapshot");
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.events[0].type, "backlog_add");
  assert.equal(typeof payload.events[0].summary, "string", "events arrive already described");
  assert.ok(payload.stats);

  const before = readFileSync(paths.eventsFile, "utf8");
  await fetch(base);
  assert.equal(readFileSync(paths.eventsFile, "utf8"), before, "the dashboard is read-only");

  process.emit("SIGTERM");
  await p2(server);
});

/** The server resolves on SIGTERM; this just keeps the test honest about waiting. */
function p2(server: Promise<void>): Promise<void> {
  return Promise.race([server, new Promise<void>((r) => setTimeout(r, 500))]);
}
