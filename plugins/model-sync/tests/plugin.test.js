/** Behaviour of the registered plugin: when it runs, what it writes, how it fails. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "../index.js";
import { entryFor } from "../catalogue.js";

const ROW = { id: "gpt-5.6-sol", capabilities: { context_length: 922000, input_modalities: ["text", "image"], reasoning_effort: ["low", "ultra"] } };
const CURSOR_ROW = { id: "cursor/grok-4.6", capabilities: { context_length: 500000, input_modalities: ["text"] } };

/** A context carrying only what the plugin uses, plus the hooks it registers. */
function harness(resolved, policy) {
  const ready = [];
  const hooks = new Map();
  const logs = { info: [], warn: [] };
  const calls = [];
  const disposers = [];
  let revision = 3;
  // The service applies each path op to the section as it stands at the queue
  // front; the double does the same, so a second step in one run sees the first.
  const sections = { "llm-pi-ai": resolved, "subagent-model-selection": policy };
  const applyPath = (target, op) => {
    if (op.op !== "set" || target === undefined) return;
    let node = target;
    for (const key of op.path.slice(0, -1)) {
      if (node[key] === undefined) node[key] = {};
      node = node[key];
    }
    node[op.path.at(-1)] = op.value;
  };
  const settings = {
    get: (ns) => sections[ns],
    describe: () => [{ ns: "llm-pi-ai", revision: (revision += 1) }, { ns: "subagent-model-selection", revision: (revision += 1) }],
    mutate: async (ns, ops, expected) => {
      calls.push({ ns, ops, expected });
      for (const op of ops) applyPath(sections[ns], op);
    },
  };
  const ctx = {
    get: (name) => {
      if (name === "settings") return settings;
      if (name === "appReady") return { onReady: (listener) => ready.push(listener) };
      return undefined;
    },
    on: (event, listener) => hooks.set(event, listener),
    // Cordis invokes the effect callback and keeps its disposer; the double runs
    // the callback and records the disposer so disposal is observable.
    effect: (callback) => { disposers.push(callback()); },
    logger: { info: (message) => logs.info.push(message), warn: (message) => logs.warn.push(message) },
  };
  return { ctx, ready, hooks, logs, calls, settings, disposers };
}

/** Replace the global fetch for one test; the plugin calls the bare global. */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push(url);
    return handler(url, options);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const listing = (data) => async () => ({ ok: true, status: 200, json: async () => ({ data }) });

test("committed startup writes the plan it computed from the bridge", async () => {
  const resolved = { providers: { opencodex: { models: [] }, cursor: { models: [] } } };
  const { ctx, ready, logs, calls } = harness(resolved);
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ns, "llm-pi-ai");
  assert.deepEqual(calls[0].ops[0].path, ["providers", "opencodex", "models"]);
  assert.deepEqual(calls[0].ops[0].value, [entryFor(ROW, undefined)]);
  assert.equal(typeof calls[0].expected, "number");
  assert.match(logs.info.join("\n"), /startup; updated opencodex/);
  assert.deepEqual(logs.warn, []);
});

test("a Session opening inside the debounce window does not read the bridge again", async () => {
  const { ctx, ready, hooks } = harness({ providers: { opencodex: { models: [] } } });
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
    const second = hooks.get("agent/created")();
    assert.equal(second, undefined);
  } finally {
    fetchStub.restore();
  }
  assert.equal(fetchStub.seen.length, 1);
});

test("both routes are written, one write each, so one cannot block the other", async () => {
  const resolved = { providers: { opencodex: { models: [] }, cursor: { models: [] } } };
  const { ctx, ready, calls } = harness(resolved);
  const fetchStub = stubFetch(listing([ROW, CURSOR_ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.deepEqual(calls.map((call) => call.ops[0].path[1]), ["opencodex", "cursor"]);
});

test("a concurrent write is retried once, under the fence it re-read", async () => {
  const resolved = { providers: { opencodex: { models: [] } } };
  const { ctx, ready, calls, settings, logs } = harness(resolved);
  let attempt = 0;
  settings.mutate = async (ns, ops, expected) => {
    calls.push({ ns, ops, expected });
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("namespace moved");
      error.code = "SETTINGS_CONFLICT";
      throw error;
    }
  };
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].expected, calls[1].expected);
  assert.match(logs.info.join("\n"), /updated opencodex/);
});

test("after a conflict the plan is recomputed, so a now-current route is not overwritten", async () => {
  const resolved = { providers: { opencodex: { models: [] } } };
  const { ctx, ready, calls, settings } = harness(resolved);
  settings.mutate = async () => {
    calls.push({});
    // The concurrent writer stored exactly what we were about to write.
    resolved.providers.opencodex.models = [entryFor(ROW, undefined)];
    const error = new Error("namespace moved");
    error.code = "SETTINGS_CONFLICT";
    throw error;
  };
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.equal(calls.length, 1);
});

test("a refusal that is not a conflict is contained and logged", async () => {
  const { ctx, ready, logs, settings } = harness({ providers: { opencodex: { models: [] } } });
  settings.mutate = async () => { throw new Error("expected false | { low… } but got ultra"); };
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.deepEqual(logs.info, []);
  assert.match(logs.warn.join("\n"), /startup skipped: opencodex: expected false/);
});

test("an unreachable bridge is contained, and nothing is written", async () => {
  const { ctx, ready, logs, calls } = harness({ providers: { opencodex: { models: [] } } });
  const fetchStub = stubFetch(async () => { throw new Error("fetch failed"); });
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.deepEqual(calls, []);
  assert.match(logs.warn.join("\n"), /skipped: fetch failed/);
});

test("an already-current document is left alone", async () => {
  const resolved = { providers: { opencodex: { models: [entryFor(ROW, undefined)] } } };
  const { ctx, ready, calls, logs } = harness(resolved);
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs.info, []);
});

test("a bridge answering with a non-list body is contained", async () => {
  const { ctx, ready, logs } = harness({ providers: { opencodex: { models: [] } } });
  const fetchStub = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.match(logs.warn.join("\n"), /did not answer with a model list/);
});

test("one route's refusal does not withhold the other route's write", async () => {
  const resolved = { providers: { opencodex: { models: [] }, cursor: { models: [] } } };
  const { ctx, ready, calls, logs, settings } = harness(resolved);
  settings.mutate = async (ns, ops) => {
    calls.push(ops[0].path[1]);
    if (ops[0].path[1] === "opencodex") throw new Error("schema refuses opencodex");
  };
  const fetchStub = stubFetch(listing([ROW, CURSOR_ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  // The refused route must not abort the loop before the other route is attempted.
  assert.deepEqual(calls, ["opencodex", "cursor"]);
  assert.match(logs.info.join("\n"), /updated cursor/);
  assert.match(logs.warn.join("\n"), /skipped: opencodex: schema refuses opencodex/);
});

test("a write that never settles releases the latch, so the next trigger still runs", async () => {
  const { ctx, ready, hooks, logs, settings } = harness({ providers: { opencodex: { models: [] } } });
  settings.mutate = () => new Promise(() => {});
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, { minIntervalMs: 0, stuckAfterMs: 20 });
    ready[0]();
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    assert.notEqual(hooks.get("agent/created")(), undefined);
  } finally {
    fetchStub.restore();
  }
  assert.match(logs.warn.join("\n"), /still unsettled after 20 ms; releasing the latch/);
});

test("the delegation allow-list is mirrored to the routes the plugin maintains", async () => {
  const resolved = { providers: { opencodex: { models: [] }, cursor: { models: [] } } };
  const policy = { enabled: true, allowedModels: [
    { provider: "glm", model: "glm-4.5-air" },
    { provider: "cursor", model: "cursor/retired" },
  ] };
  const { ctx, ready, calls, logs } = harness(resolved, policy);
  const fetchStub = stubFetch(listing([ROW, CURSOR_ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  const mirrored = calls.find((call) => call.ns === "subagent-model-selection");
  assert.ok(mirrored !== undefined, "no allow-list write happened");
  assert.deepEqual(mirrored.ops[0].path, ["allowedModels"]);
  const value = mirrored.ops[0].value;
  assert.deepEqual(value[0], { provider: "glm", model: "glm-4.5-air" });
  assert.equal(value.some((entry) => entry.model === "cursor/retired"), false);
  assert.ok(value.some((entry) => entry.model === "cursor/grok-4.6"));
  assert.match(logs.info.join("\n"), /mirrored the delegation allow-list/);
});

test("no allow-list section means no allow-list write", async () => {
  const resolved = { providers: { opencodex: { models: [] } } };
  const { ctx, ready, calls } = harness(resolved);
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(ctx, {});
    await ready[0]();
  } finally {
    fetchStub.restore();
  }
  assert.equal(calls.some((call) => call.ns === "subagent-model-selection"), false);
});
