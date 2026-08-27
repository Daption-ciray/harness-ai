/**
 * What the cost figures in this harness actually mean.
 *
 * The Agent SDK bundles the Claude Code binary and inherits whatever credentials
 * Claude Code has. With an API key set, `total_cost_usd` is a real charge. With a
 * subscription — the usual case, credentials living in the OS keychain rather
 * than in an env var — it is a NOTIONAL equivalent: nothing is drawn from a
 * balance, and reporting it as money spent would be false.
 *
 * The rails work either way, because they govern the same number. What changes
 * is the risk they are protecting against. Under a subscription the harness is
 * eating the same usage allowance as the person's own interactive sessions, so
 * running out does not produce a bill — it stops them working. That is worse
 * than a small charge, which is why the daily rail matters more under a
 * subscription, not less.
 */
export type CostBasis = "billed" | "subscription";

export function costBasis(env: NodeJS.ProcessEnv = process.env): CostBasis {
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "billed" : "subscription";
}

export function costLabel(basis: CostBasis): string {
  return basis === "billed"
    ? "billed to the API key in this environment"
    : "estimated equivalent — no API key set, so this draws on the Claude subscription's allowance, not a balance";
}
