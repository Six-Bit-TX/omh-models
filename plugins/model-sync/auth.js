/** Server-only catalogue authentication; no resolved value enters settings or logs. */

/** Read a managed credential reference, refusing an explicitly missing credential. */
async function resolveSecret(ctx, ref) {
  let hit;
  try { hit = await ctx.get('credentials')?.resolve(ref); }
  catch { throw new Error('catalogue credential could not be resolved'); }
  if (!hit?.value) throw new Error('catalogue credential is not configured');
  return hit.value;
}

/** Only reuse provider headers for the exact model-list endpoint that provider names. */
function ownsEndpoint(provider, bridge) {
  if (typeof provider?.baseURL !== 'string') return false;
  try {
    const base = new URL(provider.baseURL);
    if (base.username || base.password || base.search || base.hash) return false;
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/models`;
    return base.href === bridge;
  } catch { return false; }
}

/** Resolve one request's headers without moving a provider credential to another endpoint. */
export async function catalogueHeaders(ctx, config) {
  const providers = ctx.get('settings').describe().find(descriptor => descriptor.ns === 'llm-pi-ai')?.value?.providers;
  const matching = config.routes.map(route => providers?.[route]).filter(provider => ownsEndpoint(provider, config.bridge));
  const provider = matching.find(profile => profile.apiKeyEnv || Object.keys(profile.headers ?? {}).length > 0);
  let headers;
  try { headers = new Headers(provider?.headers); }
  catch { throw new Error('catalogue provider headers are invalid'); }
  headers.set('accept', 'application/json');
  const ref = config.credentialRef ?? (headers.has('authorization') ? undefined : provider?.apiKeyEnv);
  if (ref !== undefined) {
    const value = await resolveSecret(ctx, ref);
    try { headers.set('authorization', `Bearer ${value}`); }
    catch { throw new Error('catalogue credential cannot be used in a request header'); }
  }
  return headers;
}
