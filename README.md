# harness-ai

Multi-agent, always-on development harness that plugs into any git repo.

Seven roles (`planner`, `builder`, `adversary`, `review`, `security`, `devops`,
`scribe`) do the work and check each other. There is no fixed orchestrator:
leadership moves between roles via a **lease** driven by the routing table in
`.harness/policy.yaml`. A human is not asked to approve every merge — only the
cases listed under `merge.escalate_when`.

Design and rationale: [`SPEC.md`](./SPEC.md).

## Status

Phases 0-3 complete and verified end to end against a real repository. See
`SPEC.md` § 16 for the phase plan.

## Design

Three properties the rest of the code depends on:

**The event log is the only source of truth.** `events.jsonl` is append-only,
and task state is a pure fold over it (`src/projection.ts`). Nothing is stored
twice, so nothing can drift, and a daemon killed at any point recovers exactly
the state its log describes. Truncating the log at any event yields the state
that prefix describes — there is a test for that.

**The model and the forge are behind ports.** `AgentRunner` and `Forge`
(`src/agent-runner.ts`, `src/github.ts`) each ship a real adapter and a test
double. Routing, tiering, scope enforcement, the state machine, git plumbing and
the whole planner → builder → devops chain are exercised against the doubles
over a real git repository with a real bare `origin`, so the only thing that
costs money to test is the adapter itself.

**Security is layered, and the layers do different jobs.** The OS sandbox
(macOS Seatbelt, Linux/WSL2) is the only real enforcement over Bash — a regex
cannot make a shell safe — and it runs with `allowUnsandboxedCommands: false`,
against the SDK default, so the model cannot opt out of it. Permission deny
rules cover the in-process file tools the Bash sandbox does not reach, written
as `Edit(...)` because a `Write(...)` rule is never matched. Our own `screenTool`
runs first in the permission flow, records every denial to the trace, and holds
where no sandbox is available. See `SPEC.md` § 9.

**One writer per resource.** Only `devops` may run `git` or `gh`, enforced by a
PreToolUse screen with a `canUseTool` backstop; only `scribe` will write memory.
An advisory lock (`src/lock.ts`) keeps a CLI invocation and a daemon tick from
advancing the same task into two worktrees and two pull requests.

## Requirements

- Node >= 22.18 (TypeScript runs directly via type stripping — no build step)
- `git` and the GitHub CLI (`gh`), authenticated
- A GitHub remote. The harness refuses to start without one.

## Quick start

```sh
npm install
node bin/harness.ts init                      # writes .harness/policy.yaml
node bin/harness.ts backlog add "do a thing"  # queue work
node bin/harness.ts run                       # advance one stage, in the foreground
node bin/harness.ts start                     # or run the daemon
node bin/harness.ts status
```

`HARNESS_HOME` relocates the sidecar, which is how the tests stay off your home
directory.

## Layout

| Path | Committed to your repo | What it holds |
|---|---|---|
| `<repo>/.harness/policy.yaml` | yes | routing, veto, model tiers, budget, merge rules |
| `<repo>/.harness/decisions.md` | yes | append-only record of *why*, written by `scribe` |
| `~/.harness/<repo-slug>/` | no | the event log, the lock, worktrees, derived context |

Rule of thumb: anything regenerable lives in the sidecar, anything irreplaceable
lives in the repo.
