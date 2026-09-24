import { createHash } from 'node:crypto';

// Only explicit upstream quota failures are cooled down. No successful data is
// cached, and a changed credential gets a fresh attempt. State is per process.
export function createExternalJsonTransport({ fetchImpl = fetch, now = Date.now,
  cooldownMs = 300000, log = row => console.info(JSON.stringify(row)) } = {}) {
  const cooldowns = new Map();
  return async function externalJson(url, options = {}, timeoutMs = 25000) {
    const parsed = new URL(url);
    const headers = new Headers(options.headers);
    const credential = [parsed.searchParams.get('apiKey') || '', headers.get('authorization') || '',
      headers.get('x-jbot-token') || ''].join('\n');
    const scope = `${parsed.origin}:${createHash('sha256').update(credential).digest('hex')}`;
    const started = now();
    const metric = { event: 'EXTERNAL_HTTP_TIMING', origin: parsed.origin, status: null, outcome: 'failed' };
    let timer;
    try {
      const cached = cooldowns.get(scope);
      if (cached && cached.until > now()) {
        metric.outcome = 'quota_cooldown';
        metric.status = cached.status;
        throw Object.assign(new Error('External provider quota exhausted; temporarily cooling down'), {
          code: 'QUOTA_EXHAUSTED', httpStatus: cached.status,
          retryAfterSeconds: Math.ceil((cached.until - now()) / 1000),
        });
      }
      cooldowns.delete(scope);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
      metric.headersMs = Math.max(0, now() - started);
      metric.status = response.status;
      const body = await response.text();
      metric.bodyMs = Math.max(0, now() - started - metric.headersMs);
      let data;
      try { data = JSON.parse(body); }
      catch { throw Object.assign(new Error(`外部服務回傳格式錯誤（${response.status}）`), { code: 'INVALID_JSON', httpStatus: response.status }); }
      if (!response.ok) {
        const message = String(data?.message || data?.error || `外部服務請求失敗（${response.status}）`);
        const quota = /quota|usage.*(reached|limit)|out.of.*credits/i.test(message);
        if (quota) {
          cooldowns.set(scope, { until: now() + cooldownMs, status: response.status });
          if (cooldowns.size > 64) cooldowns.delete(cooldowns.keys().next().value);
          metric.outcome = 'quota_exhausted';
        }
        throw Object.assign(new Error(message), { httpStatus: response.status,
          ...(quota ? { code: 'QUOTA_EXHAUSTED', retryAfterSeconds: Math.ceil(cooldownMs / 1000) } : {}) });
      }
      metric.outcome = 'ok';
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') metric.outcome = 'timeout';
      throw error;
    } finally {
      clearTimeout(timer);
      // Observability must never change the request's result. Never log URLs,
      // query strings, headers, credentials, bodies or upstream error messages.
      try { log({ ...metric, durationMs: Math.max(0, now() - started) }); } catch {}
    }
  };
}

export const fetchExternalJson = createExternalJsonTransport();
