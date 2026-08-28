# harness-ai

Multi-agent, always-on development harness that plugs into any git repo.

Seven roles (`planner`, `builder`, `adversary`, `review`, `security`, `devops`,
`scribe`) do the work and check each other. There is no fixed orchestrator:
leadership moves between roles via a **lease** driven by the routing table in
`.harness/policy.yaml`. A human is not asked to approve every merge — only the
cases listed under `merge.escalate_when`.

Design and rationale: [`SPEC.md`](./SPEC.md).

## Status

All seven phases complete and verified end to end against a real repository. See
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

**Auto-merge is earned, and every gate fails closed.** `merge.auto` ships off.
Turned on, a change still reaches the default branch only if no escalation rule
matches *and* its own test suite passes when the harness runs it — the
adversary's report that tests pass is a model's account, and nothing merges on an
account. A rule the evaluator does not recognise breaks policy loading rather
than being ignored, because a silently deleted escalation rule auto-merges
exactly the case it was written to catch. Work whose origin is untrusted never
merges itself, under any combination of rules. `harness revert <id>` undoes a
merge the harness made.

**Observability reads from one place.** `trace`, `stats` and the dashboard are
three renderings of the same pure functions over the event log (`src/report.ts`),
because three copies of the same aggregation drift apart and the first time they
disagree nobody knows which is lying. The most actionable number is *what keeps
blocking*: a verifier that blocks on the same thing across tasks is describing a
rule, and a rule belongs in policy rather than in a model round paid for on every
task that trips over it.

**Work comes from sensors, and they are plain code.** Noticing that the test
suite is red does not need a model, so nothing pays one to notice it every
fifteen minutes. Each candidate carries a fingerprint that is stable for the
*problem* rather than the observation, which is what stops a sensor queueing the
same red suite ninety-six times a day. `harness init` works out how to build and
test the repository the same way — by reading `package.json`, `go.mod`, a
`Makefile` — and says so plainly when it cannot tell.

**Memory is derived, not maintained.** The brief every agent is given is
rendered from `decisions.md` — which holds only decisions that merged, because
the entry travels in the same pull request as the code — plus repeated findings
in the event log. There is no second file to refresh, and the brief cannot
describe a change that never landed. It carries no timestamps or ids, so it sits
in the cached prefix: measured at 12,582 tokens read from cache on a second
spawn. See `SPEC.md` § 10.

**Two isolation boundaries, for two different things.** The OS sandbox covers
what the *agents* do — kernel-enforced over Bash and every child process.
`runtime.sandbox: container` covers what the *harness* runs on the repository's
behalf: worktree setup, the test sensor, and the test run before an automatic
merge. That last one executes code the agents just wrote, moments before it
reaches the default branch, and on the host it had no isolation at all.

Measured inside a `docker sandbox`: `~/.ssh` and `~/.aws/credentials` are simply
not present, and egress is default-deny — an allowlisted host answers 200, an
unlisted one 403. Startup refuses if Docker is unreachable, and refuses again if
the repository's test command passes on the host but fails inside, because a
sandbox that cannot build the repo would make a healthy project look permanently
broken.

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

## What the cost figures mean

The SDK bundles the Claude Code binary and inherits whatever credentials Claude
Code has. With `ANTHROPIC_API_KEY` set, `total_cost_usd` is a real charge. With a
subscription — credentials in the OS keychain, no key in the environment — it is
a **notional equivalent**: nothing is drawn from a balance, and calling it money
spent would be false. `harness status` says which basis applies.

The budget rails govern the same number either way, so they still stop the
daemon. What changes is what they protect. Under a subscription the harness eats
the same allowance as your own interactive sessions, so exhausting it does not
produce a bill — it stops you working. The daily cap matters more under a
subscription, not less.

## Requirements

- Node >= 22.18 (TypeScript runs directly via type stripping — no build step)
- `git` and the GitHub CLI (`gh`), authenticated
- A GitHub remote. The harness refuses to start without one.

## Quick start

```sh
npm install
node bin/harness.ts init                       # writes .harness/policy.yaml
node bin/harness.ts ask "add a --json flag"    # ask for a change
node bin/harness.ts ask --file spec.md         # ...or hand it a spec
node bin/harness.ts start                      # run the daemon
node bin/harness.ts waiting                    # what needs you, and why
node bin/harness.ts answer bk-3 "use Auth0"    # unblock a question
node bin/harness.ts trace bk-3                 # one task's whole life
node bin/harness.ts stats                      # where the time and allowance went
node bin/harness.ts ui                         # live dashboard on 127.0.0.1:7777
node bin/harness.ts digest                     # what happened while you were away
node bin/harness.ts revert bk-3 "broke prod"   # undo a merge the harness made
```

Work reaches the harness two ways: **you ask for it**, or a sensor finds it.
What you asked for runs first and is never held up by the queue the harness
filled itself — that queue caps what the harness starts on its own, not what you
instruct it to do. When the planner cannot write acceptance criteria without
knowing something, it asks rather than guessing, and your answer is carried into
the next attempt so you never retype the request.

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
