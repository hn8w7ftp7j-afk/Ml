import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { NextResponse } from 'next/server.js';
import { createSessionToken, requireApiAuth, rateLimitResponse } from '../lib/security.js';
import { MARKET_HISTORY_COVERAGE_HEADERS, parseMarketHistoryCoverageQuery, queryMarketHistoryCoverage } from '../lib/market-history-coverage.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { soccerJournalHash } from '../lib/soccer/journal.js';
import { MARKET_CAPTURE_RECEIPT_SCHEMA, MARKET_CAPTURE_GAMES_FORMAT } from '../lib/market-capture-receipts.js';

const db = new PGlite();
const statements = [];
const sql = async (strings, ...values) => {
  const text = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i, 'all inventory SQL is read-only');
  statements.push({ text, values });
  return (await db.query(text, values)).rows;
};
const now = Date.parse('2026-10-27T02:00:00.000Z');
const parse = input => parseMarketHistoryCoverageQuery(new URLSearchParams(input), { now });
const read = input => queryMarketHistoryCoverage(parse(input), { sql });
const league = (result, id) => result.leagues.find(row => row.league === id);
const state = [[0, '3+50', 0.95, 0.95], ['224平', 0.94, 0.94], null, null];
const soccerMarket = (period, kind = 'HANDICAP') => ({ period, kind, unit: 'GOALS', line: '1.5', lineSide: 'home', awayWater: 0.95, homeWater: 0.95, overWater: 0.94, underWater: 0.94 });
async function addState(id, boardDate, observedAt, compact = state, sport = 'NBA') {
  const serialized = JSON.stringify(compact);
  await db.query('INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [sport, boardDate, id, sport === 'NBA' ? null : id, observedAt, createHash('sha256').update(serialized).digest('hex').slice(0, 16), serialized, null, '2.1.43']);
}
async function addSoccer(id, sport, observedAt, period, markets, { receivedAt = observedAt, persistedAt = observedAt } = {}) {
  const game = { boardTime: '03:00', awayCode: 'ARS', homeCode: 'MCI', awayKey: 'arsenal', homeKey: 'man-city',
    markets, ...(period === 'UNKNOWN' ? {} : { periodsCovered: [period], periodStates: { [period]: 'open' } }) };
  const payload = { league: sport, boardDate: '2026-10-27', observedAt, games: [game], ...(period === 'UNKNOWN' ? {} : { periodsCovered: [period] }) };
  payload.contentHash = createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex');
  await db.query('INSERT INTO sports_soccer_reader_observations_v2 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [soccerJournalHash(payload), sport, '2026-10-27', payload.contentHash, observedAt, receivedAt, persistedAt, JSON.stringify(payload)]);
}
async function addReceipt(games, { observedAt = '2026-10-26T22:06:00.000Z', pageActivityAt = '2026-10-26T22:00:00.000Z', format = MARKET_CAPTURE_GAMES_FORMAT } = {}) {
  const original = { schema: MARKET_CAPTURE_RECEIPT_SCHEMA, gamesFormat: format, league: 'NBA', boardDate: '2026-10-27',
    sourceObservedAt: observedAt, pageActivityAt, sourceHash: null, readerVersion: '2.1.43', games };
  const receiptId = soccerJournalHash(original);
  await db.query('INSERT INTO tai888_market_capture_receipts_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [receiptId, 'NBA', '2026-10-27', observedAt, pageActivityAt, '2026-10-26T22:06:01Z', '2026-10-26T22:06:02Z', null, '2.1.43', format, JSON.stringify(games)]);
  return receiptId;
}

try {
  await db.exec(`CREATE TABLE tai888_market_line_history_v1 (
    league text,board_date date,game_key text,game_pk bigint,observed_at timestamptz,
    state_hash text,markets text,source_hash text,reader_version text);
    CREATE TABLE sports_soccer_reader_observations_v2 (
    observation_id text,league text,board_date date,content_hash text,source_observed_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,payload jsonb);`);
  await addState('07:05|BKN|CHA', '2026-10-27', '2026-10-26T22:00:00Z');
  await addState('07:05|BKN|CHA', '2026-10-27', '2026-10-26T22:01:00Z', [[0, '3.5', 0.96, 0.94], state[1], null, null]);
  await addState('07:05|BKN|CHA', '2026-10-26', '2026-10-25T22:01:00Z');
  for (const [index, sport] of ['MLB', 'NPB', 'KBO', 'CPBL'].entries()) {
    await addState(String(index + 1), '2026-10-27', '2026-10-26T22:00:00Z', [['away受讓1平', 0.95, 'home讓1平', 0.95], null, null, null], sport);
  }
  await addSoccer('epl-ft', 'EPL', '2026-10-26T22:00:00Z', 'FT', [soccerMarket('FT'), soccerMarket('FT', 'TOTAL')]);
  await addSoccer('epl-ht', 'EPL', '2026-10-26T22:05:00Z', 'HT', [soccerMarket('HT')]);
  await addSoccer('ucl-unknown', 'UCL', '2026-10-26T22:04:00Z', 'UNKNOWN', [soccerMarket('UNKNOWN')]);
  await addSoccer('epl-future-persisted', 'EPL', '2026-10-26T22:09:00Z', 'FT', [soccerMarket('FT')], { persistedAt: '2026-10-28T00:00:00Z' });
  let result = await read({});
  assert.equal(result.ok, true); assert.equal(result.status, 'PARTIAL'); assert.equal(result.coverageComplete, false); assert.equal(result.productionWrites, false);
  assert.equal(result.sources.find(row => row.sourceTable === 'tai888_market_capture_receipts_v1').status, 'NOT_READY');
  assert.equal(result.leagues.length, 7); assert.equal(league(result, 'NBA').savedCount, 3); assert.equal(league(result, 'NBA').gameDateKeys, 2);
  assert.equal(league(result, 'NBA').lastReaderObservedAt, null, 'last changed state does not prove Reader heartbeat');
  assert.equal(league(result, 'NBA').lastStateChangedAt, '2026-10-26T22:01:00.000Z');
  assert.equal(league(result, 'EPL').savedCount, 2); assert.equal(league(result, 'EPL').countUnit, 'READER_OBSERVATIONS');
  assert.equal(league(result, 'NBA').countUnit, 'CHANGED_STATES');
  const epl = result.games.find(row => row.league === 'EPL');
  assert.deepEqual(epl.markets.map(market => market.status), ['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'NOT_CAPTURED']);
  assert.equal(epl.markets[0].lastObservedAt, '2026-10-26T22:00:00.000Z', 'HT capture cannot replace FT capture time');
  assert.equal(epl.markets[2].lastObservedAt, '2026-10-26T22:05:00.000Z');
  assert.equal(epl.integrity.status, 'PASS', 'immutable original observation and content hashes are read back and verified');
  const ucl = result.games.find(row => row.league === 'UCL');
  assert.ok(ucl.markets.every(market => market.status === 'PERIOD_UNKNOWN'));
  assert.ok(ucl.integrity.issues.includes('PERIOD_UNKNOWN'));
  assert.ok(result.games.every(row => row.closingCoverage === 'NOT_VERIFIED'));
  assert.ok(result.games.filter(row => row.league === 'NBA').every(row => row.integrity.status === 'PASS'));

  await db.exec(`CREATE TABLE tai888_market_capture_receipts_v1 (
    receipt_id text,league text,board_date date,source_observed_at timestamptz,page_activity_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,source_hash text,reader_version text,games_format text,games jsonb);`);
  const missing = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
  const captured = [{ gameKey: '07:05|BKN|CHA', gamePk: null, marketStatus: 'locked', captureStatus: 'LOCKED', markets: [false, false, false, false], stateHash: null, missingMarkets: missing },
    { gameKey: '08:05|LAL|GSW', gamePk: null, marketStatus: 'locked', captureStatus: 'UNOPENED', markets: [false, false, false, false], stateHash: null, missingMarkets: missing },
    { gameKey: '09:05|BOS|DEN', gamePk: null, marketStatus: 'locked', captureStatus: 'IDENTITY_BLOCKED', markets: [false, false, false, false], stateHash: null, missingMarkets: missing }];
  await addReceipt(captured);
  result = await read({});
  assert.equal(result.status, 'PASS', 'PASS means queries succeeded, not complete final quotes');
  assert.equal(result.coverageComplete, false); assert.equal(league(result, 'NBA').captureReceiptCount, 1);
  assert.equal(league(result, 'NBA').lastReaderObservedAt, '2026-10-26T22:06:00.000Z');
  assert.equal(league(result, 'NBA').lastStateChangedAt, '2026-10-26T22:01:00.000Z');
  assert.equal(league(result, 'NBA').lastPersistedAt, '2026-10-26T22:06:02.000Z');
  const latestNBA = result.games.find(row => row.league === 'NBA' && row.boardDate === '2026-10-27');
  assert.equal(latestNBA.archiveObservedAt, '2026-10-26T22:01:00.000Z');
  assert.ok(latestNBA.latestCaptureMarkets.every(row => row.status === 'LOCKED'));
  assert.equal(latestNBA.receiptIntegrity.status, 'PASS');
  assert.equal(latestNBA.markets[0].status, 'AVAILABLE', 'retained changed-state quote is distinct from current locked observation');
  assert.ok(result.games.find(row => row.gameKey === '08:05|LAL|GSW').latestCaptureMarkets.every(row => row.status === 'NOT_CAPTURED'), 'inferred unopened row is not an observed lock');
  assert.ok(result.games.find(row => row.gameKey === '09:05|BOS|DEN').latestCaptureMarkets.every(row => row.status === 'INVALID'), 'unresolved identity cannot become an observed lock');
  const retainedHash = createHash('sha256').update(JSON.stringify([[0, '3.5', 0.96, 0.94], state[1], null, null])).digest('hex').slice(0, 16);
  const openGame = { gameKey: '07:05|BKN|CHA', gamePk: null, marketStatus: 'open', captureStatus: 'CAPTURED', markets: [true, true, false, false], stateHash: retainedHash, missingMarkets: ['上半讓分', '上半大小'] };
  const validOpenReceipt = await addReceipt([openGame], { observedAt: '2026-10-26T22:07:00.000Z', pageActivityAt: '2026-10-26T22:01:00.000Z' });
  let receiptGame = (await read({ league: 'NBA' })).games.find(row => row.gameKey === openGame.gameKey && row.boardDate === '2026-10-27');
  assert.equal(receiptGame.receiptIntegrity.status, 'PASS');
  assert.deepEqual(receiptGame.latestCaptureMarkets.map(row => row.status), ['AVAILABLE', 'AVAILABLE', 'NOT_CAPTURED', 'NOT_CAPTURED']);
  for (const malformed of [
    { game: { ...openGame, markets: [{ truthy: true }, true, false, false] }, format: MARKET_CAPTURE_GAMES_FORMAT, issue: 'CAPTURE_RECEIPT_SHAPE_INVALID' },
    { game: openGame, format: 'UNSUPPORTED_FORMAT', issue: 'CAPTURE_RECEIPT_SHAPE_INVALID' },
    { game: { ...openGame, stateHash: 'f'.repeat(16) }, format: MARKET_CAPTURE_GAMES_FORMAT, issue: 'CAPTURE_STATE_REFERENCE_INVALID' },
    { game: { ...openGame, markets: [true, false, false, false] }, format: MARKET_CAPTURE_GAMES_FORMAT, issue: 'CAPTURE_STATE_REFERENCE_INVALID' },
  ]) {
    const id = await addReceipt([malformed.game], { observedAt: '2026-10-26T22:08:00.000Z', pageActivityAt: '2026-10-26T22:01:00.000Z', format: malformed.format });
    receiptGame = (await read({ league: 'NBA' })).games.find(row => row.gameKey === openGame.gameKey && row.boardDate === '2026-10-27');
    assert.equal(receiptGame.receiptIntegrity.status, 'FAIL'); assert.ok(receiptGame.receiptIntegrity.issues.includes(malformed.issue));
    assert.ok(receiptGame.latestCaptureMarkets.every(row => row.status === 'INVALID'));
    await db.query('DELETE FROM tai888_market_capture_receipts_v1 WHERE receipt_id=$1', [id]);
  }
  await db.query("UPDATE tai888_market_capture_receipts_v1 SET games=jsonb_set(games,'{0,markets,0}','false'::jsonb) WHERE receipt_id=$1", [validOpenReceipt]);
  receiptGame = (await read({ league: 'NBA' })).games.find(row => row.gameKey === openGame.gameKey && row.boardDate === '2026-10-27');
  assert.ok(receiptGame.receiptIntegrity.issues.includes('CAPTURE_RECEIPT_HASH_MISMATCH'));
  assert.ok(receiptGame.latestCaptureMarkets.every(row => row.status === 'INVALID'));
  await db.query('UPDATE tai888_market_capture_receipts_v1 SET games=$1::jsonb WHERE receipt_id=$2', [JSON.stringify([openGame]), validOpenReceipt]);
  const tooEarly = await addReceipt([openGame], { observedAt: '2026-10-26T22:08:00.000Z', pageActivityAt: '2026-10-26T21:59:00.000Z' });
  receiptGame = (await read({ league: 'NBA' })).games.find(row => row.gameKey === openGame.gameKey && row.boardDate === '2026-10-27');
  assert.ok(receiptGame.receiptIntegrity.issues.includes('CAPTURE_STATE_REFERENCE_INVALID'), 'later archived quote cannot validate an earlier receipt');
  await db.query('DELETE FROM tai888_market_capture_receipts_v1 WHERE receipt_id=$1', [tooEarly]);
  const one = await read({ league: 'EPL', date: '2026-10-27', limit: '1' });
  assert.equal(one.sources.length, 1); assert.equal(one.leagues.length, 1); assert.equal(one.games.length, 1); assert.equal(one.status, 'PASS');
  assert.equal(one.gameRowsTruncated, false);
  const limited = await read({ limit: '1' }); assert.equal(limited.games.length, 1); assert.equal(limited.gameRowsTruncated, true);
  const empty = await read({ date: '2020-01-01' }); assert.ok(empty.leagues.every(row => row.savedCount === 0));
  assert.equal(empty.games.length, 0); assert.equal(empty.coverageComplete, false);
  const noSoccer = await read({ league: 'NBA' }); assert.ok(noSoccer.sources.every(row => row.sourceTable !== 'sports_soccer_reader_observations_v2'));
  for (const invalid of [{ league: 'NHL' }, { league: 'nba' }, { date: '2026-02-30' }, { date: '2026-10-27', from: '2026-10-27' },
    { from: '2026-10-28', through: '2026-10-27' }, { limit: '0' }, { limit: '501' }, { limit: '01' }, { unknown: '1' },
    { until: '2026-10-28T00:00:00.000Z' }, { until: '2026-10-27T99:00:00.000Z' }]) assert.throws(() => parse(invalid), error => error.status === 400);
  assert.throws(() => parseMarketHistoryCoverageQuery(new URLSearchParams('league=NBA&league=EPL')), error => error.status === 400);
  await assert.rejects(queryMarketHistoryCoverage(parse({}), { env: {} }), error => error.code === 'HISTORY_DATABASE_NOT_CONFIGURED');
  for (const missingCount of [null, '', undefined]) {
    const brokenCount = await queryMarketHistoryCoverage(parse({ league: 'EPL' }), { sql: async () => [{ leagues: [{ league: 'EPL', saved_count: missingCount, game_date_keys: 1 }], games: [] }] });
    assert.equal(brokenCount.ok, false); assert.equal(league(brokenCount, 'EPL').savedCount, null, 'missing counter must never be converted to zero');
  }
  await db.exec(`UPDATE sports_soccer_reader_observations_v2 SET payload=jsonb_set(payload,'{games,0,markets,0,line}','"99.5"'::jsonb) WHERE league='UCL'`);
  const corrupt = await read({ league: 'UCL' });
  assert.equal(corrupt.games[0].integrity.status, 'FAIL');
  assert.ok(corrupt.games[0].integrity.issues.includes('SOURCE_PAYLOAD_HASH_MISMATCH'));
  assert.ok(corrupt.games[0].markets.every(market => market.status === 'INVALID'));

  // An unavailable source cannot turn other successfully read sources into zero data.
  await db.exec('DROP TABLE sports_soccer_reader_observations_v2');
  result = await read({}); assert.equal(result.status, 'PARTIAL'); assert.equal(league(result, 'NBA').savedCount, 3);
  assert.equal(league(result, 'EPL').savedCount, null); assert.equal(league(result, 'EPL').status, 'NOT_VERIFIED');
  assert.equal(result.sources.find(row => row.sourceTable === 'sports_soccer_reader_observations_v2').status, 'NOT_READY');
  const onlyMissing = await read({ league: 'EPL' }); assert.equal(onlyMissing.ok, false); assert.equal(onlyMissing.status, 'FAIL');

  // Exercise auth, limits, HTTP partial success and cache contract through the real route body.
  process.env.APP_PASSWORD = 'synthetic-market-coverage-password'; process.env.SESSION_SECRET = 'synthetic-market-coverage-session-secret';
  const token = await createSessionToken();
  const source = readFileSync(new URL('../app/api/market-history-coverage/route.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  let blocked = false;
  const services = { NextResponse, requireApiAuth, rateLimitResponse, MARKET_HISTORY_COVERAGE_HEADERS,
    checkRateLimit: () => ({ allowed: !blocked, retryAfter: 60 }), parseMarketHistoryCoverageQuery: input => parseMarketHistoryCoverageQuery(input, { now }),
    queryMarketHistoryCoverage: query => queryMarketHistoryCoverage(query, { sql }) };
  const GET = new Function(...Object.keys(services), `${body}; return GET;`)(...Object.values(services));
  const request = (params, auth = true) => new Request(`http://localhost/api/market-history-coverage?${new URLSearchParams(params)}`, { headers: auth ? { cookie: `mlb_session=${token}` } : {} });
  let callsBefore = statements.length;
  assert.equal((await GET(request({}, false))).status, 401); assert.equal(statements.length, callsBefore);
  blocked = true; assert.equal((await GET(request({}))).status, 429); assert.equal(statements.length, callsBefore); blocked = false;
  assert.equal((await GET(request({ league: 'NHL' }))).status, 400); assert.equal(statements.length, callsBefore);
  const partial = await GET(request({})); assert.equal(partial.status, 200); assert.equal((await partial.json()).status, 'PARTIAL');
  assert.equal(partial.headers.get('cache-control'), 'private, no-store');
  assert.equal((await GET(request({ league: 'EPL' }))).status, 503);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM tai888_market_line_history_v1')).rows[0].count, 7);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM tai888_market_capture_receipts_v1')).rows[0].count, 2);
  console.log('PASS: read-only seven-league market inventory with real PostgreSQL SQL, separate state/observation units, FT/HT isolation, receipt-vs-change times, locked capture evidence, honest partial/missing sources, bounded rows, auth and API/cache contracts; NOT Production');
} finally { await db.close(); }
