// Operational source backoff only. No model, probability or data-QA thresholds.
// A response limits its actual host across URLs; unrelated fetch implementations
// (including deterministic test transports) never inherit another transport's
// state. Already completed successful caches keep their original source times.
const byFetch = new WeakMap();
const validTime = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime());

export function nhlRetryAfterPolicy(header, now = Date.now()) {
  if (!validTime(now)) throw new Error('NHL_RETRY_CLOCK_INVALID');
  const retryAfter = typeof header === 'string' && header.trim().length <= 256 ? header.trim() : null;
  let deadline = null;
  if (/^\d+$/.test(retryAfter || '')) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds) && validTime(now + seconds * 1000)) deadline = now + seconds * 1000;
  } else if (/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )/.test(retryAfter || '')) {
    const parsed = Date.parse(retryAfter);
    if (validTime(parsed)) deadline = Math.max(now, parsed);
  }
  const validHeader = deadline !== null;
  return { retryAfter: retryAfter || null, retryAt: new Date(validHeader ? deadline : now + 60_000).toISOString(),
    retryPolicy: validHeader ? 'OFFICIAL_RETRY_AFTER' : 'CONSERVATIVE_60_SECOND_BACKOFF_HEADER_ABSENT_OR_INVALID',
    rateLimitObservedAt: new Date(now).toISOString() };
}

export function recordNhlSourceRateLimit(fetchImpl, url, { retryAfter = null, now = Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('NHL_RETRY_FETCH_INVALID');
  const host = new URL(url).host;
  const policy = { ...nhlRetryAfterPolicy(retryAfter, now), rateLimitHost: host, rateLimitSourceUrl: url };
  if (!byFetch.has(fetchImpl)) byFetch.set(fetchImpl, new Map());
  const store = byFetch.get(fetchImpl); const prior = store.get(host);
  // Parallel responses cannot shorten an already instructed cooldown.
  const effective = prior && Date.parse(prior.retryAt) > Date.parse(policy.retryAt) ? prior : policy;
  store.set(host, effective);
  return structuredClone(effective);
}

export function nhlSourceCooldown(fetchImpl, url, now = Date.now()) {
  if (typeof fetchImpl !== 'function' || !validTime(now)) throw new Error('NHL_RETRY_OPTIONS_INVALID');
  const host = new URL(url).host; const store = byFetch.get(fetchImpl); const policy = store?.get(host);
  if (!policy) return null;
  if (Date.parse(policy.retryAt) <= now) { store.delete(host); return null; }
  return { ...structuredClone(policy), hostCooldown: true };
}
