/** Behaviour of the catalogue reconciliation: routing, capability mapping, the write plan. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { entryFor, label, planOps, planPolicyOps, routeFor, signature } from "../catalogue.js";

/** The reasoning levels the profile schema accepts; the bridge advertises more. */
const SCHEMA_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** One published row, shaped like the bridge's /v1/models entries. */
function row(id, capabilities = {}) {
  return { id, object: "model", owned_by: id.split("/")[0], capabilities };
}

const NATIVE = {
  context_length: 922000,
  max_output_tokens: 128000,
  input_modalities: ["text", "image"],
  // The bridge really does publish `ultra`; the schema does not accept it.
  reasoning_effort: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

test("routeFor sends each published id to the provider that owns it", () => {
  assert.equal(routeFor("gpt-5.6-sol"), "opencodex");
  assert.equal(routeFor("openai/gpt-6-luna"), "opencodex");
  assert.equal(routeFor("cursor/grok-4.6"), "cursor");
  assert.equal(routeFor("deepseek/deepseek-v4-pro"), undefined);
  assert.equal(routeFor("kimi-code/k3"), undefined);
});

test("label capitalizes known words, joins version runs, and marks a fast variant", () => {
  assert.equal(label("gpt-5.6-sol"), "GPT 5.6 Sol");
  assert.equal(label("claude-opus-4-7"), "Claude Opus 4.7");
  assert.equal(label("grok-4.6"), "Grok 4.6");
  assert.equal(label("kimi-k3"), "Kimi K3");
  assert.equal(label("gpt-6-astra--fast"), "GPT 6 Astra (Fast)");
  assert.equal(label("openai/gpt-6-luna"), "GPT 6 Luna");
});

test("entryFor carries the advertised capacities, minus the rungs the schema forbids", () => {
  const entry = entryFor({ id: "gpt-5.6-sol", capabilities: NATIVE });
  assert.equal(entry.contextWindow, 922000);
  assert.equal(entry.maxTokens, 128000);
  assert.deepEqual(entry.input, ["text", "image"]);
  // `ultra` is dropped, never renamed onto another level: a key outside the
  // schema's set makes the whole section unservable.
  assert.deepEqual(Object.keys(entry.reasoningEfforts), ["low", "medium", "high", "xhigh", "max"]);
  for (const level of Object.keys(entry.reasoningEfforts)) assert.ok(SCHEMA_LEVELS.includes(level), level);
});

test("entryFor omits capacities the schema would refuse", () => {
  // contextWindow/maxTokens are floored at 1; a zero or fractional advertisement
  // must fall back to the route default instead of being stored and rejected.
  assert.deepEqual(entryFor({ id: "x", capabilities: { context_length: 0, max_output_tokens: 0 } }), { id: "x", name: "x", input: ["text"] });
  assert.deepEqual(entryFor({ id: "x", capabilities: { context_length: 1.5 } }).contextWindow, undefined);
  assert.equal(entryFor({ id: "x", capabilities: { context_length: 1 } }).contextWindow, 1);
});

test("entryFor keeps only the modalities the schema accepts", () => {
  assert.deepEqual(entryFor({ id: "x", capabilities: { input_modalities: ["text", "audio"] } }).input, ["text"]);
  // An advertised list the schema cannot express at all still yields a servable model.
  assert.deepEqual(entryFor({ id: "x", capabilities: { input_modalities: ["audio"] } }).input, ["text"]);
  assert.deepEqual(entryFor({ id: "x" }).input, ["text"]);
});

test("entryFor carries no ladder for a model that advertises none, and honours an authored label", () => {
  assert.deepEqual(entryFor({ id: "composer-2.5", capabilities: { context_length: 200000, input_modalities: ["text"] } }), {
    id: "composer-2.5", name: "Composer 2.5", contextWindow: 200000, input: ["text"],
  });
  assert.equal(entryFor({ id: "x" }, "authored").name, "authored");
});

test("signature ignores key order but sees a real change in capacities or in a mapped level", () => {
  const left = [{ id: "a", name: "A", input: ["text", "image"], reasoningEfforts: { high: "high" } }];
  const right = [{ id: "a", name: "A", reasoningEfforts: { high: "high" }, input: ["image", "text"] }];
  assert.equal(signature(left), signature(right));
  assert.notEqual(signature(left), signature([{ ...left[0], contextWindow: 1 }]));
  assert.notEqual(signature(left), signature([{ id: "a", name: "A", input: ["text", "image"], reasoningEfforts: { high: "xhigh" } }]));
});

test("a route absent from the published list is left exactly as declared", () => {
  const resolved = { providers: { opencodex: { models: [{ id: "gpt-6-astra" }] }, cursor: { models: [{ id: "cursor/auto" }] } } };
  const ops = planOps([row("gpt-5.6-sol", NATIVE)], resolved);
  assert.deepEqual(ops.map((op) => op.path), [["providers", "opencodex", "models"]]);
  assert.deepEqual(ops[0].value.map((model) => model.id), ["gpt-5.6-sol"]);
});

test("an already-current route is not rewritten", () => {
  const resolved = { providers: { opencodex: { models: [entryFor({ id: "gpt-5.6-sol", capabilities: NATIVE })] } } };
  assert.deepEqual(planOps([row("gpt-5.6-sol", NATIVE)], resolved), []);
});

test("a declared label survives the rewrite, and other families are ignored", () => {
  const resolved = { providers: { opencodex: { models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol (my label)" }] } } };
  const ops = planOps([
    row("gpt-5.6-sol", NATIVE),
    row("deepseek/deepseek-v4-pro", NATIVE),
    row("kimi-code/k3", NATIVE),
    row("cursor/grok-4.6", NATIVE),
  ], resolved);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].value[0].name, "GPT-5.6 Sol (my label)");
});

test("a route the document does not declare is never created", () => {
  assert.deepEqual(planOps([row("cursor/auto", NATIVE)], { providers: { opencodex: { models: [] } } }), []);
});

test("a duplicated published id is written once", () => {
  // Resolution filters BOTH copies of a duplicated id out of the servable list.
  const ops = planOps([row("gpt-5.4"), row("gpt-5.4")], { providers: { opencodex: { models: [] } } });
  assert.deepEqual(ops[0].value.map((model) => model.id), ["gpt-5.4"]);
});

test("the routes argument narrows the plan to the routes asked for", () => {
  const rows = [row("gpt-5.6-sol", NATIVE), row("cursor/grok-4.6", NATIVE)];
  const resolved = { providers: { opencodex: { models: [] }, cursor: { models: [] } } };
  assert.deepEqual(planOps(rows, resolved, ["cursor"]).map((op) => op.path[1]), ["cursor"]);
  assert.deepEqual(planOps(rows, resolved, ["opencodex"]).map((op) => op.path[1]), ["opencodex"]);
});

test("cursor rows are published verbatim under their own route", () => {
  const ops = planOps([row("cursor/grok-4.6", { context_length: 500000, input_modalities: ["text", "image"], reasoning_effort: ["low", "medium", "high", "xhigh"] })],
    { providers: { cursor: { models: [] } } });
  assert.deepEqual(ops[0].value[0], {
    id: "cursor/grok-4.6", name: "Grok 4.6", contextWindow: 500000, input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  });
});

test("malformed rows, a non-array catalogue and a non-array declared list are survivable", () => {
  assert.deepEqual(planOps([{ id: 7 }, null, { id: "gpt-5.4" }], { providers: { opencodex: { models: [] } } })
    .flatMap((op) => op.value.map((model) => model.id)), ["gpt-5.4"]);
  assert.deepEqual(planOps(undefined, { providers: { opencodex: { models: [] } } }), []);
  assert.deepEqual(planOps([row("gpt-5.4")], { providers: { opencodex: { models: "no" } } })
    .flatMap((op) => op.value.map((model) => model.id)), ["gpt-5.4"]);
});

test("the delegation allow-list mirrors the maintained routes and keeps other providers", () => {
  const resolved = { providers: { opencodex: { models: [{ id: "gpt-5.6-sol" }] }, cursor: { models: [{ id: "cursor/grok-4.6" }] } } };
  const allowed = [
    { provider: "glm", model: "glm-4.5-air" },
    { provider: "cursor", model: "cursor/retired" },
    { provider: "opencodex", model: "gpt-6-astra" },
  ];
  const ops = planPolicyOps(allowed, resolved, [row("gpt-5.6-sol", NATIVE), row("cursor/grok-4.6", NATIVE)]);
  assert.deepEqual(ops[0].path, ["allowedModels"]);
  assert.deepEqual(ops[0].value, [
    { provider: "glm", model: "glm-4.5-air" },
    { provider: "opencodex", model: "gpt-5.6-sol" },
    { provider: "cursor", model: "cursor/grok-4.6" },
  ]);
});

test("an allow-list already in step is left alone, reordering included", () => {
  const resolved = { providers: { cursor: { models: [{ id: "cursor/a" }] } } };
  const rows = [row("cursor/a", NATIVE)];
  assert.deepEqual(planPolicyOps([{ provider: "cursor", model: "cursor/a" }], resolved, rows), []);
  assert.deepEqual(planPolicyOps([{ provider: "cursor", model: "cursor/a" }], resolved, []), []);
  // No allow-list section resolved: not ours to create.
  assert.deepEqual(planPolicyOps(undefined, resolved, rows), []);
});

test("a route the bridge publishes nothing for keeps its delegation entries", () => {
  const resolved = { providers: { cursor: { models: [{ id: "cursor/a" }] } } };
  const allowed = [{ provider: "cursor", model: "cursor/a" }, { provider: "cursor", model: "cursor/offline" }];
  assert.deepEqual(planPolicyOps(allowed, resolved, []), []);
});

test("the allow-list is deduplicated", () => {
  const resolved = { providers: { cursor: { models: [{ id: "cursor/a" }] } } };
  const ops = planPolicyOps([{ provider: "cursor", model: "cursor/a" }, { provider: "cursor", model: "cursor/a" }], resolved, [row("cursor/a", NATIVE)]);
  assert.deepEqual(ops, []);
});
