#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { VERSION, stateHome, readState, setup, childEnvironment, assertPortFree, loginArgs } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function runtime() {
  let packagePath;
  try { packagePath = require.resolve('@bitkyc08/opencodex/package.json'); }
  catch { throw new Error('Install the companion dependencies first: npm ci'); }
  if (JSON.parse(readFileSync(packagePath, 'utf8')).version !== VERSION) throw new Error('The pinned OpenCodex version changed; reinstall with npm ci.');
  const upstreamRequire = createRequire(packagePath);
  const bun = join(dirname(upstreamRequire.resolve('bun/package.json')), 'bin', 'bun.exe');
  const probe = spawnSync(bun, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0 || probe.stdout.trim() !== '1.4.0') throw new Error('The pinned Bun runtime is unavailable; run npm ci with install scripts enabled.');
  return { bun, cli: join(dirname(packagePath), 'bin', 'ocx.mjs') };
}

function option(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('An option value is missing.');
  return args.splice(index, 2)[1];
}

async function doctor(baseURL, token) {
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== '/v1') {
    throw new Error('Bridge URL must be an HTTP(S) URL ending in /v1, without credentials, query or fragment.');
  }
  const result = { url: base.href.replace(/\/$/, ''), health: false, ready: false, catalog: false, models: 0, credentialPresent: Boolean(token) };
  const headers = token ? { Authorization: `Bearer ${token}`, 'X-OpenCodex-API-Key': token } : {};
  for (const [key, path] of [['health', '/healthz'], ['ready', '/readyz'], ['catalog', '/v1/models']]) {
    try {
      const response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
      const body = await response.json();
      if (key === 'catalog') { result.catalog = response.ok && Array.isArray(body.data); result.models = result.catalog ? body.data.length : 0; }
      else result[key] = response.ok && body.service === 'opencodex' && (key === 'health' || body.status === 'ready');
    } catch { /* Do not print remote bodies, errors or credential-bearing URLs. */ }
  }
  console.log(JSON.stringify(result, null, 2));
  return result.health && result.catalog ? 0 : 1;
}

try {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    console.log('Commands: setup [--port 10100], doctor [--url http://127.0.0.1:10100/v1], start, login <cursor|kimi|kimi-code|deepseek|chatgpt> [--device], test-bun. State: OMH_OPENCODEX_HOME or ~/.local/share/omh-models/opencodex.');
  } else if (command === 'setup') {
    const port = option(args, '--port');
    if (args.length) throw new Error('Unexpected setup arguments.');
    const state = setup(stateHome(), port);
    console.log(JSON.stringify({ home: state.home, baseURL: `http://127.0.0.1:${state.config.port}/v1`, credentialRef: 'OMH_GATEWAY_API_KEY', credentialFile: join(state.home, 'gateway-api-token'), started: false }, null, 2));
  } else if (command === 'doctor') {
    const url = option(args, '--url');
    if (args.length) throw new Error('Unexpected doctor arguments.');
    const state = url ? null : readState(stateHome());
    process.exitCode = await doctor(url || `http://127.0.0.1:${state.config.port}/v1`, url ? process.env.OMH_GATEWAY_API_KEY : state.token);
  } else if (command === 'test-bun') {
    if (args.length) throw new Error('Unexpected test arguments.');
    process.exitCode = spawnSync(runtime().bun, [join(here, 'bun-smoke.mjs')], { stdio: 'inherit' }).status ?? 1;
  } else if (command === 'start' || command === 'login') {
    const state = readState(stateHome());
    const installed = runtime();
    let executable; let argv;
    if (command === 'start') {
      if (args.length) throw new Error('Unexpected start arguments.');
      await assertPortFree(state.config.port);
      executable = installed.bun; argv = [join(here, 'server.mjs')];
    } else {
      const provider = args.shift();
      const device = args[0] === '--device';
      if (device) args.shift();
      if (args.length) throw new Error('Unexpected login arguments.');
      argv = [installed.cli, ...loginArgs(provider, device)]; executable = process.execPath;
    }
    process.exitCode = spawnSync(executable, argv, { stdio: 'inherit', env: childEnvironment(state) }).status ?? 1;
  } else throw new Error('Unknown command; run node cli.mjs help.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
