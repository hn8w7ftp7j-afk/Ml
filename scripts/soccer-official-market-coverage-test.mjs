import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerReaderHash } from '../lib/soccer/reader.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { fetchSoccerSchedule } from '../lib/soccer/data.js';

const fixture = await soccerSqlFixture(), { db } = fixture;
const keys = ['DATABASE_URL', 'DATABASE_V2_URL', 'APP_PASSWORD', 'SESSION_SECRET'];
const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/official-coverage'; delete process.env.DATABASE_V2_URL;
process.env.APP_PASSWORD = 'coverage-engineering'; process.env.SESSION_SECRET = 'coverage-session';
const oldFetch = globalThis.fetch;
// Database receipts use real time. Keep the 21:00 Taipei fixture ahead of it.
const kickoff = new Date();
kickoff.setUTCDate(kickoff.getUTCDate() + 1);
kickoff.setUTCHours(13, 0, 0, 0);
const date = kickoff.toISOString().slice(0, 10), observedAt = new Date(Date.now() - 1000).toISOString();
const providerDates = new Set([new Date(kickoff.getTime() - 86400000), kickoff]
  .map(day => day.toISOString().slice(0, 10).replaceAll('-', '')));
function sourceEvent(id = '9001', league = 'epl') {
  return { id, date: kickoff.toISOString(), status: { type: { state: 'pre', name: 'STATUS_SCHEDULED' } },
    competitions: [{ id, competitors: [
      { homeAway: 'home', team: { id: '331', displayName: 'Brighton & Hove Albion' } },
      { homeAway: 'away', team: { id: '384', displayName: 'Crystal Palace' } },
    ] }] };
}
function provider(league = 'epl', events = [sourceEvent()]) {
  return { leagues: [{ id: league === 'epl' ? '700' : '775', slug: league === 'epl' ? 'eng.1' : 'uefa.champions' }], events };
}
let boardEvents = [sourceEvent()], calls = 0; const sourceUrls = [];
const transport = async url => { calls++; sourceUrls.push(url); const league = url.includes('eng.1') ? 'epl' : 'ucl'; return { ok: true, status: 200, url, json: async () => provider(league, boardEvents) }; };
const schedule = (league, day) => fetchSoccerSchedule(league, day, { fetchImpl: transport, ttlMs: 0 });
const mkMarket = (period, kind, line = kind === 'TOTAL' ? '2.5' : '0-50', extra = {}) => ({ kind, unit: 'GOALS', period, line,
  ...(kind === 'TOTAL' ? { overWater: .9, underWater: .95 } : { lineSide: 'home', homeWater: .85, awayWater: .91 }),
  rawRows: ['private source line'], periodEvidence: { period, status: period === 'UNKNOWN' ? 'UNKNOWN' : 'EXPLICIT',
    sectionTitle: `英格蘭超級聯賽${period === 'FT' ? ' 全場' : period === 'HT' ? ' 上半場' : ''}`, tableHeaders: ['時間', '主客隊伍', '讓球', '大小', '獨贏'], marketHeader: kind === 'TOTAL' ? '大小' : '讓球' }, ...extra });
let seq = 0;
function payload(markets, { league = 'EPL', unmatched = false, time = observedAt } = {}) {
  const periods = [...new Set(markets.map(m => m.period))].sort();
  const value = { league, boardDate: date, observedAt: new Date(Date.parse(time) + seq++).toISOString(), executable: false,
    sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/?private=secret', deviceId: 'private-device', periodsCovered: periods,
    games: [{ league, boardDate: date, boardTime: unmatched ? '23:00' : '21:00', homeKey: 'brighton', awayKey: 'crystalpalace', homeCode: 'BHA', awayCode: 'CRY',
      periodsCovered: periods, periodStates: Object.fromEntries(periods.map(p => [p, 'open'])), markets }] };
  value.contentHash = soccerReaderHash(canonicalSoccerPayload(value)); return value;
}
try {
  const { saveSoccerReaderSnapshot: save, loadSoccerReaderSnapshot: load } = await import('../lib/soccer/reader-store.js');
  const { readSoccerOfficialMarketCoverage: read, normalizeSoccerOfficialMarketCoverageQuery: normalize } = await import('../lib/soccer/official-market-coverage.js');
  assert.equal(normalize({ league: 'EPL', date }).league, 'epl');
  for (const bad of [{}, { league: 'nba', date }, { league: 'epl', date: '2026-02-30' }, { league: 'epl', date, fresh: true }, { league: 'ucl', date, cursor: '' }]) assert.throws(() => normalize(bad), e => e.status === 400);
  const original = payload([mkMarket('FT', 'TOTAL'), mkMarket('FT', 'TOTAL', '3平'), mkMarket('FT', 'HANDICAP'), { kind: 'MONEYLINE', unit: 'MATCH', period: 'FT', homeWater: 1.2 }]);
  await save(original);
  await save(payload([mkMarket('HT', 'TOTAL', '1平')]));
  await save(payload([mkMarket('UNKNOWN', 'TOTAL')]));
  await save(payload([mkMarket('FT', 'TOTAL')], { unmatched: true }));
  await save(payload([mkMarket('FT', 'TOTAL')], { league: 'UCL' }));
  const opts = { schedule, secret: 'testing-secret', now: Date.now() + 20 };
  let result = await read({ league: 'epl', date }, opts), report = result.report;
  assert.equal(report.schedule.officialGameCount, 1); assert.equal(report.history.totalReceipts, 4); assert.equal(report.history.scopeComplete, true);
  assert.equal(report.games.length, 1, 'FT/HT are cells of the same fixture, never extra fixtures');
  const game = report.games[0];
  assert.equal(game.seen.cells['FT:TOTAL'].marketIds.length, 2, 'alternate source lines remain visible');
  assert.equal(game.seen.cells['FT:TOTAL'].completeMarketIds.length, 2); assert.equal(game.seen.cells['FT:HANDICAP'].marketIds.length, 1);
  assert.equal(game.seen.cells['HT:TOTAL'].marketIds.length, 1); assert.equal(game.seen.cells['HT:HANDICAP'].marketIds.length, 0);
  assert.equal(game.seen.unknownPeriodQuoteCount, 2); assert.equal(report.unmatched.length, 1); assert.equal(report.unmatched[0].status, 'UNMATCHED');
  assert.equal(game.current.cells['FT:TOTAL'].freshPregameMarketCount, 0, 'an unmatched latest FT head must not resurrect an older matched price'); assert.equal(game.current.cells['HT:TOTAL'].freshPregameMarketCount, 1);
  assert.equal(report.formalEligible, false); assert.equal(report.executable, false); assert.equal(report.coverageComplete, false);
  assert.equal(report.history.historicalAvailabilityVerified, false); assert.equal(report.schedule.providerCompletenessVerified, false);
  const ucl = (await read({ league: 'ucl', date }, opts)).report;
  assert.equal(ucl.history.totalReceipts, 1); assert.equal(ucl.games[0].gameId, 'soccer:ucl:9001');
  assert.equal(ucl.games[0].seen.cells['FT:TOTAL'].marketIds.length, 1, 'EPL alternate lines never populate UCL coverage');
  assert.doesNotMatch(JSON.stringify(report), /private-device|private=secret|private source|deviceId|rawRows|tai888\.in/);
  const frozen = await db.query('SELECT to_jsonb(h) AS value FROM sports_soccer_reader_period_heads_v2 h ORDER BY league,board_date,period');
  const first = await read({ league: 'epl', date }, { ...opts, limits: { pageRows: 1 } });
  assert.equal(first.report.history.readCount, 1); assert.equal(first.report.history.hasMore, true); assert.equal(first.report.history.scopeComplete, false);
  let page = first, readCount = 1; const merged = new Set(page.report.games[0].seen.cells['FT:TOTAL'].marketIds);
  while (page.report.history.hasMore) {
    page = await read({ league: 'epl', date, cursor: page.report.history.nextCursor }, { ...opts, limits: { pageRows: 1 } });
    assert.equal(page.report.history.readFrom, readCount++); assert.equal(page.report.history.scopeComplete, false, 'last cursor page alone never certifies all earlier reads');
    for (const id of page.report.games[0].seen.cells['FT:TOTAL'].marketIds) merged.add(id);
  }
  assert.equal(readCount, 4); assert.equal(merged.size, 2);
  await assert.rejects(read({ league: 'ucl', date, cursor: first.report.history.nextCursor }, opts), e => e.status === 400);
  await assert.rejects(read({ league: 'epl', date, cursor: first.report.history.nextCursor.slice(0, -1) + 'X' }, opts), e => e.status === 400);
  await save(payload([mkMarket('FT', 'TOTAL', '4平')]));
  const outsideFrozen = await read({ league: 'epl', date, cursor: first.report.history.nextCursor }, opts);
  assert.equal(outsideFrozen.report.history.totalReceipts, 4, 'new post-cutoff receipt does not silently change a scan');
  const normalQuery = async (sql, values) => (await db.query(sql, values)).rows;
  await assert.rejects(read({ league: 'epl', date }, { ...opts, query: async (sql, values) => {
    const rows = await normalQuery(sql, values); if (sql.startsWith('WITH cutoff')) rows[0].items[0].contentHash = '0'.repeat(64); return rows;
  } }), /ORIGINAL_MISMATCH/);
  await assert.rejects(read({ league: 'epl', date }, { ...opts, query: async () => [{ n: '0', cutoffAt: new Date().toISOString() }] }), /MANIFEST_UNAVAILABLE/);
  await assert.rejects(read({ league: 'epl', date }, { ...opts, query: async (sql, values) => {
    const rows = await normalQuery(sql, values); if (sql.startsWith('WITH encoded')) rows[0].items[0].payload.games = []; return rows;
  } }), /RECEIPT_CORRUPTED/, 'whole original hashes are verified before projecting source market facts');
  const overBudget = (await read({ league: 'epl', date }, { ...opts, query: async (sql, values) => {
    const rows = await normalQuery(sql, values); if (sql.startsWith('WITH cutoff')) { rows[0].n = '10001'; rows[0].items = []; } return rows;
  } })).report;
  assert.equal(overBudget.history.totalReceipts, null); assert.equal(overBudget.history.integrityStatus, 'NOT_VERIFIED'); assert.equal(overBudget.history.scopeComplete, false);
  await assert.rejects(read({ league: 'epl', date }, { ...opts, schedule: async () => ({ ...(await schedule('epl', date)), games: undefined }) }), /SCHEDULE_UNAVAILABLE/);
  await assert.rejects(read({ league: 'epl', date }, { ...opts, schedule: async () => structuredClone(await schedule('epl', date)) }), /SCHEDULE_UNAVAILABLE/, 'copied client coverage flags cannot create private source authority');
  let unknown = await read({ league: 'epl', date }, { ...opts, loadCurrent: async () => ({ league: 'EPL', boardDate: date }) });
  assert.equal(unknown.report.games[0].current.cells, null); assert.equal(unknown.report.diagnostics.currentStatus, 'NOT_VERIFIED');
  const current = await load('epl', date), stale = structuredClone(current);
  const staleAt = new Date(Date.parse(observedAt) - 86400000).toISOString();
  for (const raw of stale.games) for (const market of raw.markets) market.serverObservation.observedAt = staleAt;
  report = (await read({ league: 'epl', date }, { ...opts, loadCurrent: async () => stale })).report;
  assert.equal(report.games[0].current.cells['FT:TOTAL'].freshPregameMarketCount, 0, 'history or a sibling heartbeat never makes stale quotes fresh');
  const unreceipted = structuredClone(current); for (const raw of unreceipted.games) for (const m of raw.markets) m.serverObservation.persistedAt = null;
  assert.equal((await read({ league: 'epl', date }, { ...opts, loadCurrent: async () => unreceipted })).report.games[0].current.cells['FT:TOTAL'].freshPregameMarketCount, 0);
  const afterKickoff = (await read({ league: 'epl', date }, { ...opts, now: kickoff.getTime(), loadCurrent: async () => current })).report;
  assert.equal(afterKickoff.games[0].current.cells['FT:TOTAL'].freshPregameMarketCount, 0, 'schedule fetch time does not re-establish pregame acquisition');
  const duplicateIncomplete = payload([mkMarket('FT', 'TOTAL', '5平', { underWater: null }), mkMarket('FT', 'TOTAL', '5平', { overWater: null })]); await save(duplicateIncomplete);
  report = (await read({ league: 'epl', date }, { ...opts, now: Date.now() + 20 })).report;
  assert.equal(report.games[0].seen.cells['FT:TOTAL'].marketIds.length, 4); assert.equal(report.games[0].seen.cells['FT:TOTAL'].completeMarketIds.length, 3, 'two incomplete rows do not fabricate a complete pair');
  const tooLarge = await read({ league: 'epl', date }, { ...opts, query: async (sql, values) => { const rows = await normalQuery(sql, values); if (sql.startsWith('WITH cutoff')) rows[0].items.forEach(row => row.payloadBytes = 8000000); return rows; }, limits: { pageBytes: 4096 } });
  assert.equal(tooLarge.report.history.integrityStatus, 'NOT_VERIFIED'); assert.equal(tooLarge.report.history.scopeComplete, false); assert.equal(tooLarge.report.history.readCount, 0);
  boardEvents = [sourceEvent(), sourceEvent('9002')];
  report = (await read({ league: 'epl', date }, { ...opts, now: Date.now() + 20 })).report;
  assert.equal(report.games.length, 2); assert.ok(report.unmatched.some(row => row.status === 'AMBIGUOUS')); assert.ok(report.games.every(g => g.seen.cells['FT:TOTAL'].marketIds.length === 0));
  await assert.rejects(read({ league: 'epl', date, cursor: first.report.history.nextCursor }, opts), e => e.status === 409);
  boardEvents = [];
  report = (await read({ league: 'epl', date }, { ...opts, now: Date.now() + 20 })).report;
  assert.equal(report.schedule.officialGameCount, 0); assert.equal(report.status, 'PARTIAL'); assert.equal(report.schedule.sourceVerified, false); assert.equal(report.coverageComplete, false);
  boardEvents = [sourceEvent()];
  const originalSources = async () => (await db.query(`SELECT jsonb_build_object(
    'observations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY observation_id) FROM sports_soccer_reader_observations_v2 o),
    'periods',(SELECT jsonb_agg(to_jsonb(p) ORDER BY observation_id,period) FROM sports_soccer_reader_period_observations_v2 p),
    'heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY league,board_date,period) FROM sports_soccer_reader_period_heads_v2 h)) AS value`)).rows[0].value;
  const sourceBefore = await originalSources(); await read({ league: 'epl', date }, opts); assert.deepEqual(await originalSources(), sourceBefore, 'coverage performs no mutation, period adoption or clock freshening');
  const providerUrl = /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/soccer\/(?:eng\.1|uefa\.champions)\/scoreboard\?dates=(\d{8})$/;
  assert.ok(sourceUrls.every(url => providerDates.has(url.match(providerUrl)?.[1])), 'only real provider pages are fetched; cron/index summaries never substitute for schedule or originals');
  assert.deepEqual((await db.query('SELECT to_jsonb(h) AS value FROM sports_soccer_reader_period_heads_v2 h WHERE league=\'ucl\' ORDER BY league,board_date,period')).rows,
    frozen.rows.filter(row => row.value.league === 'ucl'), 'coverage never changes or adopts another league head');
  console.log('PASS official/Reader coverage against real PostgreSQL fixture: original hashes, immutable manifest pagination, private provider authority, unique fixtures, four cells, alternates, incomplete sides, unmatched/ambiguous identities, current DB receipt freshness, scope/league isolation, no raw exports or fabricated acceptance');

  globalThis.fetch = transport; register('./next-route-test-loader.mjs', import.meta.url);
  const { GET } = await import('../app/api/soccer/market-coverage/route.js');
  const { createSessionToken } = await import('../lib/security.js'), cookie = `mlb_session=${await createSessionToken()}`;
  let ip = 0; const request = (q = `?league=epl&date=${date}`, auth = true, fixedIp = null) => new Request(`http://localhost/api/soccer/market-coverage${q}`, { headers: { ...(auth ? { cookie } : {}), 'x-forwarded-for': fixedIp || `198.51.100.${++ip}` } });
  assert.equal((await GET(request(undefined, false))).status, 401);
  for (const q of [`?league=nba&date=${date}`, '?league=epl', `?league=epl&date=${date}&league=ucl`, `?league=epl&date=${date}&fresh=true`, `?league=epl&date=${date}&cursor=bad`]) assert.equal((await GET(request(q))).status, 400);
  const api = await GET(request()); assert.equal(api.status, 200); assert.equal(api.headers.get('cache-control'), 'private, no-store'); assert.equal((await api.json()).report.history.totalReceipts, 6);
  for (let n = 0; n < 90; n++) assert.equal((await GET(request('?league=nba', true, '203.0.113.188'))).status, 400);
  assert.equal((await GET(request('?league=nba', true, '203.0.113.188'))).status, 429);
  const oldTransport = globalThis.__SOCCER_TEST_SQL; globalThis.__SOCCER_TEST_SQL = async () => { throw Error('private secret database URL'); };
  const unavailable = await GET(request()); globalThis.__SOCCER_TEST_SQL = oldTransport;
  assert.equal(unavailable.status, 503); assert.doesNotMatch(JSON.stringify(await unavailable.json()), /private secret|totalReceipts|officialGameCount/);
  console.log('PASS coverage API auth, strict params/duplicates/cursor validation, no-store, bounded rate, safe unknowns; fixture validation is not Production acceptance');
} finally {
  globalThis.fetch = oldFetch; for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; } await fixture.close();
}
