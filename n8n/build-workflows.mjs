#!/usr/bin/env node
/**
 * Generates the n8n workflows from one description.
 *
 * Written rather than hand-authored because eight workflows of positioned nodes
 * and wired connections is the kind of JSON that rots the moment it is edited by
 * hand: a renamed node breaks a connection somewhere you are not looking. Change
 * the shape here and regenerate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "workflows");
const BASE = "={{ $json.baseUrl }}";

let idSeed = 0;
const uid = (name) => `${name}-${(idSeed += 1).toString(36)}`;

function node(name, type, typeVersion, parameters, [x, y], extra = {}) {
  return { parameters, id: uid(name), name, type, typeVersion, position: [x, y], ...extra };
}

/** Every call to the harness goes through the same credential and error policy. */
function http(name, method, path, position, body) {
  return node(name, "n8n-nodes-base.httpRequest", 4.2, {
    method,
    url: `${BASE}${path}`,
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendBody: body !== undefined,
    ...(body === undefined ? {} : {
      specifyBody: "json",
      jsonBody: body,
    }),
    options: { response: { response: { neverError: true } }, timeout: 1800000 },
  }, position, { alwaysOutputData: true });
}

function connect(pairs) {
  const connections = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
    connections[from].main[outputIndex].push({ node: to, type: "main", index: 0 });
  }
  return connections;
}

function workflow(name, nodes, connections, extra = {}) {
  return {
    name, nodes, connections,
    settings: { executionOrder: "v1" },
    active: false,
    ...extra,
  };
}

/**
 * One workflow per role. Thin on purpose: the point is that the branch after the
 * call is somewhere you can see and extend — post to Slack on a veto, require a
 * person before accepting one, record findings elsewhere.
 */
function roleWorkflow({ name, endpoint, body, successField }) {
  const trigger = node("When called by the coordinator",
    "n8n-nodes-base.executeWorkflowTrigger", 1.1,
    { workflowInputs: { values: [
      { name: "taskId" }, { name: "baseUrl" },
    ] } }, [0, 0]);

  const call = http(`harness · ${name}`, "POST", `/v1/tasks/{{ $json.taskId }}${endpoint}`, [220, 0], body);

  const branch = node("Did it succeed?", "n8n-nodes-base.if", 2, {
    conditions: {
      options: { caseSensitive: true, version: 2, typeValidation: "loose" },
      combinator: "and",
      conditions: [{
        leftValue: `={{ $json.${successField} }}`,
        rightValue: "",
        operator: { type: "boolean", operation: "true", singleValue: true },
      }],
    },
  }, [460, 0]);

  const ok = node("Done", "n8n-nodes-base.noOp", 1, {}, [700, -100]);
  const failed = node("Needs attention", "n8n-nodes-base.noOp", 1, {}, [700, 100]);

  return workflow(`harness · role · ${name}`,
    [trigger, call, branch, ok, failed],
    connect([
      [trigger.name, call.name],
      [call.name, branch.name],
      [branch.name, ok.name, 0],
      [branch.name, failed.name, 1],
    ]));
}

const ROLES = [
  { name: "planner", endpoint: "/plan", successField: "ok" },
  { name: "builder", endpoint: "/build", successField: "ok" },
  { name: "adversary", endpoint: "/verify", successField: "ok", body: '={{ JSON.stringify({ role: "adversary" }) }}' },
  { name: "review", endpoint: "/verify", successField: "ok", body: '={{ JSON.stringify({ role: "review" }) }}' },
  { name: "security", endpoint: "/verify", successField: "ok", body: '={{ JSON.stringify({ role: "security" }) }}' },
  { name: "scribe", endpoint: "/scribe", successField: "ok" },
  { name: "devops", endpoint: "/devops", successField: "ok" },
];

/**
 * The coordinator is the state machine. Each branch is one step: it does that
 * step and stops, and the next tick picks the task up in its new state. Same
 * shape as the built-in daemon, for the same reason — a long step must not hold
 * the loop, and a crash mid-step leaves a task that can simply be looked at
 * again.
 */
function coordinator() {
  const trigger = node("Every minute", "n8n-nodes-base.scheduleTrigger", 1.2,
    { rule: { interval: [{ field: "minutes", minutesInterval: 1 }] } }, [0, 0]);

  const config = node("Where harness is", "n8n-nodes-base.set", 3.4, {
    assignments: { assignments: [
      { id: "base", name: "baseUrl", value: "http://127.0.0.1:7788", type: "string" },
    ] },
    options: {},
  }, [200, 0]);

  const list = http("harness · tasks", "GET", "/v1/tasks", [400, 0]);

  const split = node("One task at a time", "n8n-nodes-base.splitOut", 1, {
    fieldToSplitOut: "data", options: {},
  }, [600, 0]);

  const pick = node("Pick the next one", "n8n-nodes-base.code", 2, {
    jsCode: [
      "// What a person asked for goes first, then oldest first — the same order",
      "// the built-in daemon uses. One task per tick keeps a long step from",
      "// holding the loop.",
      "const ACTIVE = ['queued', 'planned', 'verifying', 'scribing', 'integrating', 'awaiting_merge'];",
      "const baseUrl = $('Where harness is').first().json.baseUrl;",
      "const tasks = items.map(i => i.json).filter(t => ACTIVE.includes(t.state));",
      "tasks.sort((a, b) =>",
      "  Number(b.source === 'human') - Number(a.source === 'human') ||",
      "  a.created_at.localeCompare(b.created_at));",
      "if (!tasks.length) return [];",
      "return [{ json: { ...tasks[0], taskId: tasks[0].id, baseUrl } }];",
    ].join("\n"),
  }, [800, 0]);

  const router = node("What does it need?", "n8n-nodes-base.switch", 3, {
    rules: { values: [
      ...["queued", "planned", "verifying", "scribing", "integrating", "awaiting_merge"].map((state) => ({
        conditions: {
          options: { caseSensitive: true, version: 2, typeValidation: "loose" },
          combinator: "and",
          conditions: [{
            leftValue: "={{ $json.state }}",
            rightValue: state,
            operator: { type: "string", operation: "equals" },
          }],
        },
        outputKey: state,
      })),
    ] },
    options: { fallbackOutput: "none" },
  }, [1020, 0]);

  const sub = (name, roleName, position) => node(name,
    "n8n-nodes-base.executeWorkflow", 1.2, {
      workflowId: { __rl: true, mode: "list", value: "", cachedResultName: `harness · role · ${roleName}` },
      workflowInputs: { mappingMode: "defineBelow", value: {
        taskId: "={{ $json.taskId }}", baseUrl: "={{ $json.baseUrl }}",
      } },
      options: { waitForSubWorkflow: true },
    }, position);

  const planner = sub("Plan it", "planner", [1300, -320]);
  const worktree = http("harness · worktree", "POST", "/v1/tasks/{{ $json.taskId }}/worktree", [1300, -180]);
  const builder = sub("Build it", "builder", [1540, -180]);

  const owed = http("harness · who still owes a verdict", "GET",
    "/v1/tasks/{{ $json.taskId }}/verifiers", [1300, -40]);
  const nextVerifier = node("Which verifier?", "n8n-nodes-base.switch", 3, {
    rules: { values: ["adversary", "review", "security"].map((role) => ({
      conditions: {
        options: { caseSensitive: true, version: 2, typeValidation: "loose" },
        combinator: "and",
        conditions: [{
          leftValue: "={{ $json.pending[0] }}",
          rightValue: role,
          operator: { type: "string", operation: "equals" },
        }],
      },
      outputKey: role,
    })) },
    options: { fallbackOutput: "extra", renameFallbackOutput: "all reported" },
  }, [1540, -40]);

  const adversary = sub("Try to break it", "adversary", [1800, -160]);
  const review = sub("Review it", "review", [1800, -60]);
  const security = sub("Security review", "security", [1800, 40]);
  const allReported = http("harness · verified", "POST",
    "/v1/tasks/{{ $('Pick the next one').first().json.taskId }}/verified", [1800, 140]);

  const scribe = sub("Record why", "scribe", [1300, 200]);
  const devops = sub("Judge the change", "devops", [1300, 340]);
  const integrate = http("harness · integrate", "POST",
    "/v1/tasks/{{ $('Pick the next one').first().json.taskId }}/integrate", [1540, 340],
    "={{ JSON.stringify($json) }}");
  const merge = http("harness · merge", "POST",
    "/v1/tasks/{{ $json.taskId }}/merge", [1300, 480]);

  return workflow("harness · coordinator",
    [trigger, config, list, split, pick, router, planner, worktree, builder,
      owed, nextVerifier, adversary, review, security, allReported,
      scribe, devops, integrate, merge],
    connect([
      [trigger.name, config.name],
      [config.name, list.name],
      [list.name, split.name],
      [split.name, pick.name],
      [pick.name, router.name],
      [router.name, planner.name, 0],
      [router.name, worktree.name, 1],
      [worktree.name, builder.name],
      [router.name, owed.name, 2],
      [owed.name, nextVerifier.name],
      [nextVerifier.name, adversary.name, 0],
      [nextVerifier.name, review.name, 1],
      [nextVerifier.name, security.name, 2],
      [nextVerifier.name, allReported.name, 3],
      [router.name, scribe.name, 3],
      [router.name, devops.name, 4],
      [devops.name, integrate.name],
      [router.name, merge.name, 5],
    ]));
}

mkdirSync(OUT, { recursive: true });
const written = [];
for (const role of ROLES) {
  const file = join(OUT, `role-${role.name}.json`);
  writeFileSync(file, JSON.stringify(roleWorkflow(role), null, 2) + "\n");
  written.push(file);
}
const coord = join(OUT, "coordinator.json");
writeFileSync(coord, JSON.stringify(coordinator(), null, 2) + "\n");
written.push(coord);
console.log(`${written.length} workflows written to ${OUT}`);
