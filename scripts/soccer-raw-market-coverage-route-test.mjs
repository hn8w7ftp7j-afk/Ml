import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextResponse } from 'next/server.js';
import * as coverage from '../lib/soccer/raw-market-coverage.js';
import { createSessionToken, requireApiAuth, validateSameOrigin, originErrorResponse, rateLimitResponse } from '../lib/security.js';

const original = Object.fromEntries(['APP_PASSWORD', 'SESSION_SECRET'].map(key => [key, process.env[key]]));
Object.assign(process.env, { APP_PASSWORD: 'isolated-witness-route-password', SESSION_SECRET: 'isolated-witness-route-secret-abcdefghijklmnopqrstuvwxyz' });
const token = await createSessionToken(), expired = await createSessionToken(-1);
const producer = JSON.parse(readFileSync(join(tmpdir(), 'raw-market-coverage-contract-fixtures.json')));
let report = producer.cases.find(entry => entry.name === 'all-four-source-witnesses').body;
let calls = [], rates = [], blocked = false, sourceError = null;
const source = readFileSync(new URL('../app/api/soccer/raw-market-coverage/route.js', import.meta.url), 'utf8');
const pattern = /^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?\s*$/gm;
const imports = [...source.matchAll(pattern)].flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean));
const services = { ...coverage, NextResponse, requireApiAuth, validateSameOrigin, originErrorResponse, rateLimitResponse,
  checkRateLimit: (_request, options) => { rates.push(options); return { allowed: !blocked, retryAfter: 7 }; },
  readRawMarketCoverage: async input => { calls.push(input); if (sourceError) throw sourceError; return structuredClone(report); } };
for (const name of imports) assert.ok(Object.hasOwn(services, name), `unmocked ${name}`);
const { GET } = new Function(...imports, source.replace(pattern, '').replace(/^export /gm, '') + ';return {GET};')(...imports.map(name => services[name]));
assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/);
const request = (query = '?league=EPL&date=2026-11-07', { cookie = token, headers = {} } = {}) => new Request(`https://fixture.invalid/api/soccer/raw-market-coverage${query}`,
  { headers: { ...(cookie ? { cookie: `mlb_session=${cookie}` } : {}), ...headers } });
async function rejected(req, status) { const before = calls.length, response = await GET(req); assert.equal(response.status, status); assert.equal(calls.length, before); return response; }
try {
  for (const cookie of [false, expired, 'forged.invalid']) await rejected(request(undefined, { cookie }), 401);
  delete process.env.SESSION_SECRET; await rejected(request(), 503); process.env.SESSION_SECRET = 'isolated-witness-route-secret-abcdefghijklmnopqrstuvwxyz';
  for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'malformed' }]) await rejected(request(undefined, { headers }), 403);
  for (const query of ['', '?league=NBA&date=2026-11-07', '?league=EPL&date=2026-02-30', '?league=EPL&league=UCL&date=2026-11-07',
    '?league=EPL&date=2026-11-07&limit=9000', '?league=EPL&date=2026-11-07&maxSourceBytes=999999999', '?league=EPL&date=2026-11-07&date=2026-11-08',
    '?league=%27%20OR%201=1--&date=2026-11-07']) await rejected(request(query), 400);
  blocked = true; const rate = await rejected(request(), 429); assert.equal(rate.headers.get('retry-after'), '7'); blocked = false;
  calls = []; rates = []; const response = await GET(request('?league=epl&date=2026-11-07', { headers: { origin: 'https://fixture.invalid', 'sec-fetch-site': 'same-origin' } }));
  assert.equal(response.status, 200); assert.deepEqual(calls, [{ league: 'EPL', date: '2026-11-07' }]);
  assert.match(response.headers.get('cache-control'), /private.*no-store/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(rates[0].limit, 30); assert.equal(rates[0].windowMs, 600000); assert.deepEqual(await response.json(), report, 'actual producer witness/provenance preserved');
  report = producer.cases.find(entry => entry.name === 'corrupt-source-hash').body;
  const unknown = await GET(request()); assert.equal(unknown.status, 200); const unknownBody = await unknown.json();
  assert.equal(unknownBody.games[0].cells['FT:TOTAL'].status, 'NOT_CHECKED'); assert.deepEqual(unknownBody.sources[0].fragments, []);
  report = producer.cases.find(entry => entry.name === 'real-oversized-index-metadata').body;
  const unavailable = await GET(request()); assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).inventory, null);
  sourceError = Error('private database password must not appear'); const failed = await GET(request()); assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /password|private database/);
  console.log('PASS raw-market coverage API: actual source producer, auth/session/origin/rate, strict league/date query, private no-store, readonly methods, unknown-vs-zero and no source privilege promotion');
} finally { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
