import { createHash } from 'node:crypto';
import { NbaDataError, assertNba } from './identity.js';

export function createNbaCache({ capacity = 64, maxStaleMs = 6 * 60 * 60 * 1000 } = {}) {
  const entries = new Map();
  const inflight = new Map();
  return {
    clear() { entries.clear(); },
    get size() { return entries.size; },
    async fetchJson(url, { fetchImpl = fetch, now = Date.now, ttlMs = 60000, timeoutMs = 20000, validate } = {}) {
      const time = () => Number(typeof now === 'function' ? now() : now);
      const parsed = new URL(url);
      const siteEndpoint = parsed.hostname === 'site.api.espn.com' && parsed.pathname.startsWith('/apis/site/v2/sports/basketball/nba/');
      const playerEndpoint = parsed.hostname === 'site.web.api.espn.com' && /^\/apis\/common\/v3\/sports\/basketball\/nba\/athletes\/[1-9]\d{0,14}(?:\/stats)?$/.test(parsed.pathname);
      assertNba(parsed.protocol === 'https:' && !parsed.username && !parsed.password && (siteEndpoint || playerEndpoint), 'SOURCE_NOT_ALLOWED', '資料來源不在 NBA 允許清單');
      assertNba(typeof validate === 'function', 'VALIDATOR_REQUIRED', '快取前必須驗證 NBA 資料結構');
      const cached = entries.get(url);
      if (cached && time() - cached.storedAt >= 0 && time() - cached.storedAt < ttlMs) {
        entries.delete(url); entries.set(url, cached);
        return structuredClone({ value: cached.value, source: { ...cached.source, cacheStatus: 'hit', cacheAgeMs: time() - cached.storedAt } });
      }
      if (inflight.has(url)) return structuredClone(await inflight.get(url));
      const request = (async () => {
        const controller = new AbortController();
        let timer;
        try {
          const operation = (async () => {
            const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal, cache: 'no-store', redirect: 'error' });
            if (!response.ok) throw new NbaDataError(`UPSTREAM_HTTP_${response.status}`, `ESPN 資料來源回應 HTTP ${response.status}`);
            const contentType = response.headers?.get('content-type') || '';
            assertNba(!contentType || contentType.includes('json'), 'UPSTREAM_CONTENT_TYPE', '資料來源未回傳 JSON');
            const raw = await response.text();
            assertNba(raw.length <= 8 * 1024 * 1024, 'UPSTREAM_TOO_LARGE', '來源資料超出單次處理大小');
            let value;
            try { value = JSON.parse(raw); } catch { throw new NbaDataError('UPSTREAM_JSON_INVALID', '資料來源 JSON 格式錯誤'); }
            validate(value);
            const fetchedAt = new Date(time()).toISOString();
            const publishedValue = value?.meta?.lastUpdatedAt ?? value?.timestamp ?? null;
            const publishedAt = typeof publishedValue === 'string' && Number.isFinite(Date.parse(publishedValue)) ? new Date(publishedValue).toISOString() : null;
            const source = { provider: 'ESPN', role: 'secondary', url, fetchedAt, retrievedAt: fetchedAt, publishedAt, publicationBasis: value?.meta?.lastUpdatedAt ? 'provider_game_update' : value?.timestamp ? 'provider_feed_timestamp' : 'not_supplied', hash: createHash('sha256').update(raw).digest('hex'), status: 'ready', cacheStatus: 'miss', cacheAgeMs: 0, officialIdentityVerified: false };
            return { value, source };
          })();
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new NbaDataError('UPSTREAM_TIMEOUT', 'NBA 資料來源逾時')); }, timeoutMs); });
          const result = await Promise.race([operation, timeout]);
          entries.delete(url); entries.set(url, { ...result, storedAt: time() });
          while (entries.size > capacity) entries.delete(entries.keys().next().value);
          return structuredClone(result);
        } catch (error) {
          const validationFailure = /IDENTITY|SCHEMA|SEASON|DATE|SCORE/.test(error.code || '');
          if (!validationFailure && cached && time() - cached.storedAt >= 0 && time() - cached.storedAt <= maxStaleMs) return structuredClone({ value: cached.value, source: { ...cached.source, status: 'stale', cacheStatus: 'stale_fallback', cacheAgeMs: time() - cached.storedAt, errorCode: error.code || 'UPSTREAM_UNAVAILABLE' } });
          throw error;
        } finally { clearTimeout(timer); }
      })();
      inflight.set(url, request);
      try { return await request; } finally { inflight.delete(url); }
    }
  };
}

export const nbaCache = createNbaCache();
