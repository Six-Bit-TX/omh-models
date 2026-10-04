/**
 * Which of the bridge's published model ids belong to which OMH provider route,
 * and the profile fields each one carries.
 *
 * The bridge's OpenAI-shaped list publishes the account-native ChatGPT/Codex
 * surface bare ("gpt-5.6-sol") and every other provider namespaced
 * ("deepseek/...", "cursor/..."); the published string is also the string a
 * request must send, so an entry's id is written verbatim.
 */

/** Words capitalized in a synthesized label; anything else is left alone. */
const WORDS = new Map([
  ["claude", "Claude"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"],
  ["fable", "Fable"], ["gpt", "GPT"], ["gemini", "Gemini"], ["flash", "Flash"],
  ["pro", "Pro"], ["codex", "Codex"], ["mini", "Mini"], ["nano", "Nano"], ["max", "Max"],
  ["extra", "Extra"], ["sol", "Sol"], ["terra", "Terra"], ["luna", "Luna"], ["kimi", "Kimi"],
  ["glm", "GLM"], ["grok", "Grok"], ["composer", "Composer"], ["auto", "Auto"],
  ["thinking", "Thinking"], ["image", "Image"], ["preview", "Preview"], ["code", "Code"],
  ["fast", "Fast"], ["balance", "Balance"], ["cost", "Cost"], ["intelligence", "Intelligence"],
  ["spark", "Spark"], ["astra", "Astra"], ["1m", "1M"],
]);

/**
 * The reasoning levels the profile schema accepts. The bridge advertises more
 * than this (its ChatGPT/Codex ladder adds `ultra`), and a key outside this set
 * makes the whole section unservable: the settings service validates the merged
 * section and refuses the write, so an unfiltered rung leaves the route
 * permanently unsynced. A rung the schema cannot express is dropped, never
 * renamed onto a different level.
 */
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The request modalities the profile schema accepts. */
const MODALITIES = ["text", "image"];

/** The provider routes this plugin maintains, in the order it writes them. */
export const ROUTES = ["opencodex", "cursor"];

/** The settings namespace holding which routes a delegated child may select. */
export const POLICY_NS = "subagent-model-selection-settings";

/**
 * The OMH provider route a published row belongs to, or `undefined` when the id
 * belongs to a family that keeps its own OMH provider (DeepSeek, Kimi, ...):
 * listing one upstream model under two providers would show it twice.
 * @param id - a published model id.
 * @returns the route that should carry it.
 */
export function routeFor(id) {
  if (id.startsWith("cursor/")) return "cursor";
  if (id.startsWith("openai/")) return "opencodex";
  return id.includes("/") ? undefined : "opencodex";
}

/**
 * A human label for a model id whose route declares none yet: known words
 * capitalized, a run of number tokens joined into a version ("4-7" -> "4.7"),
 * and the bridge's `--fast` variant marked.
 * @param id - a published model id.
 * @returns the label.
 */
export function label(id) {
  const suffix = id.endsWith("--fast") ? " (Fast)" : "";
  const base = (suffix === "" ? id : id.slice(0, -"--fast".length)).split("/").pop();
  const tokens = base.split("-").map((raw) => {
    const known = WORDS.get(raw.toLowerCase());
    if (known !== undefined) return known;
    const kimi = /^k(\d+(?:\.\d+)?)$/i.exec(raw);
    return kimi === null ? raw : `K${kimi[1]}`;
  });
  const out = [];
  for (const token of tokens) {
    const last = out.at(-1);
    if (last !== undefined && /^\d+$/.test(last) && /^\d{1,2}$/.test(token)) out[out.length - 1] = `${last}.${token}`;
    else out.push(token);
  }
  return out.join(" ") + suffix;
}

/**
 * One OMH model-profile entry for a published row, with the capacities the row
 * itself advertises.
 * @param row - one entry of the bridge's model list.
 * @param authored - the label the document already carries for this id, if any.
 * @returns the profile entry to store.
 */
export function entryFor(row, authored) {
  const capabilities = row?.capabilities ?? {};
  const entry = { id: row.id, name: authored ?? label(row.id) };
  // The schema floors both capacities at 1, so a zero or fractional advertisement
  // is omitted (the route's default applies) rather than stored and refused.
  if (Number.isSafeInteger(capabilities.context_length) && capabilities.context_length > 0) entry.contextWindow = capabilities.context_length;
  if (Number.isSafeInteger(capabilities.max_output_tokens) && capabilities.max_output_tokens > 0) entry.maxTokens = capabilities.max_output_tokens;
  const advertised = Array.isArray(capabilities.input_modalities) ? capabilities.input_modalities : [];
  const modalities = advertised.filter((modality) => MODALITIES.includes(modality));
  entry.input = modalities.length > 0 ? modalities : ["text"];
  const efforts = (Array.isArray(capabilities.reasoning_effort) ? capabilities.reasoning_effort : [])
    .filter((effort) => REASONING_LEVELS.includes(effort));
  if (efforts.length > 0) entry.reasoningEfforts = Object.fromEntries(efforts.map((effort) => [effort, effort]));
  return entry;
}

/**
 * The fields this plugin owns, in a stable order, so a rewrite is decided by a
 * real change rather than by key order or formatting drift.
 * @param models - stored or freshly built profile entries.
 * @returns the comparison signature.
 */
export function signature(models) {
  return JSON.stringify((Array.isArray(models) ? models : []).map((model) => [
    model.id,
    model.name,
    model.contextWindow ?? null,
    model.maxTokens ?? null,
    [...(model.input ?? [])].sort(),
    Object.entries(model.reasoningEfforts ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]));
}

/**
 * The settings operations that bring the declared model lists up to what the
 * bridge serves, and the plugin owns the whole `models` array: a capability the
 * document carries is normalised to the bridge's advertised value, so only a
 * label survives a sync — a hand-authored override inside a managed list does
 * not. A route absent from the published list is left exactly as
 * declared: the list is untrustworthy while a provider is unauthenticated or
 * failing, and an empty catalogue is never a retirement notice.
 * @param rows - the bridge's published model list.
 * @param resolved - the resolved `llm-pi-ai` settings section.
 * @param routes - the provider routes to maintain.
 * @returns `set` operations, one per route whose list actually changed.
 */
/** The published rows each route owns, deduplicated in published order. */
function groupPublished(rows, routes) {
  const grouped = new Map(routes.map((route) => [route, []]));
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== "string" || row.id.trim() !== row.id || row.id.length === 0 || /[\u0000-\u001f]/.test(row.id)) continue;
    // Resolution marks a duplicated id as an error and filters BOTH copies out of
    // the servable list, so a repeated row would silently retire a working model.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const route = routeFor(row.id);
    if (route === undefined || !grouped.has(route)) continue;
    grouped.get(route).push(row);
  }
  return grouped;
}

export function planOps(rows, resolved, routes = ROUTES) {
  const grouped = groupPublished(rows, routes);
  const ops = [];
  for (const route of routes) {
    const published = grouped.get(route);
    if (published.length === 0) continue;
    const declared = resolved?.providers?.[route]?.models;
    if (resolved?.providers?.[route] === undefined) continue;
    const authored = new Map((Array.isArray(declared) ? declared : []).map((model) => [model.id, model.name]));
    const next = published.map((row) => entryFor(row, authored.get(row.id)));
    if (signature(declared) === signature(next)) continue;
    ops.push({ op: "set", path: ["providers", route, "models"], value: next });
  }
  return ops;
}

/**
 * The operations that keep the delegation allow-list in step with the routes this
 * plugin maintains. Entries of every other provider are preserved verbatim, and a
 * route the bridge publishes nothing for keeps whatever the document already
 * allows, so an unauthenticated provider cannot silently withdraw delegation.
 * A document with no allow-list section is left alone entirely.
 * @param allowedModels - the resolved allow-list, or `undefined` when unresolvable.
 * @param resolved - the resolved `llm-pi-ai` section, as the models write left it.
 * @param rows - the bridge's published model list.
 * @param routes - the provider routes to mirror.
 * @returns `set` operations, empty when the list already agrees.
 */
export function planPolicyOps(allowedModels, resolved, rows, routes = ROUTES) {
  if (!Array.isArray(allowedModels)) return [];
  const grouped = groupPublished(rows, routes);
  const live = routes.filter((route) =>
    (grouped.get(route) ?? []).length > 0 && resolved?.providers?.[route] !== undefined);
  if (live.length === 0) return [];
  const key = (entry) => `${entry.provider}\u0000${entry.model}`;
  const dedupe = (entries) => {
    const seen = new Set();
    return entries.filter((entry) => {
      if (typeof entry?.provider !== "string" || typeof entry?.model !== "string") return false;
      if (seen.has(key(entry))) return false;
      seen.add(key(entry));
      return true;
    });
  };
  const current = dedupe(allowedModels);
  const next = dedupe([
    ...current.filter((entry) => !live.includes(entry.provider)),
    ...live.flatMap((route) => (resolved.providers[route].models ?? []).map((model) => ({ provider: route, model: model.id }))),
  ]);
  // A set comparison, so an operator's manual reordering is not mistaken for drift.
  if (current.map(key).sort().join("\n") === next.map(key).sort().join("\n")) return [];
  return [{ op: "set", path: ["allowedModels"], value: next }];
}
