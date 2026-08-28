# harness-ai

A development harness that plugs into any git repository. You tell it what you
want, or it notices something is wrong; it plans the work, writes the code,
tries to break it, reviews it, records why, and opens a pull request. You stay
in the loop where it matters and out of it where it doesn't.

It is not a chat window with tools. It is a daemon with seven roles, a policy
file, and an append-only log of everything it has ever done.

```sh
harness ask "add avatar upload to the profile page"
harness start
```

---

## What actually happens

```
you ask for something ─┐
                       ├─► planner    plans it, writes machine-checkable
sensor finds a problem ┘              acceptance criteria — or asks you a
                                      question rather than guessing
                          builder     writes the code and its tests, in an
                                      isolated worktree
                          adversary   tries to break it. May write a failing
                                      test; may not fix the code
                          review      judges it as a maintainer would
                          security    enters only when the change touches auth,
                                      crypto, migrations, secrets. Holds the
                                      only hard veto
                          scribe      records WHY, in the same commit as the code
                          devops      commits, opens the pull request
                                          │
                                    you, or — once you turn it on and it has
                                    earned it — the harness itself
```

A veto sends the work back to the builder with the specific blockers to resolve.
The next revision is judged afresh. If the same complaint comes back twice, the
loop stops and asks you — arguing in circles at your expense is not progress.

## Install

Needs **Node 22.18+**, the **GitHub CLI** (`gh`) signed in, and a repository with
a GitHub remote. No build step — the TypeScript runs directly.

```sh
git clone <this repo> && cd harness-ai
npm install
npm link          # puts `harness` on your PATH
```

## Use it

```sh
cd /your/project
harness init                          # detects how your repo builds and tests
```

`init` reads `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml` or a
`Makefile`. If it cannot tell, it says so and leaves a placeholder rather than
guessing. **Read `.harness/policy.yaml` before starting** — especially
`repo.test_cmd` and `budget.per_day_usd`.

```sh
harness ask "add a --json flag to the export command"
harness ask --file spec.md            # or pipe it in: harness ask < spec.md

harness run                           # advance one stage, in the foreground
harness start                         # or let the daemon run it
```

Trying it for the first time, use `run` rather than `start`. It advances one
stage and stops, so you see each role's work before paying for the next.

```sh
harness waiting                       # everything that needs you, and why
harness answer bk-3 "use Auth0"       # unblock a question
harness trace bk-3                    # one task's whole life, as a tree
harness ui                            # live dashboard on 127.0.0.1:7777
harness digest                        # what happened while you were away
```

## What stops it doing damage

This is the part worth reading before you leave it running.

**It cannot merge anything by default.** `merge.auto` ships off; every change
becomes a pull request for you. If you turn it on, a change still needs three
things: no escalation rule matches, GitHub reports it genuinely mergeable, and
**the harness runs your test suite itself and it passes**. The adversary saying
tests pass is a model's account of what it saw; nothing merges on an account.

**Autonomy is earned.** The first twenty merges go to a person regardless.

**Work that came from a stranger never merges itself.** A task built from a
GitHub issue is marked `untrusted`, its text is fenced as data rather than
instructions, and no combination of rules lets it reach your default branch
unread. That single rule is the prompt-injection cut-off.

**Only one role touches git.** `devops` runs `git` and `gh`; every other role
writes files and the harness commits them. Enforced by a screen that understands
command position — `git push` is refused, `grep "not a git repository"` is not.

**The agents are sandboxed.** Kernel-level, over Bash and every child process.
Verified rather than assumed: a command our own screen deliberately allowed
(`echo escaped > /tmp/probe`) came back `operation not permitted`, and the file
was never written. Set `runtime.sandbox: container` and the repository's own
commands — including the pre-merge test run, which executes code the agents just
wrote — move into a Docker sandbox where `~/.ssh` simply does not exist and
egress is default-deny.

**A misspelled safety rule breaks startup.** Policy is strict: a typo in an
escalation rule is a loud failure at load time, not a rule that silently stopped
existing.

**Nothing runs unattended without a budget.** Per task and per day, and the
daemon pauses itself rather than merely complaining.

## What it costs

The SDK inherits your Claude Code credentials. With `ANTHROPIC_API_KEY` set, the
figures are real charges. With a subscription — credentials in your OS keychain,
no key in the environment — they are a **notional equivalent**: nothing is drawn
from a balance. `harness status` tells you which applies.

The budget rails work either way, but they protect something different. Under a
subscription the harness eats the same allowance as your own interactive
sessions, so exhausting it does not produce a bill — it stops you working. The
daily cap matters more under a subscription, not less.

A small feature, end to end, costs roughly $0.20–$1.50 of that allowance.

## Four decisions everything else follows from

**The event log is the only source of truth.** Task state is a pure fold over an
append-only file (`src/projection.ts`). Nothing is stored twice, so nothing can
drift, and a daemon killed at any point recovers exactly what its log describes.
Truncating the log at any event yields the state that prefix describes — there
is a test for that.

**Deciding must be free.** Which model, which effort, which class, which
verifier: all from file globs, diff size, source and retry count. Nothing ever
asks a model which model to use.

**One writer per resource.** `devops` owns git, `scribe` owns memory. Both exist
so a race is structurally impossible rather than merely unlikely — and `scribe`
returns its entry for the harness to write, so even it cannot touch the file.

**Fail closed.** A rule that cannot be evaluated escalates. A fact that cannot be
established escalates. A sandbox that will not start refuses the run rather than
falling back to the host.

## The roles, and why each exists

A role earns its place only with a veto domain of its own, an incompatible
incentive, or sole ownership of something everyone reads. Everything else is a
prompt variation, not a role.

| Role | Veto | Why it is separate |
|---|---|---|
| `planner` | — | Owns the plan and the acceptance criteria |
| `builder` | — | The only role that writes code. Scales in parallel |
| `adversary` | soft | Incompatible incentive: it is paid to break the builder's work |
| `review` | soft, 2 rounds | Quality and fit with the surrounding code |
| `security` | **hard** | The only hard veto. Enters by routing, on real paths |
| `devops` | soft | Sole writer for git and CI. Thin judgement over thick plumbing |
| `scribe` | — | Sole writer for memory. No veto, no authority, only a flag |

There is no fixed orchestrator. Which role decides the next step is a TTL'd
**lease** that moves by routing rules; `security` is the only role that can take
it from anyone, and taking it never kills work in flight.

## Memory

`.harness/decisions.md` is committed to your repository, one entry per merged
change, written in the same pull request as the code it explains — so approving
the code approves the memory with it. Each entry records *why*, not what.

The brief every agent receives is **derived** from that file plus repeated
findings in the log. There is no second file to keep current, and it cannot
describe a change that never landed. Entries carry file anchors and stop being
asserted once those files are gone: memory that has quietly gone stale is worse
than none, because it is believed.

It also sits in the cached prefix, which measured at 91% of prompt tokens read
from cache across 1.5M.

## Where things live

Regenerable goes in the sidecar; irreplaceable goes in your repository.

| Path | Committed | Holds |
|---|---|---|
| `.harness/policy.yaml` | yes | routing, veto, model tiers, budget, merge rules |
| `.harness/decisions.md` | yes | why each change was made |
| `.harness-worktrees/` | no (gitignored) | one isolated worktree per task |
| `~/.harness/<repo>/` | no | the event log, the lock, derived context |

`HARNESS_HOME` relocates the sidecar.

## Status, honestly

Seven phases complete, 229 tests, three runtime dependencies, no build step.

It has been run unattended: one request in, six minutes, a merged pull request
out — and three real defects that only an unattended run would have found. It
has not yet been left alone for a night. `merge.auto` is off, and turning it on
is your deliberate act.

Known limits, in `SPEC.md` § 9 and § 17: the OS sandbox's proxy does not
terminate TLS, so a broad allowed domain can in principle be fronted — the
container mode closes that; multi-repo means one daemon per repository; and the
harness has done one task, not a night's work.

`SPEC.md` is the full design record, including the reasoning behind every
decision above and the ones that were rejected.
