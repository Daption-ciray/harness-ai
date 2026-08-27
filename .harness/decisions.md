# Decisions

Append-only. Written by `scribe`, one entry per merged change, in the same PR as
the code it describes — so approving the code approves the memory.

Each entry records **why**, not what. The diff already records what.

---

## bk-3 — `harness tasks --json` returns raw task fields, not the padded display strings
<!-- anchors: src/cli/backlog.ts, bin/harness.ts -->

The text table pads/truncates fields for alignment; --json reuses the same task objects but emits unpadded raw values (id, state, task_class, origin, cost_usd, pr, text, last_error) so jq consumers get real data, not display formatting. Empty backlog short-circuits to `[]` before the human-readable 'no tasks' message, so the two output modes never share that branch.

**Constraint:** when adding output formats to CLI commands, branch on the flag before any human-readable-string special-casing (like 'no tasks'), so machine-readable output stays valid for empty/edge states
