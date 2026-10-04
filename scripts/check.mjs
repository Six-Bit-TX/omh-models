import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest = read(path.join(root, 'package.json'));
if (!manifest.dsh?.bundle?.patch) throw new Error('Missing Cordis bundle declaration.');
const patch = fs.readFileSync(path.join(root, manifest.dsh.bundle.patch), 'utf8');
let count = 0;
for (const leaf of fs.readdirSync(path.join(root, 'plugins'))) {
  const directory = path.join(root, 'plugins', leaf);
  const p = read(path.join(directory, 'package.json'));
  if (!fs.existsSync(path.join(directory, p.main ?? 'index.js'))) throw new Error(`Missing host entry for ${leaf}`);
  if (JSON.stringify([p.dependencies, p.peerDependencies]).includes('workspace:')) throw new Error(`Unresolved workspace dependencies: ${leaf}`);
  if (p.dsh?.client) {
    const entry = p.exports?.['./client'];
    const target = typeof entry === 'string' ? entry : entry?.default;
    if (!target) throw new Error(`Missing browser export for ${leaf}`);
    let declared;
    const source = fs.readFileSync(path.join(directory, target), 'utf8');
    vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { declared = value; } } } }, { filename: target });
    if (declared?.id !== p.name || typeof declared.factory !== 'function') throw new Error(`Browser identity mismatch: ${leaf}`);
  }
  count++;
}
for (const match of patch.matchAll(/name:\s*['"]?(\.\/[^\s'"\n]+)/g)) {
  if (!fs.existsSync(path.join(root, match[1]))) throw new Error(`Missing patch entry ${match[1]}`);
}
console.log(`Validated ${manifest.name}: ${count} plugin packages, host entries, browser identities, and patch targets.`);
