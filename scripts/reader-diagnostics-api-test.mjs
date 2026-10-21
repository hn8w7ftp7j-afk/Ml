import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { POST, GET, OPTIONS } from '../app/api/reader/diagnostics/route.js';
import { createReaderToken } from '../lib/reader-auth-v2.js';
import { createSessionToken } from '../lib/security.js';
import { DIAGNOSTIC_SCHEMA } from '../reader/diagnostic-schema.js';
process.env.APP_PASSWORD = 'test-only-password';
process.env.SESSION_SECRET = 'test-only-site-secret';
process.env.READER_PAIR_SECRET = 'test-only-reader-secret';
for (const key of ['DATABASE_V2_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const deviceId = 'diagnostic-device-123456';
const token = await createReaderToken({ deviceId });
const siteToken = await createSessionToken();
const report = { schema: DIAGNOSTIC_SCHEMA, reportId: randomUUID(), readerVersion: '2.1.42', createdAt: new Date().toISOString(), leagues: { NBA: { state: 'error' } } };
const origin = `chrome-extension://${'a'.repeat(32)}`;
const request = (method, headers = {}, body = report, suffix = '') => new Request(`https://mlb-positive-ev.vercel.app/api/reader/diagnostics${suffix}`, {
  method, headers: { origin, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const readerHeaders = { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId };
assert.equal((await OPTIONS(request('OPTIONS'))).status, 204);
assert.equal((await OPTIONS(request('OPTIONS', { origin: 'https://attacker.invalid' }))).status, 403);
assert.equal((await POST(request('POST'))).status, 401);
assert.equal((await POST(request('POST', { ...readerHeaders, origin: 'https://attacker.invalid' }))).status, 403);
assert.equal((await POST(request('POST', { ...readerHeaders, 'X-Device-Id': 'other-device-1234' }))).status, 403);
assert.equal((await POST(request('POST', { ...readerHeaders, Authorization: `Bearer ${token}forged` }))).status, 401);
assert.equal((await POST(request('POST', readerHeaders, '{bad json'))).status, 400);
assert.equal((await POST(request('POST', readerHeaders, { ...report, reportId: 'invalid' }))).status, 400);
assert.equal((await POST(request('POST', readerHeaders, { ...report, arbitrary: 'x'.repeat(49152) }))).status, 413);
const unavailable = await POST(request('POST', readerHeaders));
assert.equal(unavailable.status, 503, 'unavailable persistence must never return a success receipt');
assert.equal((await unavailable.json()).ok, false);
assert.equal((await GET(request('GET', readerHeaders))).status, 401, 'extension tokens cannot read device reports');
const siteHeaders = { Cookie: `mlb_session=${siteToken}` };
assert.equal((await GET(request('GET', siteHeaders, null, '?league=NBA&deviceId=bad'))).status, 400);
assert.equal((await GET(request('GET', siteHeaders, null, '?league=NFL'))).status, 400);
assert.equal((await GET(request('GET', siteHeaders, null, '?league=NBA'))).status, 503, 'authenticated reads fail explicitly when DB is unavailable');
console.log('Reader diagnostic API: signed device binding, login-only reads, forged tokens, origins, body limits and honest DB failure PASS');
