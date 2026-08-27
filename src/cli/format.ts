import type { HarnessEvent } from "../events.ts";

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * One line per event. A typed switch rather than a bag of optional fields, so
 * adding an event type without deciding how it reads is a compile error.
 */
export function describe(event: HarnessEvent): string {
  switch (event.type) {
    case "daemon_start": return `pid ${event.pid} · tick ${event.tick_seconds}s`;
    case "daemon_stop": return event.signal;
    case "paused": return "dispatch idle";
    case "resumed": return "dispatch live";
    case "backlog_add": return `${event.origin} · ${event.source} · ${event.text}`;
    case "task_planned":
      return `${event.task_class} · rung ${event.ladder_step} · ${event.scope.length} scope, ${event.acceptance.length} criteria`;
    case "ladder_advanced": return `rung ${event.from} → ${event.to} · ${event.reason}`;
    case "build_done": return `${event.files.length} files changed`;
    case "worktree_open":
      return `${event.branch}${event.setup_error ? ` · setup failed: ${event.setup_error}` : ""}`;
    case "worktree_close": return event.dir;
    case "span_start": return `${event.role} · ${event.model} · ${event.effort} · rung ${event.ladder_step}`;
    case "span_end":
      return `${event.role} · ${money(event.cost_usd)} · ${event.num_turns} turns · ` +
        `${event.ok ? "ok" : event.subtype}${event.denials ? ` · ${event.denials} denied` : ""}`;
    case "tool_denied": return `${event.role} · ${event.tool} · ${event.command}`;
    case "veto": return `${event.role} · ${event.kind} · ${event.reason}`;
    case "preempt": return `${event.from} → ${event.to} · ${event.reason}`;
    case "lease_acquired": return `${event.holder} · ${event.reason} · ttl ${event.ttl_seconds}s`;
    case "lease_released": return `${event.holder} · ${event.reason}`;
    case "pr_opened":
      return `#${event.number} ${event.draft ? "draft" : "ready"} · ${event.files} files, ${event.lines} lines · ${event.url}`;
    case "ci_result": return `${event.ok ? "green" : "red"} · ${event.summary}`;
    case "merge": return `${event.by} · ${event.sha.slice(0, 8)}`;
    case "escalate": return event.reason;
    case "task_failed": return event.reason;
    case "budget_pause": return `${event.window} budget · ${money(event.spent_usd)} of ${money(event.limit_usd)}`;
    case "flag": return `${event.kind} · ${event.detail}`;
    case "revert": return `${event.sha.slice(0, 8)} · ${event.reason}`;
  }
}
