/** Validated host configuration for the catalogue refresher. */
import { ROUTES } from './catalogue.js';

const MAX_TIMER_MS = 2_147_483_647;

/** Validate a deployment timer without Node's overflow-to-one-millisecond behavior. */
function duration(config, name, fallback, allowZero = false) {
  const value = config[name] === undefined ? fallback : config[name];
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TIMER_MS) {
    throw new TypeError(`model-sync: ${name} must be an integer ${allowZero ? 'from 0' : 'from 1'} through ${MAX_TIMER_MS}`);
  }
  return value;
}

/** Resolve deployment settings; reject invalid endpoints and unsupported route families. */
export function resolveConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('model-sync: configuration must be an object');
  }
  let bridge;
  try { bridge = new URL(config.bridge === undefined ? 'http://127.0.0.1:10100/v1/models' : config.bridge); }
  catch { throw new TypeError('model-sync: bridge must be an absolute HTTP(S) model-list URL'); }
  if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password || bridge.hash || bridge.search) {
    throw new TypeError('model-sync: bridge must use HTTP(S) without URL credentials, query, or fragment');
  }
  const routes = config.routes === undefined ? ROUTES : config.routes;
  if (!Array.isArray(routes) || routes.length === 0 || routes.some(route => !ROUTES.includes(route))
    || new Set(routes).size !== routes.length) {
    throw new TypeError(`model-sync: routes must be a nonempty unique subset of ${ROUTES.join(', ')}`);
  }
  const credentialRef = config.credentialRef;
  if (credentialRef !== undefined && (typeof credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef))) {
    throw new TypeError('model-sync: credentialRef must be a credential-reference name');
  }
  return {
    bridge: bridge.href,
    routes: [...routes],
    credentialRef,
    minIntervalMs: duration(config, 'minIntervalMs', 300_000, true),
    refreshIntervalMs: duration(config, 'refreshIntervalMs', 300_000, true),
    fetchTimeoutMs: duration(config, 'fetchTimeoutMs', 10_000),
    stuckAfterMs: duration(config, 'stuckAfterMs', 120_000),
  };
}
