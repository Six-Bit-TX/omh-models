import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { createServer } from 'node:net';

export const VERSION = '2.68.0';
export const TOKEN_REF = 'OMH_GATEWAY_API_KEY';
export const DEFAULT_PORT = 10100;
const markerName = 'omh-companion.json';
const integrations = { codex: false, grok: false, 'claude-desktop': false };

export function stateHome(env = process.env) {
  return resolve(env.OMH_OPENCODEX_HOME || join(homedir(), '.local', 'share', 'omh-models', 'opencodex'));
}

export function parsePort(value = DEFAULT_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 through 65535.');
  return port;
}

export function freshConfig(port = DEFAULT_PORT) {
  return {
    port: parsePort(port), hostname: '127.0.0.1', runtimeRole: 'hub',
    clientIntegrations: { ...integrations }, codexAutoStart: false, codexShimAutoRestore: false,
    claudeCode: { enabled: false, intercept: { enabled: false } },
    codexNativeSteering: false, codexNativeInjection: false,
    unauthenticatedLoopbackListener: { enabled: false },
    tokenGuardian: { enabled: false }, catalogAutoRefresh: { enabled: false },
    openaiProviderTierVersion: 2,
    providers: {
      openai: { adapter: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', authMode: 'forward', codexAccountMode: 'pool' },
      cursor: { adapter: 'cursor', baseUrl: 'https://api2.cursor.sh', authMode: 'oauth', nativeLocalExec: 'off' },
    },
    defaultProvider: 'openai', websockets: false,
  };
}

function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('Companion state files must be regular private files (0600).');
  }
  return readFileSync(path, 'utf8');
}

export function validateConfig(config) {
  if (config.hostname !== '127.0.0.1' || config.runtimeRole !== 'hub'
      || Object.entries(integrations).some(([key, value]) => config.clientIntegrations?.[key] !== value)
      || config.codexAutoStart !== false || config.codexShimAutoRestore !== false
      || config.claudeCode?.enabled !== false || config.claudeCode?.intercept?.enabled !== false
      || config.unauthenticatedLoopbackListener?.enabled !== false
      || (config.providers?.cursor && config.providers.cursor.nativeLocalExec !== 'off')) {
    throw new Error('Unsafe companion configuration: restore loopback binding, disabled client integrations and Cursor nativeLocalExec off.');
  }
  parsePort(config.port);
  return config;
}

export function readState(home) {
  if (!isAbsolute(home) || home === resolve(homedir(), '.opencodex')) throw new Error('Use a dedicated companion state directory.');
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Companion state directory must be private (0700) and not a symlink.');
  const parsePrivateJson = name => {
    const text = privateFile(join(home, name));
    try { return JSON.parse(text); } catch { throw new Error('A companion JSON state file is invalid; repair it without sharing its contents.'); }
  };
  const marker = parsePrivateJson(markerName);
  if (marker.kind !== 'omh-opencodex' || marker.version !== 1) throw new Error('This directory is not an OMH companion home.');
  const config = validateConfig(parsePrivateJson('config.json'));
  const token = privateFile(join(home, 'gateway-api-token')).trim();
  const admin = privateFile(join(home, 'admin-api-token')).trim();
  if (!/^omh_[A-Za-z0-9_-]{43}$/.test(token) || !/^ocx_admin_[A-Za-z0-9_-]{43}$/.test(admin)) throw new Error('Companion credential files are missing or invalid.');
  return { home: realpathSync(home), config, token, admin };
}

export function setup(home, port = DEFAULT_PORT) {
  if (!isAbsolute(home) || home === resolve(homedir(), '.opencodex')) throw new Error('Use a dedicated companion state directory.');
  if (existsSync(join(home, markerName))) return readState(home);
  if (existsSync(home)) throw new Error('Setup requires a new directory; existing unowned state will not be overwritten.');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const write = (name, value) => writeFileSync(join(home, name), value, { flag: 'wx', mode: 0o600 });
  write('config.json', JSON.stringify(freshConfig(port), null, 2) + '\n');
  write('gateway-api-token', 'omh_' + randomBytes(32).toString('base64url') + '\n');
  write('admin-api-token', 'ocx_admin_' + randomBytes(32).toString('base64url') + '\n');
  write(markerName, JSON.stringify({ kind: 'omh-opencodex', version: 1 }) + '\n');
  mkdirSync(join(home, 'codex-home'), { mode: 0o700 });
  return readState(home);
}

export function childEnvironment(state, parent = process.env) {
  return {
    ...parent,
    OPENCODEX_HOME: state.home,
    CODEX_HOME: join(state.home, 'codex-home'),
    OPENCODEX_CODEX_SHIM_AUTO_RESTORE: '0',
    OPENCODEX_API_AUTH_TOKEN: state.token,
    OPENCODEX_ADMIN_AUTH_TOKEN: state.admin,
  };
}

export async function assertPortFree(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Companion port is unavailable; use the existing bridge URL or choose another port at setup.')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolvePromise));
  });
}

function equalSecret(actual, expected) {
  const a = Buffer.from(actual || ''); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only provider traffic and the narrowly scoped account-login management routes
// are exposed. Unknown aliases, GUI, workspace control and system actions fail closed.
const loginRoutes = new Set([
  '/api/oauth/login', '/api/oauth/login/code', '/api/oauth/login/cancel', '/api/oauth/status',
  '/api/codex-auth/login', '/api/codex-auth/login/code', '/api/codex-auth/login/cancel', '/api/codex-auth/login-status',
]);

export function guardFetch(fetchHandler, { token, admin }) {
  return function guardedFetch(request, server) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && (path === '/healthz' || path === '/readyz')) return fetchHandler.call(this, request, server);
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const dedicated = request.headers.get('x-opencodex-api-key');
    if (path.startsWith('/v1/')) {
      if (!equalSecret(bearer, token) && !equalSecret(dedicated, token)) return Response.json({ error: 'Companion bearer token required.' }, { status: 401 });
      return fetchHandler.call(this, request, server);
    }
    if (loginRoutes.has(path)) {
      if (!equalSecret(dedicated, admin)) return Response.json({ error: 'Companion login credential required.' }, { status: 401 });
      return fetchHandler.call(this, request, server);
    }
    return Response.json({ error: 'Endpoint unavailable in the OMH companion.' }, { status: 404 });
  };
}

// Pinned compatibility boundary: upstream deliberately bypasses data auth on
// loopback. Wrap the actual Bun handler synchronously; no extra listener, proxy,
// buffering, imported private upstream API or persistent Bun mutation is needed.
export function startGuarded({ bun, startServer, state }) {
  validateConfig(state.config);
  const originalServe = bun.serve;
  let count = 0; let server; let bound;
  const readinessGate = { getStatus: () => 'ready', markReady() {}, markFailed() {} };
  try {
    bun.serve = function serve(options) {
      if (++count !== 1 || options.hostname !== '127.0.0.1' || options.port !== state.config.port
          || typeof options.fetch !== 'function' || options.routes !== undefined || options.unix !== undefined) {
        throw new Error('Pinned OpenCodex listener contract changed; refusing to start.');
      }
      bound = originalServe.call(bun, { ...options, fetch: guardFetch(options.fetch, state) });
      return bound;
    };
    server = startServer(state.config.port, { readinessGate });
    if (count !== 1 || server !== bound || server?.port !== state.config.port || typeof server.stop !== 'function') throw new Error('Pinned OpenCodex startup contract changed; refusing to start.');
    return server;
  } catch (error) {
    bound?.stop?.(true);
    throw error;
  } finally {
    bun.serve = originalServe;
  }
}

export function loginArgs(provider, device = false) {
  if (provider === 'chatgpt') return ['account', 'login', 'openai', '--id', 'omh-chatgpt', ...(device ? ['--device'] : [])];
  if (device || !['cursor', 'kimi', 'kimi-code', 'deepseek'].includes(provider)) throw new Error('Login supports cursor, kimi, kimi-code, deepseek, or chatgpt [--device].');
  return ['login', provider];
}
