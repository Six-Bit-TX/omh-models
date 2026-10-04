// Runs against the pinned public API and real Bun on an ephemeral test port.
// No provider credentials or existing homes are loaded; no inference is sent.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setup, childEnvironment, startGuarded, guardFetch } from './lib.mjs';

const root = mkdtempSync(join(tmpdir(), 'omh-opencodex-bun-'));
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const state = setup(join(root, 'state'), port);
state.config.providers = {};
writeFileSync(join(state.home, 'config.json'), JSON.stringify(state.config));
Object.assign(process.env, childEnvironment(state));
const originalFetch = globalThis.fetch;
let outbound = 0;
globalThis.fetch = function fetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1') { outbound++; throw new Error('External requests are forbidden in companion smoke tests.'); }
  return originalFetch(input, init);
};
let server; let streamServer;
try {
  const api = await import('@bitkyc08/opencodex');
  const { startServer } = api.startServer ? api : await api.loadBunApi();
  const originalServe = Bun.serve;
  server = startGuarded({ bun: Bun, startServer, state });
  assert.equal(Bun.serve, originalServe);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/readyz')).status, 200);
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  assert.equal((await fetch(base + '/v1/responses', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/system/restart', { method: 'POST' })).status, 404);
  const catalog = await fetch(base + '/v1/models', { headers: { Authorization: `Bearer ${state.token}` } });
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray((await catalog.json()).data));
  streamServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: guardFetch(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: last\n\n')); controller.close(); }, 25); },
  }), { headers: { 'content-type': 'text/event-stream' } }), state) });
  const streamed = await fetch(`http://127.0.0.1:${streamServer.port}/v1/chat/completions`, { headers: { Authorization: `Bearer ${state.token}` } });
  const reader = streamed.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  const last = await reader.read();
  assert.equal(new TextDecoder().decode(last.value), 'data: last\n\n');
  assert.equal((await reader.read()).done, true);
  assert.equal(outbound, 0);
  assert.equal(existsSync(join(state.home, 'claude-intercept')), false, 'Claude intercept must remain disabled');
  console.log('Pinned OpenCodex/Bun smoke passed: authentication, streaming, readiness, catalog and isolated startup.');
} finally {
  await streamServer?.stop(true);
  await server?.stop(true);
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
