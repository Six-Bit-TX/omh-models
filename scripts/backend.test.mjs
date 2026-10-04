import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backendRecipes, planBackends, profileEntries, credentialFor, probeGateway } from './backend-config.mjs';
import { readProfile } from './backend-profile.mjs';

const base = [{ insert: [{ id: 'llm-pi-ai' }, { id: 'llm-deepseek' }] }];

test('fresh recipes expose four families with native OAuth choices and gateway credential references', () => {
  const plan = planBackends([base], { chatgpt: 'both' });
  const providers = plan.rows[0].config.providers;
  assert.deepEqual(providers['kimi-coding'], {});
  assert.deepEqual(providers['openai-codex'], {});
  assert.equal(providers.cursor.apiKeyEnv, 'OMH_GATEWAY_API_KEY');
  assert.equal(providers.opencodex.baseURL, 'http://127.0.0.1:10100/v1');
  assert.deepEqual(providers.cursor.models, []);
  assert.equal(plan.rows[1].config.credentialRef, 'OMH_GATEWAY_API_KEY');
  assert.equal(plan.deepseek, 'native Web-bundle adapter');
});

test('repeat setup preserves existing native and gateway auth, endpoints, catalogs and unrelated providers', () => {
  const existing = [{ id: 'llm-pi-ai', config: { providers: {
    cursor: { baseURL: 'https://gateway.test/custom', headers: { Authorization: 'private-fixture-header' }, models: [{ id: 'cursor/custom' }] },
    opencodex: { apiKeyEnv: 'EXISTING_KEY', baseURL: 'http://127.0.0.1:3210/v1' },
    'kimi-coding': { apiKeyEnv: 'MY_KIMI_KEY' }, 'openai-codex': {}, glm: { models: [{ id: 'glm' }] },
  } } }];
  const snapshot = structuredClone(existing);
  const plan = planBackends([base, existing], { chatgpt: 'both', gateway: 'https://ignored.test/v1' });
  assert.deepEqual(plan.rows, []);
  assert.deepEqual(existing, snapshot);
  assert.equal(profileEntries([base, existing]).get('llm-pi-ai').config.providers.glm.models[0].id, 'glm');
});

test('existing sync overrides and disabled/dynamic provider settings are respected', () => {
  const custom = [{ id: 'omh-models-model-sync', config: { bridge: 'https://own.test/models', routes: ['cursor'] } }];
  assert.equal(planBackends([base, custom], { userDocuments: [custom] }).rows.length, 1);
  assert.throws(() => planBackends([base, [{ id: 'llm-pi-ai', disabled: true }]]), /explicitly disables/);
  assert.throws(() => planBackends([[{ id: 'llm-pi-ai', config: 'dynamic expression' }]]), /dynamic/);
});

test('gateway recipe refuses embedded credentials and invalid credential references', () => {
  for (const gateway of ['file:///tmp/models', 'https://user:secret@test/v1', 'https://test/v1?token=secret']) {
    assert.throws(() => backendRecipes({ gateway }));
  }
  assert.throws(() => backendRecipes({ gatewayKeyRef: 'Bearer secret' }));
  assert.throws(() => backendRecipes({ chatgpt: 'unknown' }));
});

test('doctor reports credential presence without copying any value into its result', () => {
  const credentials = { refs: { PRIVATE_KEY: 'private-fixture-value' }, records: { 'llm-pi-ai/openai-codex': { kind: 'grant', payload: { access: 'private-oauth-fixture' } } } };
  assert.deepEqual(credentialFor('cursor', { apiKeyEnv: 'PRIVATE_KEY' }, credentials, {}), { kind: 'reference', reference: 'PRIVATE_KEY', available: true });
  assert.equal(credentialFor('openai-codex', {}, credentials, {}).available, true);
  assert.equal(credentialFor('kimi-coding', {}, { refs: { KIMI_API_KEY: 'private' } }, {}).available, true);
  assert.equal(credentialFor('cursor', { headers: { Authorization: 'private' } }, {}, {}).available, true);
  assert.doesNotMatch(JSON.stringify(credentialFor('openai-codex', {}, credentials, {})), /private/);
});

test('gateway doctor authenticates only the listing request and sanitizes replies and failures', async () => {
  const config = { baseURL: 'https://gateway.test/v1', apiKeyEnv: 'GATEWAY_KEY' };
  const credentials = { refs: { GATEWAY_KEY: 'private-fixture-value' } };
  let called = 0;
  const result = await probeGateway(config, credentials, {}, async (url, options) => {
    called++; assert.equal(url, 'https://gateway.test/v1/models');
    assert.equal(options.headers.get('authorization'), 'Bearer private-fixture-value');
    assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'cursor/model' }], secret: 'private-response-value' });
  });
  assert.deepEqual(result, { state: 'reachable', modelCount: 1 }); assert.equal(called, 1);
  assert.deepEqual(await probeGateway(config, {}, {}, () => { throw new Error('must not fetch'); }), { state: 'credential unavailable' });
  assert.deepEqual(await probeGateway(config, credentials, {}, () => { throw new Error('private-error-value'); }), { state: 'unavailable' });
});

const runtime = process.env.DSH_RUNTIME;
function gatewayFixture(t, patch = '[]\n') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-gateway-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'home/profiles/web');
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  write(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@fixture/base', '@omh/models'] } } }));
  for (const [name, contents] of [
    ['@fixture/base', '- insert:\n    - id: llm-pi-ai\n    - id: llm-deepseek\n'],
    ['@omh/models', '- insert:\n    - id: omh-models-model-sync\n      config:\n        bridge: http://127.0.0.1:10100/v1/models\n        routes: [opencodex, cursor]\n        refreshIntervalMs: 300000\n'],
  ]) {
    const dir = path.join(profile, 'node_modules', name);
    write(path.join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    write(path.join(dir, 'cordis.patch.yml'), contents);
  }
  const patchFile = path.join(profile, 'cordis.patch.yml'); write(patchFile, patch);
  const script = fileURLToPath(new URL('./backend-setup.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--profile', profile, '--runtime', runtime, '--chatgpt', 'gateway', '--gateway-url', 'http://127.0.0.1:32123/custom/v1', '--gateway-key-ref', 'CUSTOM_GATEWAY_KEY', ...args], { encoding: 'utf8' });
  return { profile, patchFile, run, read: () => readProfile({ profile, runtime }) };
}

test('custom gateway CLI configures the composed provider routes and sync source together', { skip: !runtime }, t => {
  const f = gatewayFixture(t);
  assert.deepEqual(f.read().syncMetadata, { source: 'bundle', explicit: false });
  const before = fs.readFileSync(f.patchFile, 'utf8');
  const dry = f.run('--dry-run'); assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).sync.action, 'configured for added gateway providers');
  assert.equal(fs.readFileSync(f.patchFile, 'utf8'), before);
  const apply = f.run(); assert.equal(apply.status, 0, apply.stderr);
  const entries = profileEntries(f.read().documents);
  const sync = entries.get('omh-models-model-sync').config;
  for (const route of ['opencodex', 'cursor']) {
    const provider = entries.get('llm-pi-ai').config.providers[route];
    assert.equal(provider.baseURL, 'http://127.0.0.1:32123/custom/v1');
    assert.equal(sync.bridge, `${provider.baseURL}/models`);
    assert.equal(sync.credentialRef, provider.apiKeyEnv);
    assert.ok(sync.routes.includes(route));
  }
  const configured = fs.readFileSync(f.patchFile, 'utf8');
  const again = f.run(); assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(f.patchFile, 'utf8'), configured);
  assert.deepEqual(JSON.parse(again.stdout).added, []);
});

test('custom gateway CLI retains and reports an explicit sync override that does not cover new routes', { skip: !runtime }, t => {
  const f = gatewayFixture(t, '# deliberately separate catalog\n- id: omh-models-model-sync\n  config:\n    bridge: https://existing.test/catalog/models\n    credentialRef: EXISTING_CATALOG_KEY\n    routes: [cursor]\n    refreshIntervalMs: 900000\n');
  assert.deepEqual(f.read().syncMetadata, { source: 'profile', explicit: true });
  const existing = structuredClone(profileEntries(f.read().documents).get('omh-models-model-sync').config);
  const apply = f.run(); assert.equal(apply.status, 0, apply.stderr);
  const result = JSON.parse(apply.stdout);
  assert.equal(result.sync.action, 'preserved explicit override');
  assert.equal(result.sync.matchesAddedGateways, false);
  assert.match(result.notices[0], /does not cover the added gateway providers/);
  assert.deepEqual(structuredClone(profileEntries(f.read().documents).get('omh-models-model-sync').config), existing);
  assert.match(fs.readFileSync(f.patchFile, 'utf8'), /deliberately separate catalog/);
});

test('CLI handles current and legacy settings, keeps existing values private, and is idempotent', { skip: !runtime }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-backends-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'home/profiles/web'); fs.mkdirSync(profile, { recursive: true });
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const json = (file, value) => write(file, JSON.stringify(value));
  json(path.join(profile, 'package.json'), { dsh: { profile: { bundles: ['@fixture/base', '@omh/models'] } } });
  for (const [name, patch] of [['@fixture/base', '- insert:\n    - id: llm-pi-ai\n    - id: llm-deepseek\n'], ['@omh/models', '[]\n']]) {
    const dir = path.join(profile, 'node_modules', name);
    json(path.join(dir, 'package.json'), { name, dsh: { bundle: { patch: ['./cordis.patch.yml'] } } });
    write(path.join(dir, 'cordis.patch.yml'), patch);
  }
  const patchFile = path.join(profile, 'cordis.patch.yml');
  write(patchFile, '# preserve comment and expression\n- id: unrelated\n  config:\n    expression: !!js ctx.get("unrelated")\n');
  const home = path.join(directory, 'home');
  write(path.join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    cursor:\n      baseURL: https://own.test/v1\n      headers:\n        Authorization: private-fixture-header\n      models: []\n    glm:\n      models: []\n');
  write(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: private-fixture-key\n');
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(scripts, script), '--profile', profile, '--runtime', runtime, ...args], { encoding: 'utf8' });
  const before = fs.readFileSync(patchFile, 'utf8');
  let result = run('backend-setup.mjs', '--chatgpt', 'both', '--dry-run'); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(patchFile, 'utf8'), before); assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
  result = run('backend-setup.mjs', '--chatgpt', 'both'); assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(patchFile, 'utf8'); assert.match(after, /preserve comment/); assert.match(after, /!!js/); assert.doesNotMatch(after, /own\.test|private-fixture|cursor:/);
  result = run('backend-setup.mjs', '--chatgpt', 'both'); assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(patchFile, 'utf8'), after);
  result = run('backend-doctor.mjs'); assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
  const status = JSON.parse(result.stdout); assert.equal(status.providers.find(p => p.provider === 'cursor').auth.available, true); assert.equal(status.providers[0].auth.available, true);
  write(path.join(home, '.credentials.yaml'), 'bad: [private-fixture-secret\n');
  result = run('backend-doctor.mjs'); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
});
