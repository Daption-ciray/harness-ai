import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { append } from "./events.ts";
import { canUseTool, preToolUseHook, type Denial, type GuardContext } from "./permissions.ts";
import type { Policy, Role } from "./policy.ts";

export type Tier = { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; maxTurns: number };

export type SpawnInput = {
  role: Role;
  traceId: string;
  parentSpan?: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  tier: Tier;
  budgetUsd: number;
  ladderStep?: number;
  /** Omitted means "inherit every tool"; `[]` means a pure-text role. */
  tools?: string[];
  resume?: string;
};

export type SpanResult = {
  ok: boolean;
  spanId: string;
  text: string;
  sessionId: string;
  /** From `total_cost_usd` — it counts subagents. `usage` does not. */
  costUsd: number;
  modelUsage: Record<string, unknown>;
  numTurns: number;
  subtype: string;
  denials: Denial[];
  errors: string[];
};

export function newSpanId(): string {
  return randomUUID().slice(0, 8);
}

export async function spawn(input: SpawnInput, policy: Policy, eventsFile: string): Promise<SpanResult> {
  const spanId = newSpanId();
  const denials: Denial[] = [];
  const guard: GuardContext = { role: input.role, traceId: input.traceId, spanId, eventsFile, policy };

  // Written before the run, so a crash mid-span is visible on replay.
  append(eventsFile, {
    trace_id: input.traceId, span_id: spanId, parent_span: input.parentSpan,
    type: "span_start", role: input.role,
    model: input.tier.model, effort: input.tier.effort, ladder_step: input.ladderStep,
  });

  const result: SpanResult = {
    ok: false, spanId, text: "", sessionId: "", costUsd: 0,
    modelUsage: {}, numTurns: 0, subtype: "no_result", denials, errors: [],
  };

  try {
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        model: input.tier.model,
        effort: input.tier.effort,
        maxTurns: input.tier.maxTurns,
        // The SDK enforces the per-task budget; we do not have to police it.
        maxBudgetUsd: input.budgetUsd,
        systemPrompt: input.systemPrompt,
        ...(input.tools ? { allowedTools: input.tools } : {}),
        // The target repo must not configure our agents: a repo's own
        // .claude/settings.json could otherwise widen permissions.
        settingSources: [],
        permissionMode: "default",
        hooks: { PreToolUse: [preToolUseHook(guard, denials)] },
        canUseTool: canUseTool(guard, denials),
        ...(input.resume ? { resume: input.resume } : {}),
      },
    });

    for await (const message of q) {
      if (message.type !== "result") continue;
      result.sessionId = message.session_id;
      result.costUsd = message.total_cost_usd;
      result.modelUsage = message.modelUsage as Record<string, unknown>;
      result.numTurns = message.num_turns;
      result.subtype = message.subtype;
      if (message.subtype === "success") {
        result.ok = true;
        result.text = message.result;
      } else {
        result.errors = message.errors ?? [];
      }
    }
  } catch (e) {
    result.subtype = "spawn_threw";
    result.errors = [(e as Error).message];
  }

  append(eventsFile, {
    trace_id: input.traceId, span_id: spanId, parent_span: input.parentSpan,
    type: "span_end", role: input.role,
    model: input.tier.model, effort: input.tier.effort, ladder_step: input.ladderStep,
    cost_usd: result.costUsd, session_id: result.sessionId,
    outcome: result.ok ? "ok" : result.subtype,
    reason: result.errors[0],
    payload: { num_turns: result.numTurns, denials: denials.length, modelUsage: result.modelUsage },
  });

  return result;
}

/** Pulls the first fenced JSON block out of an agent's final text. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}
