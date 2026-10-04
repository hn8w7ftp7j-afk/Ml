// Synthetic Reader observations exercise intake boundaries without contacting
// Tai888, ESPN, a production database or a production cache.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { canonicalReaderPayload } from '../reader/parser.js';
import { resolveNbaReaderTeam } from '../lib/nba/reader-teams.js';
import { normalizeNbaReaderPayload, nbaReaderPublicView, assertNbaReaderMonotonic } from '../lib/nba/reader.js';
import { loadNbaReaderSnapshot, storeNbaReaderSnapshot } from '../lib/nba/reader-store.js';
import { LEAGUE_IDS } from '../lib/leagues.js';
import { createReaderToken } from '../lib/reader-auth-v2.js';
import { createSessionToken } from '../lib/security.js';

register('./next-route-test-loader.mjs', import.meta.url);
const { GET, POST, OPTIONS } = await import('../app/api/nba/reader/route.js');
const now = Date.now(); const deviceId = 'nba-reader-fixture-device';
const previousEnv = Object.fromEntries(['READER_PAIR_SECRET', 'READER_STORE_MEMORY_ONLY', 'APP_PASSWORD', 'SESSION_SECRET', 'VERCEL', 'DATABASE_V2_URL', 'DATABASE_URL'].map(key => [key, process.env[key]]));
delete process.env.VERCEL;
process.env.READER_PAIR_SECRET = 'nba-reader-synthetic-pair-secret';
process.env.READER_STORE_MEMORY_ONLY = 'true';
process.env.APP_PASSWORD = 'nba-reader-synthetic-site-password';
process.env.SESSION_SECRET = 'nba-reader-synthetic-session-secret';
const readerToken = await createReaderToken({ deviceId }); const cookie = `mlb_session=${await createSessionToken()}`;
const boardDate = new Date(now + 86_400_000).toISOString().slice(0, 10);
const laterBoardDate = new Date(now + 172_800_000).toISOString().slice(0, 10);
let checks = 0;
const test = async (name, action) => { await action(); checks++; console.log(`PASS ${name}`); };
function game(overrides = {}) {
  return { awayCode: 'GSW', homeCode: 'LAL', boardDate, boardTime: '07:00', marketStatus: 'open',
    fullRunline: { lineSide: 'away', line: '7+90', awayWater: 0.95, homeWater: 0.96, privateRows: ['must-not-leak-raw'] },
    fullTotal: { line: '220+50', overWater: 0.93, underWater: 0.94 },
    firstHalfRunline: { lineSide: 'home', line: '3-20', awayWater: 0.92, homeWater: 0.91 },
    firstHalfTotal: { line: '110-20', overWater: 0.9, underWater: 0.9 },
    marketStates: { fullRunline: 'AVAILABLE', fullTotal: 'AVAILABLE', firstHalfRunline: 'AVAILABLE', firstHalfTotal: 'AVAILABLE' },
    accountData: 'must-not-leak-account', ...overrides };
}
function payload(overrides = {}) {
  const value = { version: 'TAI888-READER-DOM-v2.2.0', readerVersion: '2.1.27', league: 'NBA', deviceId,
    sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BB', boardDate,
    observedAt: new Date(now - 1000).toISOString(), pageActivityAt: new Date(now - 1500).toISOString(),
    expectedGameCount: 1, detectedGameCount: 1, games: [game()], parseIssues: [],
    accountToken: 'must-not-leak-top-level', ...overrides };
  value.payloadHash = createHash('sha256').update(canonicalReaderPayload(value)).digest('hex');
  return value;
}
const normalize = body => normalizeNbaReaderPayload(body, { now, deviceId, headerVersion: body.readerVersion });
function rejects(body, code) { assert.throws(() => normalize(body), error => error.code === code, code); }
let requestCount = 0;
function request(body, headers = {}, query = '') {
  const defaults = body ? { Authorization: `Bearer ${readerToken}`, 'Content-Type': 'application/json', 'X-Device-Id': deviceId, 'X-Reader-Version': '2.1.27' } : { cookie };
  return new Request(`https://mlb-positive-ev.vercel.app/api/nba/reader${query ? `?${query}` : ''}`, {
    method: body ? 'POST' : 'GET', headers: { ...defaults, 'X-Forwarded-For': `192.0.2.${++requestCount}`, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

try {
  await test('NBA aliases map provider IDs and remain isolated from baseball', () => {
    for (const [alias, canonical] of [['GSW', 'GS'], ['NYK', 'NY'], ['NOP', 'NO'], ['SAS', 'SA'], ['UTA', 'UTAH'], ['WAS', 'WSH'], ['PHO', 'PHX'], ['BRK', 'BKN']]) assert.equal(resolveNbaReaderTeam(alias).id, resolveNbaReaderTeam(canonical).id);
    assert.equal(resolveNbaReaderTeam('BOS').id, 'nba:espn:team:2');
    assert.equal(resolveNbaReaderTeam('NYY'), null); assert.equal(LEAGUE_IDS.includes('NBA'), false);
    const snapshot = normalize(payload());
    assert.equal(snapshot.games[0].away.abbreviation, 'GS'); assert.equal(snapshot.games[0].awayCode, 'GSW');
    assert.equal(snapshot.games[0].away.id, 'nba:espn:team:9'); assert.equal(snapshot.games[0].home.id, 'nba:espn:team:13');
    rejects(payload({ league: 'MLB' }), 'NBA_READER_LEAGUE_INVALID');
    rejects(payload({ games: [game({ awayCode: 'NYY' })] }), 'NBA_READER_TEAM_INVALID');
    rejects(payload({ games: [game({ awayCode: 'GSW', homeCode: 'GS' })] }), 'NBA_READER_TEAM_INVALID');
  });
  await test('NBA full game and first half preserve ownership without baseball limits', () => {
    const snapshot = normalize(payload()); const row = snapshot.games[0];
    assert.equal(row.fullRunline.line, '7+90'); assert.equal(row.fullRunline.lineSide, 'away');
    assert.equal(row.fullTotal.line, '220+50'); assert.equal(row.firstHalfRunline.lineSide, 'home');
    assert.equal(row.firstHalfTotal.line, '110-20'); assert.equal(snapshot.marketCount, 4);
    assert.equal(Object.hasOwn(row, 'first5Runline'), false); assert.equal(Object.hasOwn(row, 'first5Total'), false);
    rejects(payload({ games: [game({ first5Runline: null })] }), 'NBA_READER_PERIOD_INVALID');
  });
  await test('missing half markets remain partial; unreadable and locked states fail closed', () => {
    const partial = game({ firstHalfRunline: null, firstHalfTotal: null,
      marketStates: { fullRunline: 'AVAILABLE', fullTotal: 'AVAILABLE', firstHalfRunline: 'UNAVAILABLE', firstHalfTotal: 'UNAVAILABLE' } });
    const snapshot = normalize(payload({ games: [partial] })); assert.equal(snapshot.marketCount, 2);
    assert.equal(snapshot.games[0].firstHalfTotal, null); assert.equal(snapshot.executable, false);
    rejects(payload({ games: [game({ firstHalfRunline: null, marketStates: { ...game().marketStates, firstHalfRunline: 'BLOCKED' } })] }), 'NBA_READER_MARKET_BLOCKED');
    rejects(payload({ games: [game({ marketStatus: 'locked' })] }), 'NBA_READER_MARKET_INVALID');
    const locked = game({ marketStatus: 'locked', fullRunline: null, fullTotal: null, firstHalfRunline: null, firstHalfTotal: null,
      marketStates: Object.fromEntries(Object.keys(game().marketStates).map(key => [key, 'UNAVAILABLE'])) });
    assert.equal(normalize(payload({ games: [locked] })).marketCount, 0);
  });
  await test('canonical digest covers NBA half markets and detects tampering', () => {
    const tampered = payload(); tampered.games[0].firstHalfTotal.line = '111-20';
    rejects(tampered, 'NBA_READER_HASH_INVALID');
    const missingHash = payload(); delete missingHash.payloadHash; rejects(missingHash, 'NBA_READER_HASH_INVALID');
    const unknownState = payload({ games: [game({ marketStates: { ...game().marketStates, first5Total: 'AVAILABLE' } })] });
    rejects(unknownState, 'NBA_READER_MARKET_INVALID');
  });
  await test('source, version, device, counts, identity duplicates and time are validated', () => {
    rejects(payload({ sourceHost: 'tai888.in.evil.test', pageUrl: 'https://tai888.in.evil.test/' }), 'NBA_READER_SOURCE_INVALID');
    rejects(payload({ pageUrl: 'http://www1.tai888.in/' }), 'NBA_READER_SOURCE_INVALID');
    rejects(payload({ readerVersion: '2.1.26' }), 'NBA_READER_VERSION_UNSUPPORTED');
    rejects(payload({ version: 'TAI888-READER-DOM-v2.1.0' }), 'NBA_READER_VERSION_UNSUPPORTED');
    rejects(payload({ deviceId: 'another-device' }), 'NBA_READER_DEVICE_INVALID');
    rejects(payload({ detectedGameCount: 2 }), 'NBA_READER_COUNT_INVALID');
    rejects(payload({ boardDate: '2026-02-30' }), 'NBA_READER_DATE_INVALID');
    rejects(payload({ observedAt: '2026-02-30T00:00:00Z' }), 'NBA_READER_TIME_INVALID');
    rejects(payload({ observedAt: `${boardDate}T24:00:00Z` }), 'NBA_READER_TIME_INVALID');
    rejects(payload({ observedAt: new Date(now + 120000).toISOString() }), 'NBA_READER_OBSERVATION_EXPIRED');
    rejects(payload({ pageActivityAt: new Date(now + 6000).toISOString() }), 'NBA_READER_ACTIVITY_EXPIRED');
    rejects(payload({ observedAt: new Date(now - 601000).toISOString() }), 'NBA_READER_OBSERVATION_EXPIRED');
    rejects(payload({ pageActivityAt: new Date(now - 181000).toISOString() }), 'NBA_READER_ACTIVITY_EXPIRED');
    rejects(payload({ games: [game(), game({ awayCode: 'GS' })], detectedGameCount: 2, expectedGameCount: 2 }), 'NBA_READER_DUPLICATE_GAME');
    rejects(payload({ parseIssues: ['conflicting-game'] }), 'NBA_READER_PARSE_CONFLICT');
  });
  await test('snapshots are allowlisted; future board dates retain current source observation', () => {
    const snapshot = normalize(payload()); const text = JSON.stringify(snapshot);
    for (const secret of ['must-not-leak-raw', 'must-not-leak-account', 'must-not-leak-top-level']) assert.equal(text.includes(secret), false);
    assert.equal(snapshot.boardDate, boardDate); assert.equal(nbaReaderPublicView(snapshot, { now }).status, 'fresh');
    assert.equal(nbaReaderPublicView(snapshot, { now: now + 181000 }).status, 'stale');
    assert.equal(nbaReaderPublicView(null, { boardDate }).status, 'waiting');
    const publicView = nbaReaderPublicView(snapshot, { now });
    for (const key of ['deviceId', 'pageUrl', 'clientPayloadHash']) assert.equal(Object.hasOwn(publicView, key), false);
  });
  await test('replay rejection permits a later identical observation and preserves old snapshot', async () => {
    const snapshot = normalize(payload()); const storage = await storeNbaReaderSnapshot(snapshot, { runtimeCache: null });
    assert.deepEqual(storage, { runtimeCache: false, storage: 'process_memory', durable: false });
    assert.equal((await loadNbaReaderSnapshot(boardDate, { runtimeCache: null })).league, 'NBA');
    await assert.rejects(storeNbaReaderSnapshot(snapshot, { runtimeCache: null }), error => error.code === 'NBA_READER_REPLAY');
    assert.equal((await loadNbaReaderSnapshot(boardDate, { runtimeCache: null })).observedAt, snapshot.observedAt);
    const fresh = { ...snapshot, observedAt: new Date(now - 500).toISOString(), pageActivityAt: new Date(now - 750).toISOString() };
    assert.doesNotThrow(() => assertNbaReaderMonotonic(snapshot, fresh));
    await storeNbaReaderSnapshot(fresh, { runtimeCache: null });
  });
  await test('Production never falls back to memory or Runtime Cache when database is missing', async () => {
    process.env.VERCEL = '1'; delete process.env.DATABASE_V2_URL; delete process.env.DATABASE_URL;
    try {
      const snapshot = normalize(payload({ boardDate: laterBoardDate, games: [game({ boardDate: laterBoardDate })] }));
      await assert.rejects(loadNbaReaderSnapshot(boardDate), error => error.code === 'NBA_READER_DATABASE_UNAVAILABLE');
      await assert.rejects(storeNbaReaderSnapshot(snapshot), error => error.code === 'NBA_READER_DATABASE_UNAVAILABLE');
      const result = await GET(request(null, {}, `date=${boardDate}`)); assert.equal(result.status, 503);
      assert.equal((await result.json()).ok, false);
    } finally {
      delete process.env.VERCEL;
      for (const key of ['DATABASE_V2_URL', 'DATABASE_URL']) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
    }
  });
  await test('route requires Reader token/device/CORS POST and site authentication GET', async () => {
    assert.equal((await POST(request(payload(), { Authorization: '' }))).status, 401);
    assert.equal((await POST(request(payload(), { 'X-Device-Id': 'wrong-device' }))).status, 401);
    assert.equal((await POST(request(payload(), { 'X-Reader-Version': '' }))).status, 426);
    assert.equal((await POST(request(payload(), { Origin: 'https://evil.test' }))).status, 403);
    assert.equal((await GET(request(null, { cookie: '' }))).status, 401);
    assert.equal((await GET(request(null, { cookie: '', Authorization: `Bearer ${readerToken}` }))).status, 401);
    assert.equal((await GET(request(null, {}, 'date=2026-02-30'))).status, 400);
    assert.equal((await GET(request(null, {}, 'league=MLB'))).status, 400);
    assert.equal((await OPTIONS(new Request('https://mlb-positive-ev.vercel.app/api/nba/reader', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }))).status, 204);
  });
  await test('route POST/GET exposes actual stored markets; replay does not overwrite', async () => {
    const body = payload({ observedAt: new Date(now).toISOString(), pageActivityAt: new Date(now - 100).toISOString() });
    const posted = await POST(request(body)); const receipt = await posted.json();
    assert.equal(posted.status, 200, receipt.error); assert.equal(receipt.gameCount, 1); assert.equal(receipt.marketCount, 4);
    assert.equal(receipt.executable, false); assert.equal(receipt.durable, false); assert.equal(receipt.matchedGameCount, 0);
    assert.equal((await POST(request(body))).status, 409);
    const response = await GET(request(null, {}, `date=${boardDate}`)); const view = await response.json();
    assert.equal(response.status, 200, view.error); assert.equal(view.league, 'NBA'); assert.equal(view.status, 'fresh');
    assert.equal(view.games[0].firstHalfTotal.line, '110-20'); assert.equal(view.games[0].identityStatus, 'team_mapped_game_unverified');
    assert.equal(Object.hasOwn(view, 'deviceId'), false); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
  console.log(`NBA Reader intake/store/API: ${checks} checks passed.`);
} finally {
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
