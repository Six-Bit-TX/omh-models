/** Refresh bridge-backed model pickers and delegation policy after startup and periodically. */
import { POLICY_NS, planOps, planPolicyOps } from './catalogue.js';
import { resolveConfig } from './config.js';
import { catalogueHeaders } from './auth.js';

export const name = 'model-sync';
export const inject = ['settings', 'appReady', 'credentials'];
const NS = 'llm-pi-ai';
const ATTEMPTS = 2;

/**
 * Register authenticated catalogue refreshes without changing provider connection settings.
 * @param ctx - host context with settings, startup readiness, and credential services.
 * @param input - bridge, routes, credentialRef, and deployment timer configuration.
 */
export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  let disposed = false;
  let started = false;
  let lastRun = -Infinity;
  let active;
  let interval;
  const pending = new Set();
  const current = run => !disposed && active === run && !run.controller.signal.aborted;
  const ensureCurrent = run => {
    if (!current(run)) throw new Error('catalogue refresh cancelled');
  };

  const readCatalogue = async run => {
    const headers = await catalogueHeaders(ctx, config);
    ensureCurrent(run);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.fetchTimeoutMs);
    timer.unref?.();
    try {
      let response;
      try {
        response = await fetch(config.bridge, {
          headers,
          // Redirects cannot forward operator-configured headers to another origin.
          redirect: 'error',
          signal: AbortSignal.any([run.controller.signal, timeout.signal]),
        });
      } catch {
        throw new Error(timeout.signal.aborted ? 'catalogue request timed out' : 'catalogue request failed');
      }
      if (!response.ok) throw new Error(`catalogue answered HTTP ${response.status}`);
      let body;
      try { body = await response.json(); }
      catch { throw new Error('catalogue did not answer with valid JSON'); }
      if (!Array.isArray(body?.data)) throw new Error('catalogue did not answer with a model list');
      ensureCurrent(run);
      return body.data;
    } finally { clearTimeout(timer); }
  };

  /** Replan after a concurrent settings write, preserving its unrelated edits. */
  const applyOps = async (run, ns, build) => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      ensureCurrent(run);
      const settings = ctx.get('settings');
      const descriptors = settings.describe();
      const revision = descriptors.find(descriptor => descriptor.ns === ns)?.revision;
      const value = namespace => descriptors.find(descriptor => descriptor.ns === namespace)?.value;
      const ops = build(value);
      if (ops.length === 0) return false;
      try {
        await settings.mutate(ns, ops, revision);
        ensureCurrent(run);
        return true;
      } catch (error) {
        ensureCurrent(run);
        if (error?.code !== 'SETTINGS_CONFLICT' || attempt === ATTEMPTS) throw error;
      }
    }
    return false;
  };

  const sync = async (reason, run) => {
    const rows = await readCatalogue(run);
    const updated = [];
    const refused = [];
    for (const route of config.routes) {
      ensureCurrent(run);
      try {
        if (await applyOps(run, NS, value => planOps(rows, value(NS), [route]))) updated.push(route);
      } catch (error) {
        ensureCurrent(run);
        refused.push(`${route}: ${String(error?.message ?? error)}`);
      }
    }
    ensureCurrent(run);
    if (updated.length > 0) ctx.logger?.info?.(`model-sync: ${reason}; updated ${updated.join(', ')}`);
    try {
      const mirrored = await applyOps(run, POLICY_NS, value =>
        planPolicyOps(value(POLICY_NS)?.allowedModels, value(NS), rows, config.routes));
      if (mirrored) ctx.logger?.info?.(`model-sync: ${reason}; mirrored the delegation allow-list`);
    } catch (error) {
      ensureCurrent(run);
      refused.push(`delegation allow-list: ${String(error?.message ?? error)}`);
    }
    if (refused.length > 0) throw new Error(refused.join('; '));
  };

  const schedule = reason => {
    const now = Date.now();
    if (disposed || !started || active || (reason !== 'interval' && now - lastRun < config.minIntervalMs)) return undefined;
    lastRun = now;
    const run = { controller: new AbortController() };
    active = run;
    const cancelled = new Promise((resolve, reject) => {
      run.controller.signal.addEventListener('abort', () => reject(new Error('catalogue refresh cancelled')), { once: true });
    });
    const watchdog = setTimeout(() => {
      if (!current(run)) return;
      ctx.logger?.warn?.(`model-sync: ${reason} still unsettled after ${config.stuckAfterMs} ms; releasing the latch`);
      run.controller.abort();
    }, config.stuckAfterMs);
    watchdog.unref?.();
    // A settings transaction already accepted by its owner cannot be cancelled.
    // Abort releases this run and prevents its eventual continuation making any further writes.
    const promise = Promise.race([sync(reason, run), cancelled])
      .catch(error => {
        if (current(run)) ctx.logger?.warn?.(`model-sync: ${reason} skipped: ${String(error?.message ?? error)}`);
      })
      .finally(() => {
        clearTimeout(watchdog);
        if (active === run) active = undefined;
        pending.delete(promise);
      });
    pending.add(promise);
    return promise;
  };

  ctx.effect(() => {
    const cancelReady = ctx.get('appReady').onReady(() => {
      if (disposed || started) return undefined;
      started = true;
      if (config.refreshIntervalMs > 0) {
        interval = setInterval(() => schedule('interval'), config.refreshIntervalMs);
        interval.unref?.();
      }
      return schedule('startup');
    });
    return async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      cancelReady();
      active?.controller.abort();
      await Promise.all(pending);
    };
  }, 'model-sync: startup, periodic refresh, and cancellation');
  ctx.on('agent/created', () => schedule('session'), { global: true });
}
