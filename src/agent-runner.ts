import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Role } from "./policy.ts";
import type { ToolPolicy } from "./roles/tools.ts";

export type Denial = { tool: string; reason: string; command: string };

export type AgentRequest = {
  role: Role;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  model: string;
  effort: Effort;
  maxTurns: number;
  budgetUsd: number;
  tools: ToolPolicy;
  resume?: string;
  /** Denies a Bash command before it runs; returns the reason, or null to allow. */
  screenCommand: (command: string) => string | null;
  onDenial: (denial: Denial) => void;
};

export type AgentOutcome = {
  ok: boolean;
  text: string;
  sessionId: string;
  /** From `total_cost_usd`, which counts subagents. `usage` does not. */
  costUsd: number;
  modelUsage: Record<string, unknown>;
  numTurns: number;
  subtype: string;
  errors: string[];
};

/**
 * The seam between the harness and the model. Everything above this line —
 * routing, tiering, scope enforcement, git plumbing, the state machine — is
 * exercised in tests against `scriptedRunner`, so the only thing that costs
 * money to test is the adapter itself.
 */
export type AgentRunner = (req: AgentRequest) => Promise<AgentOutcome>;

const EMPTY: AgentOutcome = {
  ok: false, text: "", sessionId: "", costUsd: 0,
  modelUsage: {}, numTurns: 0, subtype: "no_result", errors: [],
};

export const sdkRunner: AgentRunner = async (req) => {
  const outcome: AgentOutcome = { ...EMPTY };
  try {
    const q = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        model: req.model,
        effort: req.effort,
        maxTurns: req.maxTurns,
        // The SDK enforces the per-task ceiling, so we do not have to police it.
        maxBudgetUsd: req.budgetUsd,
        systemPrompt: req.systemPrompt,
        ...(req.tools.allow ? { allowedTools: req.tools.allow } : {}),
        // `allowedTools` auto-approves but does NOT restrict. Restriction is
        // `disallowedTools`, so every role names what it must not reach.
        ...(req.tools.deny.length ? { disallowedTools: req.tools.deny } : {}),
        // The target repository must not configure our agents: its own
        // .claude/settings.json could otherwise widen permissions.
        settingSources: [],
        permissionMode: "default",
        hooks: {
          PreToolUse: [{
            hooks: [async (input) => {
              if (input.hook_event_name !== "PreToolUse") return {};
              const pre = input as { tool_name: string; tool_input: unknown };
              if (pre.tool_name !== "Bash") return {};
              const command = String((pre.tool_input as { command?: unknown })?.command ?? "");
              const reason = req.screenCommand(command);
              if (!reason) return {};
              req.onDenial({ tool: pre.tool_name, reason, command });
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: reason,
                },
              };
            }],
          }],
        },
        // Last barrier. Anything that still falls through to a prompt is denied:
        // an unattended daemon has nobody to ask.
        canUseTool: async (toolName, input) => {
          if (toolName === "Bash") {
            const reason = req.screenCommand(String((input as { command?: unknown })?.command ?? ""));
            if (reason) {
              req.onDenial({ tool: toolName, reason, command: String((input as { command?: unknown })?.command ?? "") });
              return { behavior: "deny", message: reason };
            }
          }
          return { behavior: "allow" };
        },
        ...(req.resume ? { resume: req.resume } : {}),
      },
    });

    for await (const message of q) {
      if (message.type !== "result") continue;
      outcome.sessionId = message.session_id;
      outcome.costUsd = message.total_cost_usd;
      outcome.modelUsage = message.modelUsage as Record<string, unknown>;
      outcome.numTurns = message.num_turns;
      outcome.subtype = message.subtype;
      if (message.subtype === "success") {
        outcome.ok = true;
        outcome.text = message.result;
      } else {
        outcome.errors = message.errors ?? [];
      }
    }
  } catch (e) {
    outcome.subtype = "runner_threw";
    outcome.errors = [(e as Error).message];
  }
  return outcome;
};

export type ScriptedStep = {
  role: Role;
  ok?: boolean;
  text?: string;
  costUsd?: number;
  subtype?: string;
  errors?: string[];
  /** Commands the scripted agent "tries" to run, so the guard is exercised too. */
  attempts?: string[];
  /** What the agent did to the filesystem. Lets the whole pipeline be tested. */
  act?: (cwd: string) => void;
};

/**
 * Replays a fixed script in order, asserting that each step is consumed by the
 * role it was written for. A mismatch means the pipeline took a different path
 * than the test intended, which is exactly what such a test should catch.
 */
export function scriptedRunner(steps: ScriptedStep[]): AgentRunner & { remaining: () => number } {
  let index = 0;
  const runner = (async (req: AgentRequest): Promise<AgentOutcome> => {
    const step = steps[index++];
    if (!step) throw new Error(`scripted runner exhausted: ${req.role} asked for step ${index}`);
    if (step.role !== req.role) {
      throw new Error(`scripted step ${index - 1} is for \`${step.role}\` but \`${req.role}\` ran`);
    }
    for (const command of step.attempts ?? []) {
      const reason = req.screenCommand(command);
      if (reason) req.onDenial({ tool: "Bash", reason, command });
    }
    step.act?.(req.cwd);
    return {
      ...EMPTY,
      ok: step.ok ?? true,
      text: step.text ?? "",
      sessionId: `scripted-${index}`,
      costUsd: step.costUsd ?? 0.01,
      numTurns: 1,
      subtype: step.subtype ?? (step.ok === false ? "error_during_execution" : "success"),
      errors: step.errors ?? [],
    };
  }) as AgentRunner & { remaining: () => number };
  runner.remaining = () => steps.length - index;
  return runner;
}
