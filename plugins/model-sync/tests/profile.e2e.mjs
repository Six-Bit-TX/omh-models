/** Real DSH profile startup, host credential resolution, and periodic settings writes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const runtime = process.env.DSH_RUNTIME;
const plugin = fileURLToPath(new URL('../index.js', import.meta.url));

test('a real profile authenticates, refreshes after startup, and persists current models and policy', {
  skip: runtime === undefined ? 'set DSH_RUNTIME to the built supported runtime' : false,
  timeout: 35_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'omh-model-sync-profile-'));
  let requests = 0;
  let refused = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/models'
      || request.headers.authorization !== 'Bearer synthetic-model-sync-credential') {
      refused++;
      response.writeHead(401).end();
      return;
    }
    requests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: requests === 1 ? 'probe-first' : 'probe-second', capabilities: { input_modalities: ['text'] } }] }));
  });
  let child;
  let timeout;
  let hardTimeout;
  try {
    await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const profile = join(root, 'home', 'profiles', 'web');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }));
    await writeFile(join(profile, 'cordis.yml'), '[]\n');
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      opencodex:
        api: openai-completions
        baseURL: ${baseURL}
        apiKeyEnv: OMH_MODEL_SYNC_PROBE_KEY
        models: []
`);
    const report = join(root, 'report.json');
    const inspector = join(root, 'inspect.mjs');
    await writeFile(inspector, `import {writeFileSync} from 'node:fs';
export const inject=['loader'];
export function apply(ctx){
 const messages=[];
 ctx.logger.exporter({levels:{default:3},export:message=>{
   for(const arg of message.args) if(typeof arg==='string'&&arg.startsWith('model-sync:'))messages.push(arg);
 }});
 ctx.effect(()=>{
   const timer=setInterval(()=>{
     const descriptors=ctx.get('settings').describe();
     const value=ns=>descriptors.find(row=>row.ns===ns)?.value;
     const models=value('llm-pi-ai')?.providers?.opencodex?.models?.map(model=>model.id);
     const allowed=value('subagent-model-selection-settings')?.allowedModels;
     if(!models?.includes('probe-second')||!allowed?.some(row=>row.provider==='opencodex'&&row.model==='probe-second'))return;
     const entry=[...ctx.get('loader').entries()].find(row=>row.id.endsWith('sync-probe'));
     writeFileSync(${JSON.stringify(report)},JSON.stringify({state:entry?.fiber?.state,models,allowed,messages}));
     ctx.get('appExit')(0);
   },100);
   return()=>clearInterval(timer);
 });
}
`);
    const patch = join(root, 'probe.patch.yml');
    await writeFile(patch, `- insert:
    - id: sync-probe
      name: ${JSON.stringify(plugin)}
      config:
        bridge: ${baseURL}/models
        refreshIntervalMs: 250
        minIntervalMs: 0
    - id: sync-inspector
      name: ${JSON.stringify(inspector)}
`);
    child = spawn(process.execPath, [join(resolve(runtime), 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], {
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1', OMH_MODEL_SYNC_PROBE_KEY: 'synthetic-model-sync-credential' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    timeout = setTimeout(() => child.kill('SIGTERM'), 25_000);
    hardTimeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
    assert.equal(code, 0, output.replace(/token=[^\s]+/g, 'token=[redacted]'));
    const result = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(result.state, 2, 'the real Cordis plugin is active');
    assert.deepEqual(result.models, ['probe-second']);
    assert.ok(result.messages.some(message => message.includes('startup; updated opencodex')));
    assert.ok(result.messages.some(message => message.includes('interval; updated opencodex')));
    assert.ok(requests >= 2);
    assert.equal(refused, 0, 'every request used host-resolved catalogue authentication');
    const persisted = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
    assert.match(persisted, /probe-second/);
    assert.equal(persisted.includes('synthetic-model-sync-credential'), false);
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardTimeout);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolveExit => child.once('exit', resolveExit));
    }
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});
