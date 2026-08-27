# harness-ai

Multi-agent, always-on development harness that plugs into any git repo.

Seven roles (`planner`, `builder`, `adversary`, `review`, `security`, `devops`,
`scribe`) do the work and check each other. There is no fixed orchestrator:
leadership moves between roles via a **lease** driven by the routing table in
`.harness/policy.yaml`. A human is not asked to approve every merge — only the
cases listed under `merge.escalate_when`.

Design and rationale: [`SPEC.md`](./SPEC.md).

## Status

Early construction. Phase 0 (skeleton) in progress. See `SPEC.md` § 16 for the
phase plan.

## Requirements

- Node >= 22.18 (TypeScript runs directly via type stripping — no build step)
- `git` and the GitHub CLI (`gh`), authenticated
- A GitHub remote. The harness refuses to start without one.

## Quick start

```sh
npm install
node bin/harness.ts init      # writes .harness/policy.yaml
node bin/harness.ts start     # runs the daemon
node bin/harness.ts status
```

## Layout

| Path | Committed to your repo | What it holds |
|---|---|---|
| `<repo>/.harness/policy.yaml` | yes | routing, veto, model tiers, budget, merge rules |
| `<repo>/.harness/decisions.md` | yes | append-only record of *why*, written by `scribe` |
| `~/.harness/<repo-slug>/` | no | events, traces, backlog, leases, worktrees, derived context |

Rule of thumb: anything regenerable lives in the sidecar, anything irreplaceable
lives in the repo.
