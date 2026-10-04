/** Behaviour of the registered plugin: when it runs, what it writes, how it fails. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { apply, inject } from "../index.js";
import { entryFor } from "../catalogue.js";

const ROW = { id: "gpt-5.6-sol", capabilities: { context_length: 922000, input_modalities: ["text", "image"], reasoning_effort: ["low", "ultra"] } };
const CURSOR_ROW = { id: "cursor/grok-4.6", capabilities: { context_length: 500000, input_modalities: ["text"] } };

/** A context carrying only what the plugin uses, plus the hooks it registers. */
const cleanup = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function harness(resolved, policy, credentials) {
  const ready = [];
  const hooks = new Map();
  const logs = { info: [], warn: [] };
  const calls = [];
  const disposers = [];
  let revision = 3;
  // The service applies each path op to the section as it stands at the queue
  // front; the double does the same, so a second step in one run sees the first.
  const sections = { "llm-pi-ai": resolved, "subagent-model-selection-settings": policy };
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
    describe: () => Object.entries(sections).map(([ns, value]) => ({ ns, value, revision: (revision += 1) })),
    mutate: async (ns, ops, expected) => {
      calls.push({ ns, ops, expected });
      for (const op of ops) applyPath(sections[ns], op);
    },
  };
  const ctx = {
    get: (name) => {
      if (name === "settings") return settings;
      if (name === "appReady") return { onReady: (listener) => {
        ready.push(listener);
        return () => ready.splice(ready.indexOf(listener), 1);
      } };
      if (name === "credentials") return credentials;
      return undefined;
    },
    on: (event, listener) => hooks.set(event, listener),
    // Cordis invokes the effect callback and keeps its disposer; the double runs
    // the callback and records the disposer so disposal is observable.
    effect: (callback) => { const dispose = callback(); disposers.push(dispose); cleanup.push(dispose); },
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
  assert.match(logs.warn.join("\n"), /skipped: catalogue request failed/);
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
  const mirrored = calls.find((call) => call.ns === "subagent-model-selection-settings");
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
  assert.equal(calls.some((call) => call.ns === "subagent-model-selection-settings"), false);
});

test('startup declares all services and refreshes periodically without new Sessions', async () => {
  assert.deepEqual(inject, ['settings', 'appReady', 'credentials']);
  const state = harness({ providers: { opencodex: { models: [] } } });
  let release;
  const refreshed = new Promise(resolve => { release = resolve; });
  const fetchStub = stubFetch(async () => {
    if (fetchStub.seen.length === 2) release();
    return { ok: true, json: async () => ({ data: [ROW] }) };
  });
  try {
    apply(state.ctx, { refreshIntervalMs: 15 });
    assert.equal(state.hooks.get('agent/created')(), undefined, 'startup must commit first');
    await state.ready[0]();
    await Promise.race([refreshed, new Promise((_, reject) => setTimeout(() => reject(new Error('periodic refresh missing')), 1000))]);
    assert.ok(fetchStub.seen.length >= 2, 'periodic refresh is independent of Session debounce');
    await state.disposers[0]();
    const count = fetchStub.seen.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(fetchStub.seen.length, count);
  } finally { fetchStub.restore(); }
});

test('explicit credentials are resolved at each request and never written into settings', async () => {
  let secret = 'first-test-token';
  const resolved = { providers: { opencodex: { models: [], headers: { 'x-operator': 'keep' } } } };
  const state = harness(resolved, undefined, { resolve: async ref => {
    assert.equal(ref, 'GATEWAY_KEY');
    return { value: secret };
  } });
  const auth = [];
  const fetchStub = stubFetch(async (url, options) => {
    auth.push(options.headers.get('authorization'));
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ data: [ROW] }) };
  });
  try {
    apply(state.ctx, { credentialRef: 'GATEWAY_KEY', minIntervalMs: 0, refreshIntervalMs: 0 });
    await state.ready[0]();
    secret = 'rotated-test-token';
    await state.hooks.get('agent/created')();
  } finally { fetchStub.restore(); }
  assert.deepEqual(auth, ['Bearer first-test-token', 'Bearer rotated-test-token']);
  assert.equal(JSON.stringify(state.calls).includes('test-token'), false);
  assert.equal(JSON.stringify(state.logs).includes('test-token'), false);
  assert.deepEqual(resolved.providers.opencodex.headers, { 'x-operator': 'keep' });
});

test('configured but missing credentials preserve the catalogue without a request', async () => {
  const original = [{ id: 'already-working' }];
  const state = harness({ providers: { opencodex: { models: original } } }, undefined, { resolve: async () => undefined });
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(state.ctx, { credentialRef: 'UNSET_KEY' });
    await state.ready[0]();
  } finally { fetchStub.restore(); }
  assert.deepEqual(fetchStub.seen, []);
  assert.deepEqual(state.calls, []);
  assert.match(state.logs.warn.join('\n'), /credential is not configured/);
});

test('existing provider headers authenticate only its own catalogue endpoint', async () => {
  const providers = {
    opencodex: { baseURL: 'http://127.0.0.1:10100/v1', headers: { authorization: 'Bearer provider-test-token', 'x-account': 'test-account' }, models: [] },
    cursor: { baseURL: 'https://other.example/v1', headers: { authorization: 'never-forward-this' }, models: [] },
  };
  const state = harness({ providers });
  const seen = [];
  const fetchStub = stubFetch(async (url, options) => {
    seen.push(Object.fromEntries(options.headers));
    return { ok: true, json: async () => ({ data: [ROW] }) };
  });
  try {
    apply(state.ctx, {});
    await state.ready[0]();
    await state.disposers[0]();
    apply(state.ctx, { bridge: 'https://different.example/v1/models' });
    await state.ready[0]();
  } finally { fetchStub.restore(); }
  assert.equal(seen[0].authorization, 'Bearer provider-test-token');
  assert.equal(seen[0]['x-account'], 'test-account');
  assert.equal(seen[1].authorization, undefined);
  assert.equal(seen[1]['x-account'], undefined);
  assert.equal(providers.opencodex.headers.authorization, 'Bearer provider-test-token');
});

test('existing apiKeyEnv resolves through credentials on the matching route', async () => {
  const state = harness({ providers: { cursor: {
    baseURL: 'http://127.0.0.1:10100/v1/', apiKeyEnv: 'CURSOR_BRIDGE_KEY', models: [],
  } } }, undefined, { resolve: async ref => ({ value: `${ref}-value` }) });
  let authorization;
  const fetchStub = stubFetch(async (url, options) => {
    authorization = options.headers.get('authorization');
    return { ok: true, json: async () => ({ data: [CURSOR_ROW] }) };
  });
  try { apply(state.ctx, {}); await state.ready[0](); }
  finally { fetchStub.restore(); }
  assert.equal(authorization, 'Bearer CURSOR_BRIDGE_KEY-value');
});

test('empty, unauthenticated, and malformed catalogues keep existing models and allow-list', async () => {
  const models = [{ id: 'existing-model' }];
  const allowedModels = [{ provider: 'opencodex', model: 'existing-model' }];
  const state = harness({ providers: { opencodex: { models } } }, { allowedModels });
  const responses = [
    { ok: true, json: async () => ({ data: [] }) },
    { ok: false, status: 401 },
    { ok: true, json: async () => ({ message: 'offline' }) },
  ];
  const fetchStub = stubFetch(async () => responses.shift());
  try {
    apply(state.ctx, { minIntervalMs: 0, refreshIntervalMs: 0 });
    await state.ready[0]();
    await state.hooks.get('agent/created')();
    await state.hooks.get('agent/created')();
  } finally { fetchStub.restore(); }
  assert.deepEqual(state.calls, []);
  assert.equal(state.settings.describe().find(row => row.ns === 'llm-pi-ai').value.providers.opencodex.models, models);
  assert.equal(state.settings.describe().find(row => row.ns === 'subagent-model-selection-settings').value.allowedModels, allowedModels);
});

test('disposal aborts in-flight fetches and prevents late results from writing', async () => {
  const state = harness({ providers: { opencodex: { models: [] } } });
  let finish;
  let signal;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const fetchStub = stubFetch(async (url, options) => {
    signal = options.signal;
    began();
    return new Promise(resolve => { finish = resolve; });
  });
  try {
    apply(state.ctx, { refreshIntervalMs: 0 });
    const run = state.ready[0]();
    await started;
    await state.disposers[0]();
    assert.equal(signal.aborted, true);
    finish({ ok: true, json: async () => ({ data: [ROW] }) });
    await run;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.logs, { info: [], warn: [] });
    assert.equal(state.hooks.get('agent/created')(), undefined);
  } finally { fetchStub.restore(); }
});

test('a released old write cannot mirror policy or clear a newer run latch', async () => {
  const state = harness({ providers: { opencodex: { models: [] } } }, { allowedModels: [] });
  let finishFirst;
  let began;
  const writing = new Promise(resolve => { began = resolve; });
  state.settings.mutate = async (ns, ops) => {
    state.calls.push({ ns, ops });
    began();
    await new Promise(resolve => { finishFirst = resolve; });
  };
  let finishSecond;
  const fetchStub = stubFetch(async () => {
    if (fetchStub.seen.length > 1) return new Promise(resolve => { finishSecond = resolve; });
    return { ok: true, json: async () => ({ data: [ROW] }) };
  });
  try {
    apply(state.ctx, { minIntervalMs: 0, stuckAfterMs: 25, refreshIntervalMs: 0 });
    const first = state.ready[0]();
    await writing;
    await new Promise(resolve => setTimeout(resolve, 40));
    await first;
    const second = state.hooks.get('agent/created')();
    await new Promise(resolve => setImmediate(resolve));
    finishFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.hooks.get('agent/created')(), undefined, 'new run retains its latch');
    assert.deepEqual(state.calls.map(call => call.ns), ['llm-pi-ai']);
    finishSecond({ ok: true, json: async () => ({ data: [] }) });
    await second;
  } finally { fetchStub.restore(); }
});

test('disposal before readiness unsubscribes startup and ignores a captured late callback', async () => {
  const state = harness({ providers: { opencodex: { models: [] } } });
  const fetchStub = stubFetch(listing([ROW]));
  try {
    apply(state.ctx, { refreshIntervalMs: 10 });
    const lateReady = state.ready[0];
    await state.disposers[0]();
    assert.equal(state.ready.length, 0);
    assert.equal(lateReady(), undefined);
    assert.equal(state.hooks.get('agent/created')(), undefined);
    assert.deepEqual(fetchStub.seen, []);
  } finally { fetchStub.restore(); }
});

test('fetch timeout aborts the request and preserves existing models', async () => {
  const state = harness({ providers: { opencodex: { models: [{ id: 'existing' }] } } });
  let signal;
  const fetchStub = stubFetch(async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted with private diagnostics')), { once: true }));
  });
  try {
    apply(state.ctx, { refreshIntervalMs: 0, fetchTimeoutMs: 10 });
    const run = state.ready[0]();
    await new Promise(resolve => setTimeout(resolve, 30));
    await run;
    assert.equal(signal.aborted, true);
    assert.deepEqual(state.calls, []);
    assert.match(state.logs.warn.join('\n'), /catalogue request timed out/);
    assert.equal(state.logs.warn.join('\n').includes('private diagnostics'), false);
  } finally { fetchStub.restore(); }
});
