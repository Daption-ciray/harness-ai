import { existsSync } from "node:fs";
import { isAlive, readState } from "../daemon.ts";
import { readAll } from "../events.ts";
import { lockHolder } from "../lock.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { listTasks, spendSince } from "../projection.ts";
import { ago, describe, money } from "./format.ts";
import { costBasis, costLabel } from "../billing.ts";

function row(label: string, value: string): string {
  return `${label.padEnd(10)} ${value}`;
}

export function status(cwd = process.cwd(), limit = 8): string {
  const paths = resolvePaths(cwd);
  const state = readState(paths.stateFile);
  const alive = isAlive(state);
  const lines: string[] = [`harness · ${paths.slug}`];

  lines.push(row("state", alive
    ? `${state.status} (pid ${state.pid}) · last tick ${ago(state.last_tick)} · ${state.tick_count} ticks`
    : state.pid !== null ? `stopped (stale pid ${state.pid})` : "stopped"));

  const holder = lockHolder(paths.lockFile);
  if (holder) lines.push(row("lock", `${holder.owner} (pid ${holder.pid}) since ${ago(holder.at)}`));

  if (!existsSync(paths.policyFile)) {
    lines.push(row("policy", "missing — run `harness init`"));
    return lines.join("\n");
  }

  let dailyLimit = 0;
  try {
    const p = loadPolicy(paths.policyFile);
    dailyLimit = p.budget.per_day_usd;
    lines.push(row("policy", `7 roles · merge.auto ${p.merge.auto ? "ON" : "off"} · ` +
      `cap ${money(p.budget.per_task_usd)}/task ${money(p.budget.per_day_usd)}/day`));
    lines.push(row("runtime", `sandbox ${p.runtime.sandbox} · tick ${p.runtime.tick_seconds}s · ` +
      `max ${p.runtime.max_concurrent_builders} builders`));
  } catch (e) {
    lines.push(row("policy", `INVALID — ${(e as Error).message.split("\n")[0]}`));
  }

  const events = readAll(paths.eventsFile);
  const tasks = listTasks(events);
  const spentToday = spendSince(events, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const byState = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.state] = (acc[t.state] ?? 0) + 1;
    return acc;
  }, {});

  const basis = costBasis();
  lines.push(row("usage", `~${money(spentToday)} in the last 24h` +
    (dailyLimit ? ` of a ${money(dailyLimit)} cap (${Math.round((spentToday / dailyLimit) * 100)}%)` : "")));
  lines.push(row("", `  ${costLabel(basis)}`));
  lines.push(row("tasks", tasks.length
    ? Object.entries(byState).map(([s, n]) => `${n} ${s}`).join(" · ")
    : "none"));

  const blocked = tasks.filter((t) => t.state === "blocked");
  for (const task of blocked) {
    const q = task.exchanges.find((e) => e.answer === null)?.question ?? "";
    lines.push(row("waiting", `${task.id} needs an answer — ${q}`));
    lines.push(row("", `  harness answer ${task.id} "..."`));
  }

  lines.push(row("events", `${events.length} total`));
  for (const event of events.slice(-limit)) {
    lines.push(`  ${ago(event.ts).padEnd(9)} ${event.trace_id.padEnd(8)} ${event.type.padEnd(15)} ${describe(event)}`);
  }
  return lines.join("\n");
}
