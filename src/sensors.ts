import { execFileSync } from "node:child_process";
import type { Origin } from "./domain.ts";
import { cleanEnv } from "./env.ts";
import { emit, readAll, type HarnessEvent } from "./events.ts";
import type { Forge } from "./github.ts";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { addBacklog } from "./pipeline.ts";
import { isFingerprintSuppressed, nextTaskId } from "./projection.ts";

/**
 * Sensors are where work comes from when nobody has asked for anything. They are
 * plain code, not agents: noticing that the test suite is red does not need a
 * model, and paying one to notice it every fifteen minutes would be absurd.
 *
 * Each candidate carries a fingerprint that is stable for the PROBLEM rather
 * than for the observation, which is what stops the same red suite being queued
 * every time the sensor looks.
 */
export type Candidate = {
  text: string;
  fingerprint: string;
};

export type SensorContext = {
  policy: Policy;
  paths: Paths;
  forge: Forge;
};

export type Sensor = {
  name: string;
  origin: Origin;
  run(ctx: SensorContext): { candidates: Candidate[]; detail: string };
};

export function parseCadence(text: string): number {
  const m = text.trim().match(/^(\d+)\s*([smhd])$/);
  if (!m) throw new Error(`cadence must look like "15m" or "24h", got "${text}"`);
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

/** The test suite is one problem until it is green, however many cases are red. */
const brokenTests: Sensor = {
  name: "broken_tests",
  origin: "trusted",
  run({ policy, paths }) {
    if (!policy.repo.test_cmd) return { candidates: [], detail: "no test command configured" };
    try {
      execFileSync(policy.repo.test_cmd, {
        cwd: paths.repoRoot, shell: true, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // The repository's own command, run in its own environment.
        env: cleanEnv(),
        // An always-on loop cannot afford to block on a hanging suite.
        timeout: 10 * 60_000,
      });
      return { candidates: [], detail: "green" };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; signal?: string };
      if (err.signal === "SIGTERM") {
        return { candidates: [], detail: "test command timed out; not queueing a task for it" };
      }
      const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().slice(-4000);
      return {
        detail: "red",
        candidates: [{
          // ponytail: one task for the whole suite. Splitting it would mean
          // parsing arbitrary test output, which is guesswork; the failing
          // output goes in the task text so the planner has the detail.
          fingerprint: "broken_tests",
          text: `The test suite is failing. Find the cause and fix it.\n\n` +
            `Command: \`${policy.repo.test_cmd}\`\n\nOutput (tail):\n\`\`\`\n${output}\n\`\`\``,
        }],
      };
    }
  },
};

/** One task per issue. The text is untrusted and is fenced as such downstream. */
const openIssues: Sensor = {
  name: "open_issues",
  origin: "untrusted",
  run({ paths, forge }) {
    const issues = forge.openIssues(paths.repoRoot, 20);
    return {
      detail: `${issues.length} open`,
      candidates: issues.map((issue) => ({
        fingerprint: `issue:${issue.number}`,
        text: `GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body ?? ""}`.trim(),
      })),
    };
  },
};

const todoHarvest: Sensor = {
  name: "todo_harvest",
  origin: "trusted",
  run({ paths }) {
    let out = "";
    try {
      out = execFileSync(
        "git",
        ["grep", "-n", "-E", "(TODO|FIXME)(\\(harness\\))?:"],
        { cwd: paths.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 },
      );
    } catch {
      return { candidates: [], detail: "none found" };
    }
    const hits = out.split("\n").filter(Boolean).slice(0, 10);
    return {
      detail: `${hits.length} marker(s)`,
      candidates: hits.map((line) => {
        const [file, lineNo, ...rest] = line.split(":");
        const note = rest.join(":").trim();
        return {
          fingerprint: `todo:${file}:${note.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60)}`,
          text: `Resolve the marker at ${file}:${lineNo}\n\n${note}`,
        };
      }),
    };
  },
};

const cveScan: Sensor = {
  name: "cve_scan",
  origin: "trusted",
  run({ paths }) {
    try {
      execFileSync("npm", ["audit", "--audit-level=high"], {
        cwd: paths.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv(), timeout: 5 * 60_000,
      });
      return { candidates: [], detail: "clean" };
    } catch (e) {
      const output = `${(e as { stdout?: string }).stdout ?? ""}`.trim().slice(-3000);
      if (!output) return { candidates: [], detail: "npm audit unavailable here" };
      return {
        detail: "advisories found",
        candidates: [{
          fingerprint: "cve_scan",
          text: `Dependency advisories at high severity or above. Update or replace what is affected.\n\n` +
            `\`\`\`\n${output}\n\`\`\``,
        }],
      };
    }
  },
};

export const SENSORS: Sensor[] = [brokenTests, openIssues, todoHarvest, cveScan];

function lastRun(events: HarnessEvent[], name: string): number {
  const last = [...events].reverse().find((e) => e.type === "sensor_ran" && e.sensor === name);
  return last ? Date.parse(last.ts) : 0;
}

/**
 * `now` is compared against event timestamps, so it must be on the same clock as
 * the log — a wall-clock millisecond value, not a synthetic one.
 */
export function dueSensors(events: HarnessEvent[], policy: Policy, now: number): Sensor[] {
  return SENSORS.filter((sensor) => {
    const config = policy.sensors[sensor.name];
    if (!config?.enabled) return false;
    return now - lastRun(events, sensor.name) >= parseCadence(config.every);
  });
}

/**
 * Runs whichever sensors are due and queues what is genuinely new. A sensor that
 * throws is recorded and skipped rather than taking the daemon down with it —
 * an unattended loop should survive a broken `gh` or an unreadable repository.
 */
export function runSensors(ctx: SensorContext, now: number): number {
  let queued = 0;
  for (const sensor of dueSensors(readAll(ctx.paths.eventsFile), ctx.policy, now)) {
    const config = ctx.policy.sensors[sensor.name];
    let found = 0;
    let detail = "";
    let added = 0;
    try {
      const result = sensor.run(ctx);
      found = result.candidates.length;
      detail = result.detail;
      for (const candidate of result.candidates) {
        const events = readAll(ctx.paths.eventsFile);
        if (isFingerprintSuppressed(events, candidate.fingerprint)) continue;
        addBacklog(ctx.paths.eventsFile, nextTaskId(events), {
          text: candidate.text,
          origin: config.origin ?? sensor.origin,
          source: sensor.name,
          fingerprint: candidate.fingerprint,
        });
        added += 1;
      }
    } catch (e) {
      detail = `sensor failed: ${(e as Error).message}`;
    }
    emit(ctx.paths.eventsFile, "daemon", "sensor_ran", {
      sensor: sensor.name, found, queued: added, detail,
    });
    queued += added;
  }
  return queued;
}
