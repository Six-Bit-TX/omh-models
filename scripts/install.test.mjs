import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shared = path.dirname(fileURLToPath(import.meta.url));
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t, { dependencies = {}, required = [], existing = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omh bundle installer '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, 'bundle with spaces');
  const runtime = path.join(directory, 'runtime with spaces');
  const profile = path.join(directory, 'profile with spaces');
  fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(shared, 'install.mjs'), path.join(bundle, 'scripts/install.mjs'));
  fs.copyFileSync(path.join(shared, 'check.mjs'), path.join(bundle, 'scripts/check.mjs'));
  json(path.join(bundle, 'package.json'), { name: '@omh/fixture', version: '0.1.0', type: 'module', engines: { dsh: '0.1.6-alpha.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, omh: { requires: required } });
  json(path.join(bundle, 'plugins/leaf/package.json'), { name: '@fixture/leaf', type: 'module', main: 'index.js', dependencies });
  fs.writeFileSync(path.join(bundle, 'plugins/leaf/index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./plugins/leaf/index.js\n');
  json(path.join(runtime, 'package.json'), { name: 'fixture-runtime', version: '0.1.6-alpha.1' });
  if (existing) {
    json(path.join(profile, 'package.json'), { name: 'custom-profile', private: true, custom: { retain: true }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } });
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# User-owned patch\n[]\n');
  }
  const install = (...args) => spawnSync(process.execPath, [path.join(bundle, 'scripts/install.mjs'), '--profile', profile, '--runtime', runtime, ...args], { encoding: 'utf8' });
  function provide(name, { exportedManifest = true } = {}) {
    const target = path.join(runtime, 'node_modules', name);
    json(path.join(target, 'package.json'), { name, version: '1.0.0', type: 'module', main: './index.js', exports: { '.': './index.js', ...(exportedManifest ? { './package.json': './package.json' } : {}) } });
    fs.writeFileSync(path.join(target, 'index.js'), 'export {};\n');
    return target;
  }
  return { directory, bundle, runtime, profile, install, provide };
}
function snapshot(directory) {
  if (!fs.existsSync(directory)) return null;
  const result = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); const key = path.relative(directory, file);
      if (entry.isSymbolicLink()) result[key] = { link: fs.readlinkSync(file) };
      else if (entry.isDirectory()) { result[key] = { directory: true }; visit(file); }
      else result[key] = { bytes: fs.readFileSync(file).toString('base64') };
    }
  }
  visit(directory); return result;
}
function passed(result) { assert.equal(result.status, 0, result.stderr); }
function failed(result, pattern) { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, pattern); }

test('dry-run resolves a non-exported manifest and preserves a missing profile and checkout', t => {
  const f = fixture(t, { dependencies: { '@fixture/dep': '1.0.0' }, existing: false });
  f.provide('@fixture/dep', { exportedManifest: false });
  const before = snapshot(f.bundle);
  passed(f.install('--dry-run'));
  assert.equal(snapshot(f.profile), null);
  assert.deepEqual(snapshot(f.bundle), before);
});

test('fresh profile installation works with spaces and loads a dependency through the bundle link', t => {
  const f = fixture(t, { dependencies: { '@fixture/dep': '1.0.0' }, existing: false });
  const dependency = f.provide('@fixture/dep');
  passed(f.install());
  const manifest = read(path.join(f.profile, 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@omh/fixture']);
  assert.equal(fs.realpathSync(path.join(f.profile, 'node_modules/@omh/fixture')), fs.realpathSync(f.bundle));
  assert.equal(fs.realpathSync(path.join(f.bundle, 'node_modules/@fixture/dep')), fs.realpathSync(dependency));
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('@fixture/dep')"], { cwd: f.bundle });
});

test('repeat install is idempotent and uninstall preserves all unrelated profile fields and user patch', t => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.profile, 'package.json'), 'utf8');
  const patch = fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8');
  passed(f.install()); const installed = snapshot(f.profile);
  passed(f.install()); assert.deepEqual(snapshot(f.profile), installed);
  assert.equal(fs.readFileSync(path.join(f.profile, 'package.json.before-omh'), 'utf8'), original);
  passed(f.install('--uninstall'));
  assert.deepEqual(read(path.join(f.profile, 'package.json')), JSON.parse(original));
  assert.equal(fs.readFileSync(path.join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(fs.existsSync(path.join(f.profile, 'node_modules/@omh/fixture')), false);
  passed(f.install('--uninstall'));
});

test('missing dependency refuses installation without any profile or checkout mutation', t => {
  const f = fixture(t, { dependencies: { '@fixture/present': '1.0.0', '@fixture/missing': '1.0.0' } });
  f.provide('@fixture/present');
  const before = snapshot(f.profile); const checkout = snapshot(f.bundle);
  failed(f.install(), /Missing runtime dependency @fixture\/missing/);
  assert.deepEqual(snapshot(f.profile), before); assert.deepEqual(snapshot(f.bundle), checkout);
});

test('runtime version mismatch and absent prerequisite fail before mutating profile', t => {
  const f = fixture(t, { required: ['@omh/base'] }); const before = snapshot(f.profile);
  failed(f.install(), /Install required bundle @omh\/base/);
  assert.deepEqual(snapshot(f.profile), before);
  json(path.join(f.runtime, 'package.json'), { version: '0.1.7' });
  failed(f.install(), /requires DSH 0\.1\.6-alpha\.1/);
  assert.deepEqual(snapshot(f.profile), before);
});

test('uninstall refuses while another installed bundle requires this bundle', t => {
  const f = fixture(t); passed(f.install());
  const manifestFile = path.join(f.profile, 'package.json'); const manifest = read(manifestFile);
  manifest.dsh.profile.bundles.push('@omh/dependent'); json(manifestFile, manifest);
  json(path.join(f.profile, 'node_modules/@omh/dependent/package.json'), { name: '@omh/dependent', omh: { requires: ['@omh/fixture'] } });
  const before = snapshot(f.profile);
  failed(f.install('--uninstall'), /@omh\/dependent still requires @omh\/fixture/);
  assert.deepEqual(snapshot(f.profile), before);
});

test('an existing unrelated bundle path and shared profile node_modules are never replaced', t => {
  const f = fixture(t);
  json(path.join(f.profile, 'node_modules/@omh/fixture/package.json'), { name: 'unrelated' });
  const before = snapshot(f.profile);
  failed(f.install(), /Refusing to replace an existing module/);
  failed(f.install('--uninstall'), /not owned by this checkout/);
  assert.deepEqual(snapshot(f.profile), before);
  fs.rmSync(path.join(f.profile, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(f.directory, 'shared'));
  fs.symlinkSync(path.join(f.directory, 'shared'), path.join(f.profile, 'node_modules'), 'dir');
  failed(f.install(), /shared installation/);
  assert.deepEqual(snapshot(path.join(f.directory, 'shared')), {});
});

test('a shared package scope is refused before writing into another installation', t => {
  const f = fixture(t);
  const sharedModules = path.join(f.directory, 'shared-scope'); fs.mkdirSync(sharedModules);
  fs.mkdirSync(path.join(f.profile, 'node_modules'));
  fs.symlinkSync(sharedModules, path.join(f.profile, 'node_modules/@omh'), 'dir');
  const before = snapshot(f.profile);
  failed(f.install(), /symlink|shared|ancestor/i);
  assert.deepEqual(snapshot(f.profile), before);
  assert.deepEqual(snapshot(sharedModules), {});
});

test('a failed module-link transaction leaves the original profile byte-for-byte untouched', t => {
  const f = fixture(t, { dependencies: { '@fixture/dep': '1.0.0' } }); f.provide('@fixture/dep');
  fs.mkdirSync(path.join(f.profile, 'node_modules'));
  fs.writeFileSync(path.join(f.profile, 'node_modules/@omh'), 'not a directory\n');
  const before = snapshot(f.profile); const checkout = snapshot(f.bundle);
  failed(f.install(), /ENOTDIR|EEXIST|not a directory/);
  assert.deepEqual(snapshot(f.profile), before);
  assert.deepEqual(snapshot(f.bundle), checkout);
});

test('a failed final manifest commit rolls back installed links, backup, directories, and temporary files', t => {
  const f = fixture(t, { dependencies: { '@fixture/dep': '1.0.0' } }); f.provide('@fixture/dep');
  const before = snapshot(f.profile); const checkout = snapshot(f.bundle);
  const preload = path.join(f.directory, 'fail-manifest-commit.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nconst original = fs.renameSync;\nfs.renameSync = (from, to) => { if (to === ${JSON.stringify(path.join(f.profile, 'package.json'))}) throw new Error('fixture final commit failed'); return original(from, to); };\n`);
  const result = spawnSync(process.execPath, ['--import', preload, path.join(f.bundle, 'scripts/install.mjs'), '--profile', f.profile, '--runtime', f.runtime], { encoding: 'utf8' });
  failed(result, /fixture final commit failed/);
  assert.deepEqual(snapshot(f.profile), before);
  assert.deepEqual(snapshot(f.bundle), checkout);
});

test('checker validates browser module identity and rejects an unshipped patch entry', t => {
  const f = fixture(t);
  const leaf = path.join(f.bundle, 'plugins/leaf');
  json(path.join(leaf, 'package.json'), { name: '@fixture/leaf', main: 'index.js', dsh: { client: {} }, exports: { './client': './client.js' } });
  fs.writeFileSync(path.join(leaf, 'client.js'), "window.__ModuleLoader__.load({id:'@fixture/leaf',factory(){return {};}});\n");
  const check = () => spawnSync(process.execPath, [path.join(f.bundle, 'scripts/check.mjs')], { encoding: 'utf8' });
  passed(check());
  fs.writeFileSync(path.join(leaf, 'client.js'), "window.__ModuleLoader__.load({id:'@fixture/wrong',factory(){return {};}});\n");
  failed(check(), /Browser identity mismatch/);
  fs.writeFileSync(path.join(leaf, 'client.js'), "window.__ModuleLoader__.load({id:'@fixture/leaf',factory(){return {};}});\n");
  fs.writeFileSync(path.join(f.bundle, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./plugins/missing/index.js\n');
  failed(check(), /Missing patch entry/);
});
