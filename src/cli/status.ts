import { existsSync } from "node:fs";
import { isAlive, readState } from "../daemon.ts";
import { readAll } from "../events.ts";
import { loadPolicy } from "../policy.ts";
import { resolvePaths } from "../paths.ts";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function row(label: string, value: string): string {
  return `${label.padEnd(10)} ${value}`;
}

export function status(cwd = process.cwd(), limit = 8): string {
  const paths = resolvePaths(cwd);
  const state = readState(paths.stateFile);
  const alive = isAlive(state);
  const lines: string[] = [`harness · ${paths.slug}`];

  const live = alive
    ? `${state.status} (pid ${state.pid})   last tick ${ago(state.last_tick)} · ${state.tick_count} ticks`
    : state.pid !== null
      ? `stopped (stale pid ${state.pid})`
      : "stopped";
  lines.push(row("state", live));

  if (existsSync(paths.policyFile)) {
    try {
      const p = loadPolicy(paths.policyFile);
      lines.push(row("policy", `7 roles · merge.auto ${p.merge.auto ? "ON" : "off"} · ` +
        `budget $${p.budget.per_task_usd.toFixed(2)}/task $${p.budget.per_day_usd.toFixed(2)}/day`));
      lines.push(row("runtime", `sandbox ${p.runtime.sandbox} · tick ${p.runtime.tick_seconds}s · ` +
        `max ${p.runtime.max_concurrent_builders} builders`));
    } catch (e) {
      lines.push(row("policy", `INVALID — ${(e as Error).message.split("\n")[0]}`));
    }
  } else {
    lines.push(row("policy", "missing — run `harness init`"));
  }

  const events = readAll(paths.eventsFile);
  lines.push(row("events", `${events.length} total`));
  for (const e of events.slice(-limit)) {
    const bits = [e.role, e.outcome ?? e.reason].filter(Boolean).join(" ");
    lines.push(`  ${ago(e.ts).padEnd(9)} ${e.trace_id.padEnd(10)} ${e.type}${bits ? " · " + bits : ""}`);
  }
  return lines.join("\n");
}
