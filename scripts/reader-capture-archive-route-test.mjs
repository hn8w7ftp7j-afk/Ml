// Exercise the actual route with real authorization, body validation, archive
// validation and PostgreSQL. Only the database transport and rate clock are
// local fixture dependencies; there are no network or Production writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { NextResponse } from 'next/server.js';
import * as auth from '../lib/reader-auth-v2.js';
import * as security from '../lib/security.js';
import { canonicalReaderPayload } from '../reader/parser.js';
import { saveReaderCaptureArchive, listReaderCaptureArchives } from '../lib/reader-capture-archive.js';

const envNames = ['READER_PAIR_SECRET', 'APP_PASSWORD', 'SESSION_SECRET'];
const before = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
Object.assign(process.env, { READER_PAIR_SECRET: 'archive-route-fixture-reader',
  APP_PASSWORD: 'archive-route-fixture-site', SESSION_SECRET: 'archive-route-fixture-session' });
const db = new PGlite();
const sql = (parts, ...values) => {
  const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = []; for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows);
  return rows;
});
const deviceId = 'archive-route-fixture-device';
const readerVersion = '2.1.48';
const token = await auth.createReaderToken({ deviceId });
const session = await security.createSessionToken();
let failedDatabase = false, limited = false;
const calls = [];
const deps = { NextResponse, ...auth, ...security,
  checkRateLimit: (...args) => limited ? { allowed: false } : security.checkRateLimit(...args),
  saveReaderCaptureArchive: async (body, options) => {
    calls.push('save');
    if (failedDatabase) throw Error('synthetic private database connection detail');
    return saveReaderCaptureArchive(body, { ...options, sql });
  },
  listReaderCaptureArchives: async () => {
    calls.push('list');
    if (failedDatabase) throw Error('synthetic private database connection detail');
    return listReaderCaptureArchives({ sql });
  },
  console: { warn() {} },
};
const source = readFileSync(new URL('../app/api/reader/archive/route.js', import.meta.url), 'utf8')
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '').replace(/^export\s+/gm, '');
const route = new Function(...Object.keys(deps), `${source}\nreturn {POST,GET,OPTIONS};`)(...Object.values(deps));
function body() {
  const observedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const payload = { version: 'TAI888-READER-DOM-v2.1.0', readerVersion, league: 'MLB',
    sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/?account=private#/BS',
    boardDate: observedAt.slice(0, 10), observedAt, pageActivityAt: observedAt,
    expectedGameCount: 1, detectedGameCount: 1, parseIssues: [], deviceId,
    games: [{ awayCode: 'ATH', homeCode: 'KC', boardDate: observedAt.slice(0, 10), boardTime: '08:00',
      marketStatus: 'open', fullRunline: null, fullTotal: { line: '8+50', overWater: 0.95, underWater: 0.94 },
      first5Runline: null, first5Total: null }] };
  payload.payloadHash = createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
  return { schema: 'READER-CAPTURE-ARCHIVE-v1', payload };
}
const good = body();
let address = 0;
const request = (method, value, headers = {}, query = '') => new Request(`https://fixture.invalid/api/reader/archive${query}`, {
  method, headers: { Origin: `chrome-extension://${'a'.repeat(32)}`, 'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'x-reader-version': readerVersion,
    cookie: `mlb_session=${session}`, 'x-forwarded-for': `192.0.2.${++address}`, ...headers },
  ...(method === 'POST' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}),
});
const post = (value = good, headers = {}) => route.POST(request('POST', value, headers));
try {
  assert.equal((await route.OPTIONS(request('OPTIONS'))).status, 204);
  assert.equal((await route.OPTIONS(request('OPTIONS', undefined, { Origin: 'https://evil.invalid' }))).status, 403);
  const earlyChecks = calls.length;
  for (const [headers, status] of [[{ Authorization: '' }, 401], [{ 'x-device-id': 'another-device' }, 401],
    [{ Origin: 'https://evil.invalid' }, 403]]) assert.equal((await post(good, headers)).status, status);
  assert.equal(calls.length, earlyChecks, 'authorization failures never reach storage');
  assert.equal((await post(good, { 'x-reader-version': '2.1.47' })).status, 426);
  const badDevice = structuredClone(good); badDevice.payload.deviceId = 'another-device';
  assert.equal((await post(badDevice)).status, 401);
  const badHash = structuredClone(good); badHash.payload.payloadHash = '0'.repeat(64);
  assert.equal((await post(badHash)).status, 422);
  assert.equal((await post('{ malformed JSON')).status, 400);
  assert.equal((await post('x'.repeat(600_001))).status, 413);
  const savedResponse = await post();
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  assert.equal(saved.durable, true); assert.equal(saved.archiveOnly, true); assert.equal(saved.currentBoardUpdated, false);
  assert.equal(saved.historicalAvailabilityVerified, false); assert.equal(saved.executable, false);
  assert.equal(saved.observedAt, good.payload.observedAt);
  assert.ok(Date.parse(saved.receivedAt) - Date.parse(saved.observedAt) >= 6 * 86_400_000);
  const retry = await (await post()).json();
  assert.equal(retry.receivedAt, saved.receivedAt); assert.equal(retry.persistedAt, saved.persistedAt);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_reader_capture_archive_v1')).rows[0].n, 1);
  const stored = (await db.query('SELECT payload_json FROM sports_reader_capture_archive_v1')).rows[0].payload_json;
  assert.equal(stored.includes('account=private'), false, 'query credentials never enter the archive');
  const getDenied = await route.GET(request('GET', undefined, { cookie: '' })); assert.equal(getDenied.status, 401);
  assert.equal((await route.GET(request('GET', undefined, {}, '?league=MLB'))).status, 400);
  const summaryResponse = await route.GET(request('GET')); assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.leagues.length, 7); assert.equal(summary.leagues.find(row => row.league === 'MLB').captureCount, 1);
  assert.equal(summary.leagues.find(row => row.league === 'UCL').captureCount, 0);
  assert.equal(JSON.stringify(summary).includes(deviceId), false);
  limited = true;
  assert.equal((await post()).status, 429); assert.equal((await route.GET(request('GET'))).status, 429);
  limited = false; failedDatabase = true;
  for (const response of [await post(), await route.GET(request('GET'))]) {
    assert.equal(response.status, 503); const data = await response.json();
    assert.equal(data.ok, false); assert.equal(data.durable, false); assert.equal(data.currentBoardUpdated, false);
    assert.equal(JSON.stringify(data).includes('private database'), false);
    assert.equal(Object.hasOwn(data, 'captureId'), false, 'failed persistence cannot look like an archive acknowledgement');
  }
  assert.equal(savedResponse.headers.get('Access-Control-Allow-Origin'), `chrome-extension://${'a'.repeat(32)}`);
  assert.equal(savedResponse.headers.get('Cache-Control'), 'no-store');
  console.log('PASS Reader archive route: real auth/device/version/origin/body guards, delayed original capture to isolated PostgreSQL, exact readback ACK, idempotence, safe seven-league summary, no-store CORS and blocked write/error receipts; Production NOT VERIFIED');
} finally {
  for (const key of envNames) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  await db.close();
}
