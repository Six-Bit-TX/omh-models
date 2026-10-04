#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/install.mjs --profile /path/to/profile --runtime /path/to/harness [--dry-run | --uninstall]\nA missing profile is initialized with the standard Web bundles. Stop the host before changing an active profile.');
  process.exit(0);
}
function value(flag) {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Required: ${flag} /absolute/path`);
  return path.resolve(args[i + 1]);
}
function symlinkPlan(link, target) {
  let parent = path.dirname(link);
  while (parent !== path.dirname(parent)) {
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing a shared symlink ancestor: ${parent}`);
    }
    parent = path.dirname(parent);
  }
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) return;
    throw new Error(`Refusing to replace an existing module: ${link}`);
  }
  return { link, target };
}
function atomicJSON(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
try {
  const profile = value('--profile');
  const own = read(path.join(root, 'package.json'));
  const file = path.join(profile, 'package.json');
  const present = fs.existsSync(file);
  const manifest = present ? read(file) : {
    name: `omh-profile-${path.basename(profile)}`, private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  };
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) throw new Error('Target package.json is not a DSH profile with dsh.profile.bundles.');
  const modules = path.join(profile, 'node_modules');
  if (fs.lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Profile node_modules is a symlink to a shared installation. Choose a separate profile directory.');
  }
  const link = path.join(modules, own.name);
  const dry = args.includes('--dry-run');
  if (args.includes('--uninstall')) {
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    if (existing && (!existing.isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(root))) {
      throw new Error(`The bundle link is not owned by this checkout: ${link}`);
    }
    for (const installed of bundles.filter(name => name !== own.name)) {
      try {
        const other = read(path.join(modules, installed, 'package.json'));
        if (other.omh?.requires?.includes(own.name)) throw new Error(`${installed} still requires ${own.name}; remove that bundle first.`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!dry && present) {
      manifest.dsh.profile.bundles = bundles.filter(name => name !== own.name);
      atomicJSON(file, manifest);
      if (existing) fs.unlinkSync(link);
    }
    console.log(`${dry ? 'Would remove' : 'Removed'} ${own.name} from ${profile}. Runtime data was preserved.`);
    process.exit(0);
  }
  const runtime = value('--runtime');
  const runtimeManifest = read(path.join(runtime, 'package.json'));
  if (own.engines?.dsh && runtimeManifest.version !== own.engines.dsh) {
    throw new Error(`This bundle requires DSH ${own.engines.dsh}; runtime reports ${runtimeManifest.version}.`);
  }
  for (const required of own.omh?.requires ?? []) {
    if (!bundles.includes(required)) throw new Error(`Install required bundle ${required} in this profile first.`);
  }
  const requireRuntime = createRequire(path.join(runtime, 'package.json'));
  const sourcePackages = new Map();
  function addSourcePackage(directory) {
    const packageFile = path.join(directory, 'package.json');
    if (fs.existsSync(packageFile)) sourcePackages.set(read(packageFile).name, directory);
  }
  for (const area of ['packages', 'vendor']) {
    const directory = path.join(runtime, area);
    if (!fs.existsSync(directory)) continue;
    for (const group of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDirectory = path.join(directory, group.name);
      addSourcePackage(groupDirectory);
      if (area === 'packages') for (const child of fs.readdirSync(groupDirectory, { withFileTypes: true })) {
        if (child.isDirectory()) addSourcePackage(path.join(groupDirectory, child.name));
      }
    }
  }
  const dependencies = new Set();
  const leaves = fs.existsSync(path.join(root, 'plugins')) ? fs.readdirSync(path.join(root, 'plugins')).sort() : [];
  for (const leaf of leaves) {
    const p = read(path.join(root, 'plugins', leaf, 'package.json'));
    for (const name of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {})]) dependencies.add(name);
  }
  const plans = [];
  for (const name of dependencies) {
    // A local dependency installed explicitly with npm is already usable.
    const moduleLink = path.join(root, 'node_modules', name);
    if (fs.existsSync(moduleLink)) continue;
    let target;
    try { target = path.dirname(requireRuntime.resolve(`${name}/package.json`)); }
    catch {
      try {
        let cursor = path.dirname(requireRuntime.resolve(name));
        while (cursor !== path.dirname(cursor)) {
          const candidate = path.join(cursor, 'package.json');
          if (fs.existsSync(candidate) && read(candidate).name === name) { target = cursor; break; }
          cursor = path.dirname(cursor);
        }
      } catch { /* Report the complete missing dependency below. */ }
    }
    target ??= sourcePackages.get(name);
    if (!target) for (const directory of sourcePackages.values()) {
      const packageFile = path.join(directory, 'package.json');
      const declared = read(packageFile);
      if (![declared.dependencies, declared.peerDependencies, declared.devDependencies].some(section => section && name in section)) continue;
      try {
        target = path.dirname(createRequire(packageFile).resolve(`${name}/package.json`));
        break;
      } catch { /* Try the next source owner declaring this dependency. */ }
    }
    if (!target) throw new Error(`Missing runtime dependency ${name}. Install it in this bundle with npm install --no-save --ignore-scripts ${name}, then retry.`);
    const plan = symlinkPlan(moduleLink, fs.realpathSync(target));
    if (plan) plans.push(plan);
  }
  const bundlePlan = symlinkPlan(link, fs.realpathSync(root));
  if (bundlePlan) plans.push(bundlePlan);
  if (!dry) {
    const applied = [];
    const directories = [];
    let savedBackup = false;
    function mkdir(directory) {
      if (fs.existsSync(directory)) return;
      mkdir(path.dirname(directory));
      fs.mkdirSync(directory);
      directories.push(directory);
    }
    try {
      mkdir(profile);
      // Save the exact original once; normal uninstall edits only this bundle entry.
      if (present && !fs.existsSync(`${file}.before-omh`)) {
        fs.copyFileSync(file, `${file}.before-omh`, fs.constants.COPYFILE_EXCL);
        savedBackup = true;
      }
      for (const plan of plans) {
        mkdir(path.dirname(plan.link));
        fs.symlinkSync(plan.target, plan.link, 'dir');
        applied.push(plan.link);
      }
      if (!bundles.includes(own.name)) bundles.push(own.name);
      atomicJSON(file, manifest);
    } catch (error) {
      for (const added of applied.reverse()) fs.unlinkSync(added);
      if (savedBackup) fs.unlinkSync(`${file}.before-omh`);
      for (const directory of directories.reverse()) fs.rmdirSync(directory);
      throw error;
    }
  }
  console.log(`${dry ? 'Would install' : 'Installed'} ${own.name} into ${profile} (${plans.length} module links).`);
  console.log('Keep this checkout in place. Restart the host and refresh the browser to load the bundle.');
} catch (error) {
  console.error(`install: ${error.message}`);
  process.exitCode = 1;
}
