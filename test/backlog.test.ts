import assert from "node:assert/strict";
import { test } from "node:test";
import { addBacklog } from "../src/pipeline.ts";
import { tasks } from "../src/cli/backlog.ts";
import { toyRepo } from "./helpers.ts";

test("tasks() with no flag lists an empty backlog as the human-readable message", () => {
  const { dir } = toyRepo();
  assert.equal(tasks(dir), 'no tasks — `harness backlog add "<what to do>"`');
});

test("tasks(cwd, true) on an empty backlog prints valid JSON: []", () => {
  const { dir } = toyRepo();
  const out = tasks(dir, true);
  assert.equal(out, "[]");
  assert.deepEqual(JSON.parse(out), []);
});

test("tasks(cwd, true) prints a JSON array with one object per task carrying the expected fields", () => {
  const { dir, paths } = toyRepo();
  addBacklog(paths.eventsFile, "bk-1", { text: "add a widget", origin: "trusted", source: "human" });
  addBacklog(paths.eventsFile, "bk-2", { text: "fix a bug", origin: "untrusted", source: "sensor" });

  const out = tasks(dir, true);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 2);
  for (const t of parsed) {
    assert.ok(typeof t.id === "string");
    assert.ok(typeof t.state === "string");
    assert.ok(typeof t.task_class === "string");
    assert.ok(typeof t.origin === "string");
    assert.ok(typeof t.cost_usd === "number");
    assert.ok("pr" in t);
    assert.ok(typeof t.text === "string");
    assert.ok("last_error" in t);
  }
  assert.equal(parsed[0].id, "bk-1");
  assert.equal(parsed[0].text, "add a widget");
  assert.equal(parsed[1].id, "bk-2");
  assert.equal(parsed[1].origin, "untrusted");
});

test("tasks(cwd, false) still prints the aligned text table, unchanged by the json flag existing", () => {
  const { dir, paths } = toyRepo();
  addBacklog(paths.eventsFile, "bk-1", { text: "add a widget", origin: "trusted", source: "human" });

  const withoutFlag = tasks(dir);
  const withFalseFlag = tasks(dir, false);
  assert.equal(withoutFlag, withFalseFlag);
  assert.ok(withoutFlag.includes("bk-1"));
  assert.ok(!withoutFlag.trim().startsWith("["));
});
