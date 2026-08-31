# Driving harness from n8n

n8n owns the flow. The harness becomes what the flow calls: one endpoint per
role, plus worktree, integrate and merge.

The split matters. **n8n owns sequencing** — what happens next, what to branch
on, when to ask a person, where to post a notification. **The harness owns
semantics**, and everything that must not be skippable stays on its side: the
sandbox and permission screen inside every role call, git having exactly one
writer, and the merge gate. A flow cannot merge by rewiring around the gate,
because merging is only reachable through the endpoint that evaluates it.

Everything the flow does still lands in the same event log, so `harness trace`,
`harness stats` and `harness digest` keep working.

## What is here

```
n8n/
  build-workflows.mjs      generates the workflows from one description
  workflows/
    coordinator.json       the state machine: reads tasks, routes on state
    role-planner.json      one workflow per role — call, branch, extend
    role-builder.json
    role-adversary.json
    role-review.json
    role-security.json
    role-scribe.json
    role-devops.json
  setup.sh                 imports all of it, plus the credential
```

Edit `build-workflows.mjs` and regenerate rather than hand-editing the JSON:
eight workflows of positioned nodes and wired connections is exactly the kind of
file where renaming a node silently breaks a connection somewhere else.

Editing a workflow **in the n8n UI** is expected and fine — that is the point.
Regenerating will overwrite it, so export anything you want to keep.

## Setup

n8n runs on the host rather than in a container, deliberately: it can then reach
`127.0.0.1:7788` directly, and nothing has to be exposed on a wider interface.

```sh
npm install -g n8n

cd /your/project
harness serve                    # once, to mint the API token

./n8n/setup.sh /your/project     # imports workflows + the credential

N8N_USER_FOLDER=~/.n8n-harness n8n start
```

Open <http://127.0.0.1:5678>. The first run asks you to create an owner account —
that is n8n's own local login, and it is yours to set up.

Then: check the HTTP nodes are using the credential named `harness`, set
`baseUrl` in the coordinator's **Where harness is** node if you are not on the
default port, and activate `harness · coordinator`.

## How the coordinator works

It ticks once a minute, reads `GET /v1/tasks`, picks one — what a person asked
for first, then oldest first — and routes on its state:

| State | What it does |
|---|---|
| `queued` | run the planner |
| `planned` | create the worktree, then run the builder |
| `verifying` | ask who still owes a verdict, run that one; when none are left, mark it verified |
| `scribing` | record why |
| `integrating` | ask devops for its judgement, then commit, push and open the pull request |
| `awaiting_merge` | attempt the merge, which runs the gate and the tests |

One step per tick, like the built-in daemon and for the same reason: a long step
must not hold the loop, and a crash mid-step leaves a task that can simply be
looked at again.

## What you would actually change

- **A prompt** → still `src/roles/*.ts` in the harness. Prompts are behaviour, not
  flow, and one copy is the point.
- **Who verifies what, thresholds, budgets, the merge rules** → `.harness/policy.yaml`.
- **The flow** → here. Insert a Slack node after a veto. Put a human approval in
  front of `security`. Fan out to two reviewers. Trigger from a GitHub webhook
  instead of a schedule.
- **A new source of work** → `POST /v1/tasks` from any n8n trigger. Use
  `"origin": "untrusted"` for anything a stranger wrote; it is fenced as data on
  the way in and can never merge itself.

## The API

Token in `~/.harness/<repo-slug>/api-token`, sent as `Authorization: Bearer …`.

| | |
|---|---|
| `GET /v1/health` | what this harness is, and how it is configured |
| `GET /v1/tasks`, `GET /v1/tasks/:id` | task state |
| `GET /v1/tasks/:id/verifiers` | who still owes a verdict, the lease, any stall |
| `GET /v1/routing?paths=a,b` | which role policy routes those paths to |
| `POST /v1/tasks` | queue work — `{text, origin, source, fingerprint}` |
| `POST /v1/tasks/:id/{plan,build,verify,scribe,devops}` | run a role |
| `POST /v1/tasks/:id/worktree` | isolated worktree for the task |
| `POST /v1/tasks/:id/verified` | all verifiers reported |
| `POST /v1/tasks/:id/integrate` | commit, push, open the pull request, evaluate the gate |
| `POST /v1/tasks/:id/merge` | the only way to the default branch |
| `POST /v1/tasks/:id/{answer,cancel,fail}` | human decisions |

Role endpoints return `{ok, ...}` and never throw on a model failure — a flow
should branch on the result, not on an exception.
