import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalReaderPayload } from '../reader/parser.js';
import { createReaderToken } from '../lib/reader-auth-v2.js';
import { createSessionToken } from '../lib/security.js';

// Runs only against an explicitly supplied local Production build configured
// with the same test secrets and READER_STORE_MEMORY_ONLY=true. Synthetic
// prices must never be sent to the user's Production database.
const origin = process.env.NBA_READER_TEST_ORIGIN;
assert.match(origin || '', /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.equal(process.env.READER_STORE_MEMORY_ONLY, 'true');
assert.ok(process.env.SESSION_SECRET && process.env.READER_PAIR_SECRET);
const date = '2026-10-05';
const deviceId = 'nba-local-http-test';
const token = await createReaderToken({ deviceId });
const cookie = `mlb_session=${await createSessionToken()}`;
const request = (path, options = {}) => fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(20_000) });
const post = body => request('/api/nba/reader', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId,
    'X-Reader-Version': '2.1.28', Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, body: JSON.stringify(body),
});
const now = Date.now();
function payload(overrides = {}) {
  const result = { league: 'NBA', version: 'TAI888-READER-DOM-v2.2.0', readerVersion: '2.1.28', deviceId,
    sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/', boardDate: date,
    observedAt: new Date(now).toISOString(), pageActivityAt: new Date(now).toISOString(),
    expectedGameCount: 1, detectedGameCount: 1, parseIssues: [], games: [{
      awayCode: 'BOS', homeCode: 'CLE', boardDate: date, boardTime: '07:00', marketStatus: 'open',
      fullRunline: { lineSide: 'home', line: '6+50', awayWater: .95, homeWater: .94 },
      fullTotal: { line: '220+50', overWater: .96, underWater: .93 },
      firstHalfRunline: { lineSide: 'home', line: '3平', awayWater: .92, homeWater: .97 },
      firstHalfTotal: { line: '110-20', overWater: .91, underWater: .98 },
    }], ...overrides };
  result.payloadHash = createHash('sha256').update(canonicalReaderPayload(result)).digest('hex');
  return result;
}
assert.equal((await request(`/api/nba/reader?date=${date}`)).status, 401, 'private GET must remain authenticated');
assert.equal((await request('/api/nba/reader', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'unpaired POST must fail');
const body = payload();
let response = await post(body); let result = await response.json();
assert.equal(response.status, 200, JSON.stringify(result));
assert.equal(result.gameCount, 1); assert.equal(result.marketCount, 4); assert.equal(result.durable, false);
assert.equal(result.storage, 'process_memory');
response = await request(`/api/nba/reader?date=${date}`, { headers: { Cookie: cookie } }); result = await response.json();
assert.equal(response.status, 200, JSON.stringify(result));
assert.equal(result.league, 'NBA'); assert.equal(result.games[0].fullTotal.line, '220+50');
assert.equal(result.games[0].firstHalfTotal.line, '110-20');
assert.equal(Object.hasOwn(result.games[0], 'first5Total'), false);
assert.equal(result.status, 'fresh');
assert.equal((await post(body)).status, 409, 'replay must not overwrite');
assert.equal((await post(payload({ league: 'MLB' }))).status, 400, 'NBA endpoint must reject baseball');
response = await request(`/api/nba/reader?date=${date}`, { headers: { Cookie: cookie } }); result = await response.json();
assert.equal(result.games[0].firstHalfTotal.line, '110-20');
console.log('NBA Reader local HTTP Production-build flow: middleware, token auth, CORS POST, private GET, prices, first half, replay and isolation PASS (synthetic local data only)');
