const encoder = new TextEncoder();
const TOKEN_VERSION = 'reader-v2';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

function pairingSecret() {
  return String(process.env.READER_PAIR_SECRET || '');
}

function b64urlEncode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

function b64urlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

async function hmac(value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pairingSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)))).toString('base64url');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function readerPairingConfigured() {
  return Boolean(pairingSecret());
}

export async function readerPairPasswordMatches(candidate) {
  const expected = pairingSecret();
  if (!expected || typeof candidate !== 'string' || candidate.length > 300) return false;
  return constantTimeEqual(await sha256(candidate), await sha256(expected));
}

export async function createReaderToken({ deviceId, deviceName = '', ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!readerPairingConfigured()) throw new Error('Reader pairing secret is not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: TOKEN_VERSION,
    aud: 'mlb-positive-ev-reader',
    deviceId: String(deviceId || '').slice(0, 100),
    deviceName: String(deviceName || '').slice(0, 100),
    iat: now,
    exp: now + Math.max(3600, Math.min(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, DEFAULT_TTL_SECONDS)),
  };
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(payload.deviceId)) throw new Error('Reader device id is invalid');
  const body = b64urlEncode(JSON.stringify(payload));
  return `${TOKEN_VERSION}.${body}.${await hmac(`${TOKEN_VERSION}.${body}`)}`;
}

export async function verifyReaderToken(token) {
  if (!readerPairingConfigured() || !token) return null;
  const [version, body, signature] = String(token).split('.');
  if (version !== TOKEN_VERSION || !body || !signature) return null;
  const expected = await hmac(`${version}.${body}`);
  if (!constantTimeEqual(signature, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); }
  catch { return null; }
  if (payload?.v !== TOKEN_VERSION || payload?.aud !== 'mlb-positive-ev-reader') return null;
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(String(payload.deviceId || ''))) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function bearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function readerOriginAllowed(request) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return true;
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)
    || origin === 'https://mlb-positive-ev.vercel.app';
}

export function readerCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const allowed = readerOriginAllowed(request);
  return {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Reader-Version,X-Device-Id',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
}
