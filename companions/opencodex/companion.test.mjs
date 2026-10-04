import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setup, readState, childEnvironment, guardFetch, startGuarded, freshConfig, loginArgs, assertPortFree } from './lib.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'omh-companion-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return setup(join(root, 'bridge'));
}

test('setup isolates private credentials, remains idempotent, and never adopts existing state', t => {
  const state = fixture(t);
  assert.deepEqual(setup(state.home), state);
  assert.equal(statSync(join(state.home, 'gateway-api-token')).mode & 0o777, 0o600);
  assert.equal(statSync(state.home).mode & 0o777, 0o700);
  const configText = readFileSync(join(state.home, 'config.json'), 'utf8');
  assert.ok(!configText.includes(state.token) && !configText.includes(state.admin));
  assert.equal(state.config.clientIntegrations.codex, false);
  assert.throws(() => setup(join(state.home, 'codex-home')), /unowned/);
  const env = childEnvironment(state, { CODEX_HOME: '/old-codex', OPENCODEX_HOME: '/old-bridge' });
  assert.equal(env.CODEX_HOME, join(state.home, 'codex-home'));
  assert.equal(env.OPENCODEX_HOME, state.home);
  assert.equal(env.OPENCODEX_CODEX_SHIM_AUTO_RESTORE, '0');
});

test('unsafe edited configuration is rejected before startup', t => {
  const state = fixture(t);
  writeFileSync(join(state.home, 'config.json'), JSON.stringify({ ...state.config, hostname: '0.0.0.0' }));
  assert.throws(() => readState(state.home), /Unsafe companion/);
});

test('every provider request requires a token and unknown aliases fail closed', async t => {
  const state = fixture(t); let calls = 0;
  const fetch = guardFetch(() => { calls++; return new Response('ok'); }, state);
  for (const path of ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/images/generations', '/v1/live', '/v1/audio/transcriptions']) {
    assert.equal((await fetch(new Request('http://localhost' + path))).status, 401);
    assert.equal((await fetch(new Request('http://localhost' + path, { headers: { Authorization: 'Bearer incorrect' } }))).status, 401);
  }
  for (const path of ['/responses', '/chat/completions', '/remote-workspace/agent', '/opencodex-session', '/api/system/restart', '/']) {
    assert.equal((await fetch(new Request('http://localhost' + path, { headers: { Authorization: `Bearer ${state.token}` } }))).status, 404);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(new Request('http://localhost/healthz'))).status, 200);
  assert.equal((await fetch(new Request('http://localhost/readyz'))).status, 200);
});

test('login routes require distinct admin auth and retain upstream admission', async t => {
  const state = fixture(t);
  const fetch = guardFetch(() => new Response('upstream'), state);
  const url = 'http://localhost/api/codex-auth/login';
  assert.equal((await fetch(new Request(url, { headers: { 'X-OpenCodex-API-Key': state.token } }))).status, 401);
  assert.equal(await (await fetch(new Request(url, { headers: { 'X-OpenCodex-API-Key': state.admin } }))).text(), 'upstream');
});

test('authorized streaming is returned untouched, preserving body and abort signal', async t => {
  const state = fixture(t); let observed;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); controller.close(); } });
  const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  const request = new Request('http://localhost/v1/chat/completions', { headers: { Authorization: `Bearer ${state.token}` } });
  const fetch = guardFetch(req => { observed = req; return response; }, state);
  assert.equal(fetch(request), response);
  assert.equal(observed, request);
  assert.equal(await response.text(), 'data: first\n\n');
});

test('synchronous start wraps the actual listener once and restores Bun even after failure', async t => {
  const state = fixture(t); let options; let stopped = false;
  const original = value => { options = value; return { port: state.config.port, stop() { stopped = true; } }; };
  const bun = { serve: original };
  const startServer = (port, deps) => {
    assert.equal(deps.readinessGate.getStatus(), 'ready');
    return bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
  };
  startGuarded({ bun, startServer, state });
  assert.equal(bun.serve, original);
  assert.equal((await options.fetch(new Request('http://localhost/v1/models'))).status, 401);
  assert.throws(() => startGuarded({ bun, state, startServer: port => {
    startServer(port, { readinessGate: { getStatus: () => 'ready' } }); throw new Error('start failed');
  } }), /start failed/);
  assert.equal(bun.serve, original);
  assert.equal(stopped, true);
  assert.throws(() => startGuarded({ bun, state, startServer: () => ({ port: 10100 }) }), /contract changed/);
  assert.throws(() => startGuarded({ bun, state, startServer: port => bun.serve({ port, hostname: '0.0.0.0', fetch() {} }) }), /contract changed/);
  assert.equal(bun.serve, original);
});

test('occupied port is refused rather than selecting or stopping another service', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(assertPortFree(server.address().port), /unavailable/);
});

test('login wrapper exposes only known commands and ChatGPT uses its isolated pool', () => {
  assert.deepEqual(loginArgs('cursor'), ['login', 'cursor']);
  assert.deepEqual(loginArgs('chatgpt', true), ['account', 'login', 'openai', '--id', 'omh-chatgpt', '--device']);
  assert.throws(() => loginArgs('start'), /supports/);
  assert.throws(() => loginArgs('cursor', true), /supports/);
  assert.equal(freshConfig().providers.cursor.nativeLocalExec, 'off');
});
