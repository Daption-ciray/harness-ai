import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./domain.ts";
import { summaryKey } from "./domain.ts";
import type { HarnessEvent } from "./events.ts";
import type { Policy } from "./policy.ts";

/**
 * The brief every agent is given is DERIVED, not stored.
 *
 * Its sources are `decisions.md` — which by construction holds only decisions
 * that merged, because the entry travels in the same pull request as the code —
 * and the event log. So there is no separate file to keep current, no question
 * of when `scribe` should refresh it, and no way for the brief to describe a
 * change that never landed.
 *
 * It is also why the prefix stays cacheable: the text changes when a decision
 * merges or a pitfall crosses its threshold, not on every spawn.
 */

export type Decision = {
  id: string;
  title: string;
  /** Files the decision is about. When none of them survive, it has expired. */
  anchors: string[];
  body: string;
  /** A rule this decision imposes on future work, if it imposes one. */
  constraint: string | null;
};

const HEADER = `# Decisions

Append-only. Written by \`scribe\`, one entry per merged change, in the same pull
request as the code it describes — so approving the code approves the memory.

Each entry records **why**, not what. The diff already records what.

---
`;

export function decisionsHeader(): string {
  return HEADER;
}

/** `## bk-12 — Retries are bounded` followed by an anchors comment. */
export function parseDecisions(text: string): Decision[] {
  const decisions: Decision[] = [];
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split("\n");
    const match = heading.match(/^(\S+)\s+[—-]\s+(.*)$/);
    if (!match) continue;
    const rawBody = rest.join("\n");
    const anchorLine = rawBody.match(/<!--\s*anchors:\s*(.*?)\s*-->/);
    const constraint = rawBody.match(/^\*\*Constraint:\*\*\s*(.+)$/m);
    decisions.push({
      id: match[1],
      title: match[2].trim(),
      anchors: (anchorLine?.[1] ?? "").split(",").map((a) => a.trim()).filter(Boolean),
      // The constraint is parsed into its own field; leaving it in the body too
      // would duplicate the line on the next append.
      body: rawBody
        .replace(/<!--\s*anchors:[\s\S]*?-->/, "")
        .replace(/^\*\*Constraint:\*\*\s*.+$/m, "")
        .trim(),
      constraint: constraint?.[1].trim() ?? null,
    });
  }
  return decisions;
}

export function renderDecision(decision: Decision): string {
  return [
    `## ${decision.id} — ${decision.title}`,
    `<!-- anchors: ${decision.anchors.join(", ")} -->`,
    ``,
    decision.body,
    decision.constraint ? `\n**Constraint:** ${decision.constraint}` : "",
    ``,
  ].join("\n");
}

export function appendDecision(existing: string, decision: Decision): string {
  const base = existing.trim() === "" ? HEADER : existing;
  return `${base.replace(/\s*$/, "")}\n\n${renderDecision(decision)}`;
}

/**
 * A decision whose anchors have all disappeared is describing code that no
 * longer exists. It stays in the repository as history, but it stops being
 * asserted to agents as current fact — a memory that has quietly gone stale is
 * worse than no memory, because it is believed.
 */
export function isLive(decision: Decision, repoRoot: string): boolean {
  if (decision.anchors.length === 0) return true;
  return decision.anchors.some((anchor) => existsSync(join(repoRoot, anchor.split(":")[0])));
}

export type Pitfall = { key: string; summary: string; tasks: string[] };

/**
 * A blocker raised on several different tasks is not bad luck, it is a property
 * of this codebase. Promoting it to a standing rule is what stops the loop
 * rediscovering it at full price every time.
 */
export function pitfalls(events: HarnessEvent[], threshold: number): Pitfall[] {
  const seen = new Map<string, { summary: string; tasks: Set<string> }>();
  for (const event of events) {
    if (event.type !== "veto") continue;
    for (const finding of event.findings as Finding[]) {
      if (finding.severity !== "blocker") continue;
      const key = summaryKey(finding);
      const entry = seen.get(key) ?? { summary: finding.summary, tasks: new Set<string>() };
      entry.tasks.add(event.trace_id);
      seen.set(key, entry);
    }
  }
  return [...seen.entries()]
    .filter(([, v]) => v.tasks.size >= threshold)
    .map(([key, v]) => ({ key, summary: v.summary, tasks: [...v.tasks].sort() }))
    .sort((a, b) => b.tasks.length - a.tasks.length);
}

export type ContextSources = {
  repoRoot: string;
  decisionsText: string;
  events: HarnessEvent[];
  policy: Policy;
  /** Repo profile written by the planner's cold start, when there is one. */
  repoProfile?: string;
};

/**
 * Trimmed by dropping whole sections from the bottom up, never by cutting a
 * sentence in half: a brief that ends mid-thought reads as a fact.
 */
function fitBudget(sections: string[], budget: number): string {
  const out: string[] = [];
  let size = 0;
  for (const section of sections) {
    if (size + section.length > budget) break;
    out.push(section);
    size += section.length;
  }
  return out.join("\n\n");
}

/**
 * Deliberately free of timestamps, task ids and counters. This text is the tail
 * of the cached prefix on every spawn, and one changing byte in it invalidates
 * the cache for every agent that follows.
 */
export function renderContext(sources: ContextSources): string {
  const { policy, repoRoot } = sources;
  const live = parseDecisions(sources.decisionsText).filter((d) => isLive(d, repoRoot));
  const recent = live.slice(-policy.memory.decisions_in_context).reverse();
  const constraints = live.filter((d) => d.constraint).map((d) => d.constraint as string);
  const traps = pitfalls(sources.events, policy.memory.pitfall_threshold);

  const sections: string[] = [`# Project brief`];

  if (sources.repoProfile?.trim()) {
    sections.push(`## Repository\n\n${sources.repoProfile.trim()}`);
  } else {
    sections.push([
      `## Repository`, ``,
      `- default branch: ${policy.repo.default_branch}`,
      `- tests: \`${policy.repo.test_cmd}\``,
      ...(policy.repo.build_cmd ? [`- build: \`${policy.repo.build_cmd}\``] : []),
      ...(policy.repo.lint_cmd ? [`- lint: \`${policy.repo.lint_cmd}\``] : []),
    ].join("\n"));
  }

  if (constraints.length) {
    sections.push([`## Standing constraints`, ``,
      ...constraints.map((c) => `- ${c}`)].join("\n"));
  }
  if (traps.length) {
    sections.push([
      `## Known pitfalls in this codebase`, ``,
      `Each of these was found on ${policy.memory.pitfall_threshold} or more separate tasks.`, ``,
      ...traps.map((t) => `- ${t.summary}`),
    ].join("\n"));
  }
  if (recent.length) {
    sections.push([`## Recent decisions and why`, ``,
      ...recent.map((d) => `- **${d.title}** — ${d.body.split("\n")[0]}`)].join("\n"));
  }

  return fitBudget(sections, policy.memory.context_budget_chars);
}

export function loadDecisions(decisionsFile: string): string {
  return existsSync(decisionsFile) ? readFileSync(decisionsFile, "utf8") : HEADER;
}
