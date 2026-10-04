import { VERSION, readState, stateHome, startGuarded, assertPortFree } from './lib.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const state = readState(stateHome());
if (process.env.OPENCODEX_HOME !== state.home || process.env.OPENCODEX_API_AUTH_TOKEN !== state.token
    || process.env.OPENCODEX_ADMIN_AUTH_TOKEN !== state.admin) throw new Error('Start this companion through node cli.mjs start.');
const require = createRequire(import.meta.url);
if (JSON.parse(readFileSync(require.resolve('@bitkyc08/opencodex/package.json'), 'utf8')).version !== VERSION) throw new Error('Pinned OpenCodex version mismatch.');
await assertPortFree(state.config.port);
const api = await import('@bitkyc08/opencodex');
const { startServer } = api.startServer ? api : await api.loadBunApi();
const server = startGuarded({ bun: Bun, startServer, state });
console.log(`OMH companion listening at http://127.0.0.1:${state.config.port}/v1 (bearer required).`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop(false);
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
