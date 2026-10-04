/** Nonsecret provider recipes and conservative profile planning. */
export const DEFAULT_GATEWAY = 'http://127.0.0.1:10100/v1';
export const DEFAULT_GATEWAY_KEY_REF = 'OMH_GATEWAY_API_KEY';
export const SYNC_ID = 'omh-models-model-sync';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function gatewayURL(value = DEFAULT_GATEWAY) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Gateway URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway URL must use HTTP(S) without embedded credentials, query parameters, or fragments.');
  }
  return url.href.replace(/\/+$/, '');
}

export function keyReference(value = DEFAULT_GATEWAY_KEY_REF) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('Credential reference must be an environment-variable name, not a secret.');
  return value;
}

export function backendRecipes({ gateway = DEFAULT_GATEWAY, gatewayKeyRef = DEFAULT_GATEWAY_KEY_REF, chatgpt = 'gateway' } = {}) {
  if (!['native', 'gateway', 'both'].includes(chatgpt)) throw new Error('--chatgpt must be native, gateway, or both.');
  const baseURL = gatewayURL(gateway);
  const apiKeyEnv = keyReference(gatewayKeyRef);
  const result = { 'kimi-coding': {} };
  if (chatgpt !== 'gateway') result['openai-codex'] = {};
  if (chatgpt !== 'native') result.opencodex = { displayName: 'ChatGPT gateway', api: 'openai-completions', baseURL, apiKeyEnv, models: [] };
  result.cursor = { displayName: 'Cursor', api: 'openai-completions', baseURL, apiKeyEnv, models: [] };
  return result;
}

function merge(left, right) {
  if (!record(left) || !record(right)) return structuredClone(right);
  const next = Object.assign(Object.create(null), left);
  for (const [key, value] of Object.entries(right)) next[key] = merge(next[key], value);
  return next;
}

/** Read static patch rows without executing their !!js expressions. */
export function profileEntries(documents) {
  const entries = new Map();
  const visit = rows => {
    if (!Array.isArray(rows)) throw new Error('A profile or bundle patch must be a YAML sequence.');
    for (const row of rows) {
      if (!record(row)) continue;
      if (Array.isArray(row.insert)) visit(row.insert);
      if (typeof row.id !== 'string') continue;
      const previous = entries.get(row.id) ?? {};
      entries.set(row.id, merge(previous, row));
    }
  };
  for (const document of documents) visit(document ?? []);
  return entries;
}

/** Add absent routes only; existing providers and sync settings are never replaced. */
export function planBackends(documents, options = {}) {
  const entries = profileEntries(documents);
  const pi = entries.get('llm-pi-ai');
  if (pi?.disabled === true) throw new Error('The profile explicitly disables llm-pi-ai; enable it before configuring providers.');
  if (pi?.config !== undefined && !record(pi.config)) throw new Error('Provider configuration is dynamic or unsupported; configure it through the running host.');
  const configured = pi?.config?.providers ?? {};
  if (!record(configured)) throw new Error('Provider configuration is dynamic or unsupported; configure it through the running host.');
  const recipes = backendRecipes(options);
  const added = Object.fromEntries(Object.entries(recipes).filter(([id]) => !Object.hasOwn(configured, id)));
  const rows = [];
  if (Object.keys(added).length) rows.push({ id: 'llm-pi-ai', config: { providers: added } });
  // A fresh gateway can use the recipe's one shared endpoint/ref. Existing
  // gateway configuration keeps its own sync/auth choices, including headers.
  const freshGateway = configured.opencodex === undefined && configured.cursor === undefined;
  const customSync = options.syncMetadata?.explicit ?? profileEntries(options.userDocuments ?? []).has(SYNC_ID);
  const addedGateways = ['opencodex', 'cursor'].filter(id => added[id]);
  const selectedBridge = `${gatewayURL(options.gateway)}/models`;
  const sync = { action: 'unchanged', source: options.syncMetadata?.source ?? (customSync ? 'profile' : 'bundle') };
  const notices = [];
  if (addedGateways.length && freshGateway && !customSync) {
    rows.push({ id: SYNC_ID, config: {
      bridge: selectedBridge,
      credentialRef: keyReference(options.gatewayKeyRef),
      routes: ['opencodex', 'cursor'],
      refreshIntervalMs: 300_000,
    } });
    sync.action = 'configured for added gateway providers';
    sync.matchesAddedGateways = true;
  } else if (addedGateways.length) {
    const current = entries.get(SYNC_ID)?.config;
    sync.action = customSync ? 'preserved explicit override' : 'preserved existing gateway setup';
    sync.matchesAddedGateways = current?.bridge === selectedBridge
      && addedGateways.every(id => Array.isArray(current.routes) && current.routes.includes(id));
    if (!sync.matchesAddedGateways) notices.push('Existing model-sync settings were preserved. Their catalog source or route filter does not cover the added gateway providers; update model-sync explicitly to synchronize those routes.');
  }
  return { rows, added: Object.keys(added), preserved: Object.keys(recipes).filter(id => Object.hasOwn(configured, id)), deepseek: entries.get('llm-deepseek')?.disabled === true ? 'disabled by profile' : 'native Web-bundle adapter', sync, notices };
}

export function credentialFor(provider, config, credentials = {}, environment = process.env) {
  const ref = config?.apiKeyEnv;
  if (typeof ref === 'string') {
    const value = environment[ref] || credentials.refs?.[ref];
    return { kind: 'reference', reference: ref, available: typeof value === 'string' && value.length > 0 };
  }
  if (Object.entries(config?.headers ?? {}).some(([name, value]) => /^(authorization|x-api-key)$/i.test(name) && typeof value === 'string' && value.length > 0)) {
    return { kind: 'existing provider header', available: true };
  }
  if (provider === 'openai-codex' || provider === 'kimi-coding') {
    const stored = credentials.records?.[`llm-pi-ai/${provider}`];
    const nativeEnv = provider === 'kimi-coding' ? environment.KIMI_API_KEY || credentials.refs?.KIMI_API_KEY : undefined;
    return { kind: provider === 'openai-codex' ? 'native OAuth' : 'native OAuth or KIMI_API_KEY', available: Boolean(stored || nativeEnv) };
  }
  return { kind: 'provider-managed', available: false };
}

/** Resolve gateway request authentication only inside the doctor; returned values must not be logged. */
export function gatewayHeaders(config, credentials = {}, environment = process.env) {
  const headers = new Headers(config?.headers ?? {});
  if (config?.apiKeyEnv) {
    const value = environment[config.apiKeyEnv] || credentials.refs?.[config.apiKeyEnv];
    if (typeof value !== 'string' || value.length === 0) return undefined;
    headers.set('authorization', `Bearer ${value}`);
  }
  headers.set('accept', 'application/json');
  return headers;
}

/** Probe only the model-list endpoint, never a chat completion, and return sanitized facts. */
export async function probeGateway(config, credentials, environment, fetcher = fetch) {
  let url;
  try { url = `${gatewayURL(config.baseURL)}/models`; } catch { return { state: 'invalid endpoint' }; }
  let headers;
  try { headers = gatewayHeaders(config, credentials, environment); } catch { return { state: 'invalid authentication headers' }; }
  if (headers === undefined) return { state: 'credential unavailable' };
  try {
    const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { state: 'HTTP error', status: response.status };
    // The doctor does not emit response content: a backend may include account metadata.
    const reader = response.body?.getReader();
    const chunks = []; let length = 0;
    if (!reader) return { state: 'invalid catalog' };
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > 4 * 1024 * 1024) { await reader.cancel(); return { state: 'catalog exceeds size limit' }; }
      chunks.push(next.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return Array.isArray(result?.data) ? { state: 'reachable', modelCount: result.data.filter(row => typeof row?.id === 'string').length } : { state: 'invalid catalog' };
  } catch { return { state: 'unavailable' }; }
}
