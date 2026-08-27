import { randomUUID } from "node:crypto";
import type { AgentOutcome, AgentRunner, Denial } from "./agent-runner.ts";
import { emit } from "./events.ts";
import { screenCommand } from "./permissions.ts";
import type { Effort, Policy, Role } from "./policy.ts";
import type { ToolPolicy } from "./roles/tools.ts";

export type Tier = { model: string; effort: Effort; maxTurns: number };

export type SpanInput = {
  role: Role;
  traceId: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  tier: Tier;
  ladderStep: number;
  budgetUsd: number;
  tools: ToolPolicy;
  resume?: string;
};

export type SpanResult = AgentOutcome & { spanId: string; denials: Denial[] };

export type SpanDeps = { policy: Policy; eventsFile: string; runner: AgentRunner };

export function newSpanId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * One agent run, bracketed by its own events. `span_start` is written before the
 * model is reached, so a process killed mid-run leaves a span that the log shows
 * as opened and never closed — which is precisely how a reader should see it.
 */
export async function runSpan(input: SpanInput, deps: SpanDeps): Promise<SpanResult> {
  const spanId = newSpanId();
  const denials: Denial[] = [];
  const common = {
    span_id: spanId, role: input.role, model: input.tier.model,
    effort: input.tier.effort, ladder_step: input.ladderStep,
  };

  emit(deps.eventsFile, input.traceId, "span_start", common);

  const outcome = await deps.runner({
    role: input.role,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.tier.model,
    effort: input.tier.effort,
    maxTurns: input.tier.maxTurns,
    budgetUsd: input.budgetUsd,
    tools: input.tools,
    resume: input.resume,
    screenCommand: (command) => screenCommand(deps.policy, input.role, command),
    onDenial: (denial) => {
      denials.push(denial);
      // Recorded, so a leak in the single-writer rule shows up in the trace
      // instead of passing silently.
      emit(deps.eventsFile, input.traceId, "tool_denied", {
        span_id: spanId, role: input.role,
        tool: denial.tool, reason: denial.reason, command: denial.command,
      });
    },
  });

  emit(deps.eventsFile, input.traceId, "span_end", {
    ...common,
    cost_usd: outcome.costUsd,
    session_id: outcome.sessionId,
    ok: outcome.ok,
    subtype: outcome.subtype,
    num_turns: outcome.numTurns,
    denials: denials.length,
    error: outcome.errors[0] ?? null,
    model_usage: outcome.modelUsage,
  });

  return { ...outcome, spanId, denials };
}

/** Pulls the first fenced JSON block out of an agent's final text. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = fenced ? fenced[1] : (start >= 0 && end > start ? text.slice(start, end + 1) : "");
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
