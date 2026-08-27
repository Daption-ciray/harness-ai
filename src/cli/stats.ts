import { readAll } from "../events.ts";
import { resolvePaths } from "../paths.ts";
import { loadPolicy } from "../policy.ts";
import { buildStats, type Stats } from "../report.ts";
import { costBasis, costLabel } from "../billing.ts";
import { duration, money } from "./format.ts";

function bar(fraction: number, width = 24): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function table(rows: [string, number][], format: (n: number) => string): string[] {
  if (rows.length === 0) return ["  (none)"];
  const max = Math.max(...rows.map(([, n]) => n));
  return rows
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `  ${key.padEnd(14)} ${bar(max === 0 ? 0 : n / max, 18)} ${format(n)}`);
}

export function render(stats: Stats, basis: ReturnType<typeof costBasis>): string {
  const out: string[] = [];

  out.push(`${stats.tasks} tasks · ${money(stats.spend.total)}`);
  out.push(`  ${costLabel(basis)}`, "");

  out.push("outcomes");
  out.push(...table(Object.entries(stats.outcomes), String), "");

  out.push("spend by role");
  out.push(...table(Object.entries(stats.spend.byRole), money), "");

  out.push("spend by model");
  out.push(...table(Object.entries(stats.spend.byModel), money), "");

  // The cheap-first bet, scored. If tasks routinely climb, the ladder is
  // starting on the wrong rung and every task pays for that discovery twice.
  const { finished, onFirstAttempt, climbs } = stats.ladder;
  out.push("escalation ladder");
  out.push(finished === 0
    ? "  (nothing has finished yet)"
    : `  ${onFirstAttempt}/${finished} finished without climbing  ${bar(onFirstAttempt / finished)}  ` +
      `${climbs} climb(s) in total`);
  out.push("");

  out.push("median time by role");
  out.push(...table(Object.entries(stats.medianDurationMs), duration), "");

  // The most actionable number here. A verifier blocking on the same thing
  // across tasks is describing a rule, and a rule belongs in policy — not in a
  // model round paid for on every task that trips over it.
  out.push("what keeps blocking");
  if (stats.vetoes.recurring.length === 0) {
    out.push("  nothing recurring yet");
  } else {
    for (const p of stats.vetoes.recurring) {
      out.push(`  ${String(p.tasks.length).padStart(2)}× ${p.summary.slice(0, 68)}`);
      out.push(`      seen on ${p.tasks.join(", ")} — this is a policy rule, not a model round`);
    }
  }
  out.push("");

  out.push("vetoes by role");
  out.push(...table(Object.entries(stats.vetoes.byRole), String), "");

  if (Object.keys(stats.denials.byReason).length) {
    out.push("guard denials");
    out.push(...table(Object.entries(stats.denials.byReason), String), "");
  }

  if (Object.keys(stats.stalls).length) {
    out.push("stalls");
    out.push(...table(Object.entries(stats.stalls), String), "");
  }

  // Zero cache reads across many spans is the signature of a silent invalidator
  // in the stable prefix: expensive, and otherwise invisible.
  const { read, created, ratio } = stats.cache;
  out.push("prefix cache");
  out.push(read + created === 0
    ? "  (no spans yet)"
    : `  ${Math.round(ratio * 100)}% read from cache  ${bar(ratio)}  ` +
      `${Math.round(read / 1000)}k read, ${Math.round(created / 1000)}k written`);
  if (read === 0 && created > 0) {
    out.push("  nothing is being reused — something in the stable prefix is changing per spawn");
  }

  return out.join("\n");
}

export function stats(cwd: string, sinceDays = 30): string {
  const paths = resolvePaths(cwd);
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const built = buildStats(readAll(paths.eventsFile), loadPolicy(paths.policyFile), since);
  return render(built, costBasis());
}
