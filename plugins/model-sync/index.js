/**
 * Keep OMH's provider model lists in step with what the local bridge actually
 * serves, so a model the provider added or retired appears in the picker
 * without hand-editing settings.yaml.
 *
 * Runs once when startup is committed and again when a Session is created
 * (which is what "opening OMH" amounts to), fetching the bridge's OpenAI-shaped
 * /v1/models and writing only the `models` arrays of the routes it maintains,
 * through the settings service: the same document the Models page writes, under
 * the same writer lock, with the same revision fence and pi-ai validation. A
 * running client refreshes its picker on the resulting settings update, so no
 * restart is involved.
 */
import { POLICY_NS, ROUTES, planOps, planPolicyOps } from "./catalogue.js";

export const name = "model-sync";
export const inject = ["settings"];

/** The bridge's OpenAI-shaped model list; also the authority on what is servable. */
const BRIDGE = "http://127.0.0.1:10100/v1/models";

/** The pi-ai settings namespace whose provider routes carry the model lists. */
const NS = "llm-pi-ai";

/** The bridge caches provider rosters for five minutes; polling faster reads the same bytes. */
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Bound the fetch: a bridge that accepts a connection and then stalls must not hold the hook. */
const FETCH_TIMEOUT_MS = 10 * 1000;

/** Attempts per route: one, plus one after a concurrent write moved the namespace. */
const ATTEMPTS = 2;

/**
 * How long one run may stay unsettled before its latch is released. A settings
 * write that never settles — a hung persist, or the namespace queue stalled
 * behind another caller's write — would otherwise retire the plugin for the life
 * of the process, since every later trigger would see it as still running.
 */
const DEFAULT_STUCK_AFTER_MS = 120 * 1000;

/**
 * Register the catalogue reconciliation.
 * @param ctx - the plugin's context, whose `settings` service owns the document.
 * @param config - optional `{ bridge, minIntervalMs, routes, stuckAfterMs }` overrides.
 */
export function apply(ctx, config = {}) {
  const bridge = typeof config.bridge === "string" && config.bridge !== "" ? config.bridge : BRIDGE;
  const minIntervalMs = Number.isSafeInteger(config.minIntervalMs) && config.minIntervalMs >= 0
    ? config.minIntervalMs
    : DEFAULT_MIN_INTERVAL_MS;
  const routes = Array.isArray(config.routes) && config.routes.length > 0 ? config.routes : ROUTES;
  const stuckAfterMs = Number.isSafeInteger(config.stuckAfterMs) && config.stuckAfterMs > 0
    ? config.stuckAfterMs
    : DEFAULT_STUCK_AFTER_MS;
  let lastRun = 0;
  let running = false;

  const readCatalogue = async () => {
    const response = await fetch(bridge, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${bridge} answered ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.data)) throw new Error(`${bridge} did not answer with a model list`);
    return body.data;
  };

  /** A namespace's current write fence, read at the moment of the write. */
  const revisionOf = (settings, ns) =>
    settings.describe?.().find((descriptor) => descriptor.ns === ns)?.revision;

  /**
   * Apply one namespace's plan, replanning after a concurrent write moved it: the
   * fence tells us our plan is superseded, so re-applying it under a fresh
   * revision would overwrite whatever the other writer stored.
   * @param ns - the settings namespace to write.
   * @param build - recomputes the operations from the namespace as it now stands.
   * @returns whether anything was written.
   */
  const applyOps = async (ns, build) => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const settings = ctx.get("settings");
      const ops = build(settings);
      if (ops.length === 0) return false;
      try {
        await settings.mutate(ns, ops, revisionOf(settings, ns));
        return true;
      } catch (error) {
        if (error?.code !== "SETTINGS_CONFLICT" || attempt === ATTEMPTS) throw error;
      }
    }
    return false;
  };

  /** Bring one route's model list up to date. */
  const applyRoute = (route, rows) =>
    applyOps(NS, (settings) => planOps(rows, settings.get(NS), [route]));

  const sync = async (reason) => {
    if (ctx.get("settings") === undefined) return;
    const rows = await readCatalogue();
    const updated = [];
    const refused = [];
    // One write per route, each contained: the settings service validates the whole
    // merged section, so batching would let a refused route block the other — and so
    // would abandoning the loop before the remaining routes ran.
    for (const route of routes) {
      try {
        if (await applyRoute(route, rows)) updated.push(route);
      } catch (error) {
        refused.push(`${route}: ${String(error?.message ?? error)}`);
      }
    }
    if (updated.length > 0) ctx.logger?.info?.(`model-sync: ${reason}; updated ${updated.join(", ")}`);
    // The delegation allow-list follows the catalogue, so a model the picker offers
    // can also be delegated. Its own write is contained for the same reason.
    try {
      const mirrored = await applyOps(POLICY_NS, (settings) =>
        planPolicyOps(settings.get(POLICY_NS)?.allowedModels, settings.get(NS), rows, routes));
      if (mirrored) ctx.logger?.info?.(`model-sync: ${reason}; mirrored the delegation allow-list`);
    } catch (error) {
      refused.push(`delegation allow-list: ${String(error?.message ?? error)}`);
    }
    if (refused.length > 0) throw new Error(refused.join("; "));
  };

  let watchdog;

  const schedule = (reason) => {
    const now = Date.now();
    if (running || now - lastRun < minIntervalMs) return undefined;
    lastRun = now;
    running = true;
    const run = sync(reason)
      .catch((error) => {
        // The bridge is an optional local service: unreachable or unauthenticated
        // is a normal state, and the declared lists stay as they are.
        ctx.logger?.warn?.(`model-sync: ${reason} skipped: ${String(error?.message ?? error)}`);
      })
      .finally(() => {
        clearTimeout(watchdog);
        running = false;
      });
    watchdog = setTimeout(() => {
      if (!running) return;
      ctx.logger?.warn?.(`model-sync: ${reason} still unsettled after ${stuckAfterMs} ms; releasing the latch`);
      running = false;
    }, stuckAfterMs);
    return run;
  };

  // The one timer this plugin owns leaves with its fiber.
  ctx.effect(() => () => { clearTimeout(watchdog); }, "model-sync: watchdog");

  ctx.get("appReady")?.onReady?.(() => schedule("startup"));
  ctx.on("agent/created", () => schedule("session"));
}
