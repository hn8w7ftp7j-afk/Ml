// NHL-only cache. No baseball cache key, default league or model can enter here.
const memory = new Map();
const pending = new Map();
// Do not reuse normalized roster entries accepted before strict identity QA.
const PREFIX = 'sports:nhl:data:v4';
let runtimePromise;

async function runtimeCache() {
  if (process.env.VERCEL !== '1') return null;
  if (!runtimePromise) runtimePromise = import('@vercel/functions').then(module => module.getCache()).catch(() => null);
  return runtimePromise;
}

export async function cachedNhlData(key, loader, { ttlMs = 60_000, now = Date.now(), runtime = undefined } = {}) {
  if (typeof key !== 'string' || !/^[a-z0-9:._-]{1,180}$/i.test(key)) throw new Error('INVALID_NHL_CACHE_KEY');
  if (typeof loader !== 'function' || !Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('INVALID_NHL_CACHE_OPTIONS');
  const cacheKey = `${PREFIX}:${key}`;
  const cached = memory.get(cacheKey);
  if (cached && cached.expiresAt > now) return { ...structuredClone(cached.value), cache: { hit: true, tier: 'memory', expiresAt: cached.expiresAt } };
  if (pending.has(cacheKey)) return structuredClone(await pending.get(cacheKey));
  const operation = (async () => {
    const shared = runtime === undefined ? await runtimeCache() : runtime;
    if (shared) {
      try {
        const value = await shared.get(cacheKey);
        if (value?.league === 'NHL' && value?.value?.league === 'NHL' && Number.isFinite(value.expiresAt) && value.expiresAt > now) {
          memory.set(cacheKey, structuredClone(value));
          if (memory.size > 250) memory.delete(memory.keys().next().value);
          return { ...structuredClone(value.value), cache: { hit: true, tier: 'runtime', expiresAt: value.expiresAt } };
        }
      } catch { /* The authoritative loader still runs; no empty-success fallback. */ }
    }
    const value = await loader();
    if (!value || value.league !== 'NHL') throw new Error('NHL_CACHE_LEAGUE_CONFLICT');
    const expiresAt = now + ttlMs;
    const entry = { league: 'NHL', value: structuredClone(value), expiresAt };
    memory.set(cacheKey, entry);
    // Bound the process cache; expiry does not erase the displayed browser result.
    if (memory.size > 250) memory.delete(memory.keys().next().value);
    let tier = 'memory';
    if (shared) {
      try { await shared.set(cacheKey, entry, { ttl: Math.ceil(ttlMs / 1000), tags: ['nhl-data-v4'] }); tier = 'runtime'; }
      catch { /* Public data can be fetched again; never used as a durable ledger. */ }
    }
    return { ...structuredClone(value), cache: { hit: false, tier, expiresAt } };
  })();
  pending.set(cacheKey, operation);
  try { return structuredClone(await operation); } finally { pending.delete(cacheKey); }
}
