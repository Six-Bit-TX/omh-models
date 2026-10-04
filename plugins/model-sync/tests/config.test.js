import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../config.js';

test('catalogue deployment options retain defaults and permit disabling periodic polling', () => {
  assert.equal(resolveConfig().refreshIntervalMs, 300_000);
  assert.equal(resolveConfig({ refreshIntervalMs: 0 }).refreshIntervalMs, 0);
  assert.deepEqual(resolveConfig({ routes: ['cursor'] }).routes, ['cursor']);
});

test('invalid endpoints, authentication references, routes, and timer overflow fail at load', () => {
  for (const config of [
    { bridge: 'not-a-url' }, { bridge: 'file:///tmp/models' },
    { bridge: 'https://user:secret@example.com/v1/models' },
    { bridge: 'https://example.com/models?token=secret' },
    { credentialRef: 'literal-secret-value' }, { credentialRef: '' },
    { routes: [] }, { routes: ['deepseek'] }, { routes: ['cursor', 'cursor'] },
    { refreshIntervalMs: -1 }, { refreshIntervalMs: 2_147_483_648 },
    { fetchTimeoutMs: 0 }, { minIntervalMs: 0.5 }, { stuckAfterMs: '1000' },
  ]) assert.throws(() => resolveConfig(config), /model-sync:/);
});
