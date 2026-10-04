/** Profile I/O shared by the setup and read-only doctor commands. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profileEntries, SYNC_ID } from './backend-config.mjs';

export function argumentsOf(args) {
  const values = {};
  const flags = new Set(['--dry-run', '--probe', '--help']);
  const options = new Set(['--profile', '--runtime', '--home', '--gateway-url', '--gateway-key-ref', '--chatgpt']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) { values[arg.slice(2)] = true; continue; }
    if (!options.has(arg)) throw new Error('Unknown option; use --help for supported arguments.');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    values[arg.slice(2)] = value;
  }
  return values;
}

function parse(yaml, source) {
  const document = yaml.parseDocument(source, { uniqueKeys: true, prettyErrors: false, keepSourceTokens: true });
  if (document.errors.length) throw new Error('Invalid YAML configuration; source values are omitted from this diagnostic.');
  return document;
}

export function readProfile(options) {
  if (!options.profile || !options.runtime) throw new Error('--profile and --runtime are required.');
  const profile = path.resolve(options.profile); const runtime = path.resolve(options.runtime);
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
  if (runtimeManifest.version !== '0.2.1-alpha.1') throw new Error('Backend setup requires DSH 0.2.1-alpha.1.');
  const yaml = createRequire(path.join(runtime, 'packages/credentials/credentials-local/package.json'))('yaml');
  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes('@omh/models')) throw new Error('Install the OMH Models bundle in this profile first.');
  const documents = []; const seen = new Set();
  const inspectBundle = (specifier, from) => {
    const req = createRequire(path.join(from, 'package.json'));
    let packageFile;
    try { packageFile = req.resolve(`${specifier}/package.json`); } catch {
      // Stock bundles are dependencies of the runtime launcher; isolated
      // profiles link only their external category bundles.
      try { packageFile = createRequire(path.join(runtime, 'apps/cli/package.json')).resolve(`${specifier}/package.json`); }
      catch { throw new Error('An installed profile bundle cannot be resolved. Re-run the bundle installer.'); }
    }
    packageFile = fs.realpathSync(packageFile);
    if (seen.has(packageFile)) return; seen.add(packageFile);
    const packageRoot = path.dirname(packageFile); const data = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    for (const included of data.dsh?.bundle?.bundles ?? []) inspectBundle(included, packageRoot);
    const patch = data.dsh?.bundle?.patch;
    for (const entry of Array.isArray(patch) ? patch : patch ? [patch] : []) {
      documents.push(parse(yaml, fs.readFileSync(path.resolve(packageRoot, entry), 'utf8')).toJS());
    }
  };
  for (const bundle of bundles) inspectBundle(bundle, profile);
  const filename = path.join(profile, 'cordis.patch.yml');
  const original = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '[]\n';
  const document = parse(yaml, original);
  if (document.contents === null) document.contents = document.createNode([]);
  if (!yaml.isSeq(document.contents)) throw new Error('Profile cordis.patch.yml must contain a sequence.');
  const userDocuments = [document.toJS()];
  const profileOwnsSync = profileEntries(userDocuments).has(SYNC_ID);
  let legacyOwnsSync = false;
  documents.push(...userDocuments);
  const home = options.home ? path.resolve(options.home) : path.basename(path.dirname(profile)) === 'profiles' ? path.dirname(path.dirname(profile)) : undefined;
  // DSH imports this legacy document after the host starts. Planning must see
  // its pending model overrides, but never copy their values into a new patch.
  const legacy = home && path.join(home, 'settings.yaml');
  if (legacy && fs.existsSync(legacy)) {
    const settings = parse(yaml, fs.readFileSync(legacy, 'utf8')).toJS() ?? {};
    const rows = ['llm-pi-ai', 'llm-deepseek', 'omh-models-model-sync'].filter(id => Object.hasOwn(settings, id)).map(id => ({ id, config: settings[id] }));
    legacyOwnsSync = Object.hasOwn(settings, SYNC_ID);
    documents.push(rows); userDocuments.push(rows);
  }
  const syncMetadata = {
    source: legacyOwnsSync ? 'legacy-home' : profileOwnsSync ? 'profile' : profileEntries(documents).has(SYNC_ID) ? 'bundle' : 'absent',
    explicit: legacyOwnsSync || profileOwnsSync,
  };
  return { yaml, profile, runtime, filename, original, document, documents, userDocuments, syncMetadata, home };
}

/** Read credential presence privately. No credential value belongs in command output. */
export function readCredentials(context) {
  if (!context.home) return {};
  const filename = path.join(context.home, '.credentials.yaml');
  if (!fs.existsSync(filename)) return {};
  return parse(context.yaml, fs.readFileSync(filename, 'utf8')).toJS() ?? {};
}

export function appendPlan(context, rows) {
  if (!rows.length) return false;
  if (fs.lstatSync(context.filename, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked profile patch.');
  // The host must be stopped; a final comparison also catches edits made while planning.
  const current = fs.existsSync(context.filename) ? fs.readFileSync(context.filename, 'utf8') : '[]\n';
  if (current !== context.original) throw new Error('The profile changed while planning; retry with the host stopped.');
  for (const row of rows) context.document.add(row);
  const temporary = `${context.filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, context.document.toString(), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, context.filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return true;
}
