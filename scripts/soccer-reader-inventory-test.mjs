import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerReaderHash } from '../lib/soccer/reader.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { shiftSoccerDate } from '../lib/soccer/contracts.js';

const fixture = await soccerSqlFixture(), { db } = fixture;
const keys = ['DATABASE_URL', 'DATABASE_V2_URL', 'APP_PASSWORD', 'SESSION_SECRET'];
const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/reader-inventory'; delete process.env.DATABASE_V2_URL;
process.env.APP_PASSWORD = 'inventory-engineering-fixture'; process.env.SESSION_SECRET = 'inventory-engineering-session';
const originalFetch = globalThis.fetch; let external = 0;
globalThis.fetch = async () => { external++; throw Error('inventory must remain a read-only database operation'); };
try {
  const { saveSoccerReaderSnapshot: save, loadSoccerReaderSnapshot: load } = await import('../lib/soccer/reader-store.js');
  const { normalizeSoccerReaderInventoryQuery: normalize, readSoccerReaderInventory: inventory } = await import('../lib/soccer/reader-inventory.js');
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.deepEqual(normalize({ league: 'EPL' }, now), { league: 'epl', from: '2026-09-29', through: '2026-11-12' });
  for (const input of [null, {}, { league: 'nba' }, { league: 'epl', from: '2026-10-25' },
    { league: 'ucl', from: '2026-02-30', through: '2026-03-01' }, { league: 'epl', from: '2026-10-26', through: '2026-10-25' },
    { league: 'epl', from: '2025-01-01', through: '2026-10-25' }, { league: 'epl', fresh: true }]) assert.throws(() => normalize(input, now), error => error.status === 400);
  const range = { league: 'epl', from: '2026-09-01', through: '2026-11-01' };
  let report = await inventory(range); assert.equal(report.summary.observationCount, 0); assert.equal(report.summary.distinctBoardGameKeys, 0);
  assert.equal(report.summary.gameKeysComplete, true); assert.deepEqual(report.days, []);
  assert.equal(report.legacy.status, 'ABSENT'); assert.equal(report.legacy.snapshotCount, 0);
  let sequence = 0;
  function payload(date, period, { league = 'EPL', games = 2, locked = false } = {}) {
    const observedAt = new Date(Date.now() - 60000 + sequence++ * 5).toISOString();
    const value = { league, boardDate: date, observedAt, executable: false, periodsCovered: [period],
      deviceId: 'private-device-id-must-not-leave-store', sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/?private=original-page',
      games: Array.from({ length: games }, (_ignored, index) => ({ league, boardDate: date, boardTime: index ? '23:00' : '21:00',
        homeCode: index ? 'ARS' : 'BHA', awayCode: index ? 'LIV' : 'CRY', homeKey: index ? 'arsenal' : 'brighton', awayKey: index ? 'liverpool' : 'crystalpalace',
        homeRaw: index ? '兵工廠[主]' : '白禮頓[主]', awayRaw: index ? '利物浦' : '水晶宮', periodsCovered: [period], periodStates: { [period]: locked ? 'locked' : 'open' },
        markets: locked ? [] : [{ kind: 'TOTAL', unit: 'GOALS', line: index ? '3.5' : '2.5', overWater: .9, underWater: .95, period,
          rawRows: ['private raw original row must not leave inventory'], periodEvidence: { period, status: period === 'UNKNOWN' ? 'UNKNOWN' : 'EXPLICIT', sectionTitle: period } }] })) };
    value.contentHash = soccerReaderHash(canonicalSoccerPayload(value)); return value;
  }
  const ft = payload('2026-10-25', 'FT'), ht = payload('2026-10-25', 'HT', { games: 1 });
  const first = await save(ft); await save(ht); const heartbeat = payload('2026-10-25', 'FT'); await save(heartbeat);
  report = await inventory(range);
  assert.equal(report.summary.observationCount, 3, 'heartbeats are real immutable receipt observations');
  assert.equal(report.summary.distinctBoardGameKeys, 2, 'FT/HT and heartbeats do not become independent games');
  assert.equal(report.days[0].current.gameCount, 2); assert.equal(report.days[0].current.marketCount, 3);
  assert.deepEqual(report.days[0].current.periodCounts.map(row => [row.period, row.gameCount, row.marketCount]), [['FT', 2, 2], ['HT', 1, 1]]);
  assert.equal(report.formalEligible, false); assert.equal(report.executable, false);
  const closed = payload('2026-10-25', 'FT', { games: 0 }); await save(closed);
  await save(payload('2026-10-26', 'UNKNOWN', { games: 1 }));
  await save(payload('2026-10-25', 'FT', { league: 'UCL', games: 1 }));
  report = await inventory(range);
  const oldDay = report.days.find(day => day.date === '2026-10-25');
  assert.equal(oldDay.observationCount, 4); assert.equal(oldDay.distinctBoardGameKeys, 2);
  assert.equal(oldDay.current.gameCount, 1); assert.equal(oldDay.current.marketCount, 1);
  assert.deepEqual(oldDay.current.periodCounts.map(row => [row.period, row.gameCount, row.marketCount]), [['FT', 0, 0], ['HT', 1, 1]]);
  assert.equal((await load('epl', '2026-10-25')).games[0].markets[0].period, 'HT', 'inventory never resurrects FT prices after an explicit empty head');
  assert.deepEqual(report.days.map(day => day.date), ['2026-10-26', '2026-10-25']);
  assert.equal(report.summary.observationCount, 5); assert.equal(report.summary.distinctBoardGameKeys, 3);
  const ucl = await inventory({ ...range, league: 'ucl' });
  assert.equal(ucl.summary.observationCount, 1); assert.equal(ucl.days[0].current.marketCount, 1); assert.equal(ucl.league, 'ucl');
  assert.equal(await load('epl', '2026-10-31'), null);
  assert.ok(report.summary.observationCount > 0, 'a future day without a capture can still show the independent historical inventory');
  const storedBefore = (await db.query('SELECT to_jsonb(h) AS value FROM sports_soccer_reader_period_heads_v2 h ORDER BY league,board_date,period')).rows;
  await inventory(range);
  assert.deepEqual((await db.query('SELECT to_jsonb(h) AS value FROM sports_soccer_reader_period_heads_v2 h ORDER BY league,board_date,period')).rows, storedBefore, 'read-only inventory does not adopt/rewrite any head or source clock');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private-device|private=original-page|private raw|tai888\.in|rawRows|sourceHost|pageUrl|deviceId|fresh/);
  const limitedHistory = await inventory(range, { limits: { historyObservations: 1 } });
  assert.equal(limitedHistory.summary.observationCount, 5); assert.equal(limitedHistory.summary.gameKeysComplete, false); assert.equal(limitedHistory.summary.distinctBoardGameKeys, null);
  const limitedHeads = await inventory(range, { limits: { headBytes: 1 } });
  assert.equal(limitedHeads.days[0].current.status, 'UNAVAILABLE'); assert.equal(limitedHeads.days[0].current.marketCount, null);
  const head = (await db.query("SELECT content_hash FROM sports_soccer_reader_period_heads_v2 WHERE league='epl' AND board_date='2026-10-26' AND period='UNKNOWN'")).rows[0];
  await db.query("UPDATE sports_soccer_reader_period_heads_v2 SET content_hash=$1 WHERE league='epl' AND board_date='2026-10-26' AND period='UNKNOWN'", ['f'.repeat(64)]);
  assert.equal((await inventory(range)).days[0].current.status, 'UNAVAILABLE', 'head/index hash mismatch cannot become a numeric current inventory');
  await db.query("UPDATE sports_soccer_reader_period_heads_v2 SET content_hash=$1 WHERE league='epl' AND board_date='2026-10-26' AND period='UNKNOWN'", [head.content_hash]);
  for (let day = 0; day < 33; day++) await save(payload(shiftSoccerDate('2026-09-01', day), 'FT', { games: 1 }));
  report = await inventory(range);
  assert.equal(report.summary.boardDateCount, 35); assert.equal(report.days.length, 31); assert.equal(report.truncated, true);
  assert.equal(report.summary.observationCount, 38); assert.equal(report.summary.distinctBoardGameKeys, 36);
  assert.equal(report.days[0].date, '2026-10-26'); assert.equal(report.days.at(-1).date, '2026-09-05');
  const oneDay = await inventory({ league: 'epl', from: '2026-10-25', through: '2026-10-25' });
  assert.equal(oneDay.summary.observationCount, 4); assert.equal(oneDay.summary.boardDateCount, 1); assert.equal(oneDay.truncated, false);
  assert.equal(oneDay.summary.distinctBoardGameKeys, oneDay.days.reduce((sum, day) => sum + day.distinctBoardGameKeys, 0));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1', [first.observationId])).rows[0].n, 1);
  await save(payload('2026-11-10', 'FT', { games: 1 }));
  await db.query("DELETE FROM sports_soccer_reader_period_heads_v2 WHERE league='epl' AND board_date='2026-11-10'");
  const withoutHead = await inventory({ league: 'epl', from: '2026-11-10', through: '2026-11-10' });
  assert.equal(withoutHead.summary.observationCount, 1); assert.equal(withoutHead.summary.distinctBoardGameKeys, 1);
  assert.deepEqual(withoutHead.days[0].current, { status: 'NO_ACTIVE_HEAD', gameCount: 0, marketCount: 0, periods: [], periodCounts: [] },
    'an original durable receipt remains visible even when no active period head exists; inventory does not adopt it');
  await db.query(`CREATE TABLE sports_soccer_reader_snapshots_v1 (
    league TEXT NOT NULL,board_date DATE NOT NULL,observed_at TIMESTAMPTZ NOT NULL,revision TEXT NOT NULL,payload JSONB NOT NULL)`);
  assert.equal((await inventory(range)).legacy.status, 'EMPTY');
  for (const [league, date, observedAt] of [['EPL', '2026-10-20', '2026-10-19T01:00:00Z'],
    ['EPL', '2026-10-20', '2026-10-19T02:00:00Z'], ['EPL', '2026-10-21', '2026-10-20T02:00:00Z'],
    ['UCL', '2026-10-20', '2026-10-19T03:00:00Z'], ['EPL', '2025-01-01', '2024-12-31T03:00:00Z']])
    await db.query('INSERT INTO sports_soccer_reader_snapshots_v1 VALUES ($1,$2::date,$3::timestamptz,$4,$5::jsonb)',
      [league, date, observedAt, 'legacy-unreceipted-revision', JSON.stringify({ deviceId: 'private-legacy-device', pageUrl: 'https://private-legacy.example/', rawRows: ['private legacy row'] })]);
  const withLegacy = await inventory(range);
  assert.equal(withLegacy.summary.observationCount, 38, 'unreceipted legacy snapshots never inflate v2 database receipt counts');
  assert.equal(withLegacy.legacy.status, 'AVAILABLE'); assert.equal(withLegacy.legacy.snapshotCount, 3); assert.equal(withLegacy.legacy.boardDateCount, 2);
  assert.deepEqual(withLegacy.legacy.days.map(day => [day.date, day.snapshotCount]), [['2026-10-21', 1], ['2026-10-20', 2]]);
  assert.ok(withLegacy.legacy.days.every(day => day.receiptStatus === 'LEGACY_ACQUISITION_UNKNOWN'));
  assert.equal(withLegacy.legacy.lastObservedAt, '2026-10-20T02:00:00.000Z'); assert.equal(withLegacy.legacy.historicalAvailabilityVerified, false);
  assert.equal(withLegacy.legacy.formalEligible, false); assert.equal(withLegacy.legacy.executable, false);
  assert.doesNotMatch(JSON.stringify(withLegacy.legacy), /private-legacy|rawRows|pageUrl|deviceId|legacy-unreceipted-revision|receivedAt|persistedAt/);
  assert.equal((await inventory({ ...range, league: 'ucl' })).legacy.snapshotCount, 1);
  const limitedLegacy = await inventory(range, { limits: { dates: 1 } });
  assert.equal(limitedLegacy.legacy.snapshotCount, 3); assert.equal(limitedLegacy.legacy.days.length, 1); assert.equal(limitedLegacy.legacy.truncated, true);
  const legacyFailure = await inventory(range, { query: async (sql, values) => {
    if (sql.includes('FROM sports_soccer_reader_snapshots_v1')) throw Error('private legacy connection failure');
    return (await db.query(sql, values)).rows;
  } });
  assert.equal(legacyFailure.summary.observationCount, 38); assert.equal(legacyFailure.legacy.status, 'UNAVAILABLE');
  assert.equal(legacyFailure.legacy.snapshotCount, null); assert.equal(legacyFailure.legacy.boardDateCount, null);
  assert.doesNotMatch(JSON.stringify(legacyFailure), /private legacy connection/);
  console.log('PASS actual PostgreSQL Reader inventory: immutable receipt vs dedup source-game counts, FT/HT/UNKNOWN heads, explicit empty tombstones, date/league isolation, 31-day listing and full-range totals, bounded unknowns, head/hash validation, no raw/device/page leaks or freshness/adoption changes');
  console.log('PASS legacy inventory: separate bounded same-league/window date index, absent/empty/unavailable distinctions, no invented acquisition receipts, no v2 migration/count inflation and no legacy payload/secret export');

  register('./next-route-test-loader.mjs', import.meta.url);
  const { GET } = await import('../app/api/soccer/reader-inventory/route.js');
  const { createSessionToken } = await import('../lib/security.js'); const cookie = `mlb_session=${await createSessionToken()}`;
  let ip = 0;
  const request = (query = '?league=epl&from=2026-10-25&through=2026-10-26', auth = true, fixedIp = null) => new Request(`http://localhost/api/soccer/reader-inventory${query}`, {
    headers: { ...(auth ? { cookie } : {}), 'x-forwarded-for': fixedIp || `203.0.113.${++ip}` } });
  assert.equal((await GET(request(undefined, false))).status, 401);
  for (const query of ['?league=NBA', '?league=epl&league=ucl', '?league=epl&from=2026-10-25', '?league=epl&date=2026-10-25',
    '?league=epl&from=2026-02-30&through=2026-03-01', '?league=epl&from=2025-01-01&through=2026-10-25', '?league=epl&deviceId=secret'])
    assert.equal((await GET(request(query))).status, 400, query);
  const response = await GET(request()); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).summary.observationCount, 5);
  for (let index = 0; index < 60; index++) assert.equal((await GET(request('?league=NBA', true, '203.0.113.200'))).status, 400);
  assert.equal((await GET(request('?league=NBA', true, '203.0.113.200'))).status, 429);
  const oldTransport = globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL = async () => { throw Error('postgres://private-password@private-host'); };
  const failed = await GET(request()); const failedBody = await failed.json(); globalThis.__SOCCER_TEST_SQL = oldTransport;
  assert.equal(failed.status, 503); assert.equal(failedBody.ok, false); assert.doesNotMatch(JSON.stringify(failedBody), /private-password|private-host|observationCount/);
  assert.equal(external, 0);
  console.log('PASS Reader inventory API: authenticated GET only, no-store, strict league/date/duplicate/extra-key validation, rate limit, safe unavailable counts and zero provider calls');
} finally {
  globalThis.fetch = originalFetch;
  for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  await fixture.close();
}
