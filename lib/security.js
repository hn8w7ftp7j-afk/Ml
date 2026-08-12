const encoder = new TextEncoder();
const buckets = globalThis.__MLB_EV_RATE_BUCKETS__ || new Map();
globalThis.__MLB_EV_RATE_BUCKETS__ = buckets;

function applicationPassword() {
  return String(process.env.APP_PASSWORD || process.env.TAI888_PASSWORD || '');
}

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function appPasswordConfigured() {
  return Boolean(applicationPassword().trim());
}

export async function passwordMatches(candidate) {
  const expected = applicationPassword();
  if (!expected || typeof candidate !== 'string' || candidate.length > 300) return false;
  return constantTimeEqual(await sha256(candidate), await sha256(expected));
}

export async function createSessionToken(maxAgeSeconds = 60 * 60 * 24 * 30) {
  const secret = String(process.env.SESSION_SECRET || process.env.APP_PASSWORD || process.env.TAI888_PASSWORD || '');
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  const exp = Math.floor(Date.now() / 1000) + maxAgeSeconds;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function verifySessionToken(token) {
  const secret = String(process.env.SESSION_SECRET || process.env.APP_PASSWORD || process.env.TAI888_PASSWORD || '');
  if (!secret || !token) return false;
  const [expText, signature] = String(token).split('.');
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000) || !signature) return false;
  const expected = await hmac(secret, expText);
  return constantTimeEqual(encoder.encode(signature), encoder.encode(expected));
}

export function readCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const part = cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

export async function requestIsAuthenticated(request) {
  if (!appPasswordConfigured()) return true;
  return verifySessionToken(readCookie(request, 'mlb_session'));
}

export async function requireApiAuth(request) {
  if (await requestIsAuthenticated(request)) return null;
  return new Response(JSON.stringify({ ok: false, error: '尚未登入或登入已過期' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function requestIp(request) {
  return (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown').split(',')[0].trim();
}

export function checkRateLimit(request, { id, limit, windowMs }) {
  const now = Date.now();
  const key = `${id}:${requestIp(request)}`;
  const current = buckets.get(key);
  const row = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  row.count += 1;
  buckets.set(key, row);
  if (buckets.size > 2000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    while (buckets.size > 1500) buckets.delete(buckets.keys().next().value);
  }
  return { allowed: row.count <= limit, retryAfter: Math.max(1, Math.ceil((row.resetAt - now) / 1000)), remaining: Math.max(0, limit - row.count) };
}

export function rateLimitResponse(result) {
  return new Response(JSON.stringify({ ok: false, error: '請求過於頻繁，請稍後再試' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(result.retryAfter), 'Cache-Control': 'no-store' },
  });
}

export function validateSameOrigin(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

export function originErrorResponse() {
  return new Response(JSON.stringify({ ok: false, error: '不允許的請求來源' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function readJsonBody(request, maxBytes = 262144) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    const error = new Error('請求資料過大'); error.status = 413; throw error;
  }
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) {
    const error = new Error('請求資料過大'); error.status = 413; throw error;
  }
  let value;
  try { value = JSON.parse(text || '{}'); }
  catch { const error = new Error('JSON 格式錯誤'); error.status = 400; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('請求格式錯誤'); error.status = 400; throw error;
  }
  return value;
}

export function positiveInteger(value, max = 999999999) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

export function validDateString(value) {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function cleanText(value, maxLength = 120) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}
