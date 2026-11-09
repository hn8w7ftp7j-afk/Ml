import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server.js';
import * as security from '../lib/security.js';
import { createReaderToken } from '../lib/reader-auth-v2.js';
import * as history from '../lib/reader-legacy-history.js';

const envKeys = ['APP_PASSWORD', 'SESSION_SECRET', 'READER_PAIR_SECRET'];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, { APP_PASSWORD: 'legacy-history-test-only', SESSION_SECRET: 'legacy-history-test-session-only',
  READER_PAIR_SECRET: 'legacy-history-test-reader-only' });
const token = await security.createSessionToken(), expired = await security.createSessionToken(-1);
const pairedReader = await createReaderToken({ deviceId: 'legacy-reader-route-device' });
const source = readFileSync(new URL('../app/api/reader/legacy-history/route.js', import.meta.url), 'utf8');
const imports = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"];?\s*$/gm)]
  .flatMap(match => match[1].split(',').map(name => name.trim()).filter(Boolean));
let calls = [], rateOptions = [], blocked = false, problem = null;
let result = { ok: true, schema: history.READER_LEGACY_HISTORY_SCHEMA, ...history.READER_LEGACY_HISTORY_FLAGS,
  status: 'NO_RETAINED_ROWS', count: 0, records: [] };
const deps = { NextResponse, ...security, ...history,
  checkRateLimit: (_request, options) => { rateOptions.push(options); return { allowed: !blocked, retryAfter: 7 }; },
  readReaderLegacyHistory: async query => { calls.push(query); if (problem) throw problem; return result; },
};
for (const name of imports) assert.ok(Object.hasOwn(deps, name), `missing route dependency ${name}`);
const body = source.replace(/^import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '').replace(/^export /gm, '');
const { GET } = new Function(...imports, `${body}; return { GET };`)(...imports.map(name => deps[name]));
const query = '?league=MLB&from=2026-11-01&through=2026-11-30';
function request(options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.cookie !== false) headers.set('cookie', `mlb_session=${options.cookie || token}`);
  return new Request(`https://fixture.invalid/api/reader/legacy-history${options.query ?? query}`, { headers });
}
async function reject(options, status) {
  const before = calls.length, response = await GET(request(options));
  assert.equal(response.status, status); assert.equal(calls.length, before, 'rejection must precede historical storage access');
  return response;
}
function assertPrivate(response) {
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}
try {
  for (const cookie of [false, expired, 'invalid.invalid']) await reject({ cookie }, 401);
  await reject({ cookie: false, headers: { authorization: `Bearer ${pairedReader}` } }, 401,
    'a valid Reader pairing never grants forensic read access');
  delete process.env.SESSION_SECRET; await reject({}, 503); process.env.SESSION_SECRET = 'legacy-history-test-session-only';
  for (const headers of [{ origin: 'https://foreign.invalid' }, { origin: 'not a URL' }, { 'sec-fetch-site': 'cross-site' }]) {
    await reject({ headers }, 403);
  }
  for (const bad of ['', '?league=NBA&from=2026-11-01&through=2026-11-30',
    '?league=KBO&from=2026-11-01&through=2026-11-30', '?league=MLB&from=2026-11-30&through=2026-11-01',
    '?league=MLB&from=2026-10-01&through=2026-11-01', '?league=MLB&from=2026-02-30&through=2026-03-01',
    '?league=MLB&league=NPB&from=2026-11-01&through=2026-11-30', `${query}&unknown=true`, `${query}&__proto__=polluted`,
    '?view=detail&league=MLB&date=2026-11-01&date=2026-11-02', '?view=detail&league=MLB&date=2026-11-01&from=2026-11-01',
    '?view=constructor&league=MLB&date=2026-11-01', '?view=detail&league=MLB&date=2026-11-01%27%20OR%20true']) {
    const response = await reject({ query: bad }, 400), value = await response.json();
    assertPrivate(response); assert.equal(value.status, 'NOT_VERIFIED'); assert.equal(value.count, null);
  }
  blocked = true;
  const limited = await reject({}, 429); assert.equal(limited.headers.get('retry-after'), '7'); blocked = false;
  let response = await GET(request()); assert.equal(response.status, 200); assertPrivate(response);
  assert.deepEqual(calls.at(-1), { view: 'inventory', league: 'MLB', from: '2026-11-01', through: '2026-11-30' });
  let value = await response.json(); assert.equal(value.count, 0); assert.equal(value.status, 'NO_RETAINED_ROWS');
  assert.equal(value.coverageComplete, false); assert.equal(value.firstObservedAtVerified, false);
  assert.equal(rateOptions.at(-1).limit, 60); assert.equal(rateOptions.at(-1).windowMs, 600000);
  for (const league of ['MLB', 'NPB', 'CPBL']) {
    await GET(request({ query: `?view=detail&league=${league}&date=2026-11-01` }));
    assert.deepEqual(calls.at(-1), { view: 'detail', league, date: '2026-11-01' });
  }
  for (const [code, status] of [['LEGACY_READER_TABLE_NOT_PRESENT', 503], ['LEGACY_READER_CHECKSUM_INVALID', 409],
    ['LEGACY_READER_PAYLOAD_LIMIT_EXCEEDED', 413], ['LEGACY_READER_SOURCE_CHANGED', 409],
    ['raw-untrusted-database-message', 503]]) {
    problem = Object.assign(Error('private-connection-credential-detail'), { code, status });
    response = await GET(request()); assert.equal(response.status, status); assertPrivate(response);
    value = await response.json(); assert.equal(value.count, null); assert.equal(value.status, 'NOT_VERIFIED');
    for (const [key, expected] of Object.entries(history.READER_LEGACY_HISTORY_FLAGS)) assert.equal(value[key], expected);
    const serialized = JSON.stringify(value); assert.doesNotMatch(serialized, /private-connection|credential-detail|raw-untrusted/);
  }
  problem = null;
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:POST|PATCH|DELETE|PUT)|verifyReaderToken|bearerToken|storeReader|persist/);
} finally {
  for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
}
console.log('PASS legacy cache audit route: real site-session-only auth, paired Reader cannot read, same-origin/rate/date/league/query boundaries, read-only exact scopes, valid empty versus unknown, integrity/size/storage failures sanitized and private no-store; NOT Production');
