import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server.js';
import { createSessionToken, requireApiAuth, rateLimitResponse } from '../lib/security.js';
import { MARKET_LINE_HISTORY_QUERY_HEADERS, parseMarketLineHistoryQuery, createMarketLineHistoryCursor,
  expandMarketLineHistoryRow, queryMarketLineHistory } from '../lib/market-line-history-query.js';

// Local SQL-boundary fixtures only. No production connection, writes, or schema creation.
process.env.APP_PASSWORD = 'history-query-local-password';
process.env.SESSION_SECRET = 'history-query-local-secret-abcdefghijklmnopqrstuvwxyz';
const token = await createSessionToken();
const now = Date.parse('2026-10-14T01:00:00.000Z');
const until = '2026-10-14T00:00:00.000Z';
const parse = params => parseMarketLineHistoryQuery(new URLSearchParams(params), { now });
const baseball = [['兄弟讓1+60', 1.06, '統一受讓1+60', 0.94], ['大8+20', 0.98, '小8+20', 1.02], null, null];
const nba = [[1, '2+50', 0.94, 1.06], ['224-50', 0.98, 1.02], [0, '1+20', 1.03, 0.97], null];
const makeRow = (league, gameKey, observedAt, markets = baseball, boardDate = '2026-10-08') => {
  const raw = typeof markets === 'string' ? markets : JSON.stringify(markets);
  return { league, board_date: boardDate, game_key: gameKey, game_pk: league === 'NBA' ? null : gameKey,
    observed_at: observedAt, markets: raw, state_hash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    source_hash: 'a'.repeat(32), reader_version: '2.1.30' };
};
const inventory = [
  ...Array.from({ length: 502 }, (_, index) => makeRow('KBO', String(index + 1), `2026-10-08T10:00:00.${String(index + 1).padStart(6, '0')}Z`)),
  makeRow('CPBL', '800', '2026-10-08T10:00:00.000002Z'),
  makeRow('MLB', '801', '2026-10-08T10:00:00.000002Z'),
  makeRow('NPB', '802', '2026-10-08T10:00:00.000002Z'),
  makeRow('NBA', '19:30|LAL|GSW', '2026-10-08T10:00:00.000002Z', nba),
  makeRow('NBA', '19:30|LAL|GSW', '2026-10-09T10:00:00.000002Z', nba, '2026-10-09'),
  makeRow('CPBL', '803', '2026-10-08T10:00:00.000003Z', '{not JSON'),
  makeRow('KBO', '999', '2026-10-15T10:00:00.000001Z'), // excluded by frozen cutoff
];
const tuple = row => [row.observed_at, row.league, row.board_date, row.game_key];
const compare = (left, right) => {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
};
const summarize = rows => {
  const dates = rows.map(row => row.board_date).sort(), observed = rows.map(row => row.observed_at).sort();
  return { saved_states: String(rows.length), game_date_keys: String(new Set(rows.map(row => JSON.stringify([row.league, row.board_date, row.game_key]))).size),
    board_dates: String(new Set(dates).size), first_board_date: dates[0] ?? null, last_board_date: dates.at(-1) ?? null,
    first_observed_at: observed[0] ?? null, last_observed_at: observed.at(-1) ?? null };
};
let calls = [], databaseError = null;
const sql = async (parts, ...values) => {
  const statement = parts.join('?');
  calls.push({ statement, values });
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.match(statement, /COUNT\(DISTINCT \(league, board_date, game_key\)\)/);
  assert.match(statement, /COUNT\(DISTINCT \(board_date, game_key\)\)/);
  assert.match(statement, /WITH filtered AS MATERIALIZED/);
  assert.match(statement, /HH24:MI:SS.US/);
  assert.match(statement, /ORDER BY observed_at, league, board_date, game_key LIMIT \?/);
  assert.equal(values.length, 15);
  if (databaseError) throw databaseError;
  const [cutoff, league, repeatedLeague, from, repeatedFrom, through, repeatedThrough, gameKey, repeatedGameKey,
    observedAt, repeatedObservedAt, afterLeague, afterDate, afterKey, limit] = values;
  assert.equal(league, repeatedLeague); assert.equal(from, repeatedFrom); assert.equal(through, repeatedThrough);
  assert.equal(gameKey, repeatedGameKey); assert.equal(observedAt, repeatedObservedAt);
  const canonicalCutoff = cutoff.replace(/(\.\d{3})Z$/, (_, milliseconds) => `${milliseconds}000Z`);
  const filtered = inventory.filter(row => row.observed_at <= canonicalCutoff && (!league || row.league === league)
    && (!from || row.board_date >= from) && (!through || row.board_date <= through) && (!gameKey || row.game_key === gameKey));
  const page = filtered.filter(row => !observedAt || compare(tuple(row), [observedAt, afterLeague, afterDate, afterKey]) > 0)
    .sort((left, right) => compare(tuple(left), tuple(right))).slice(0, limit);
  const leagues = [...new Set(filtered.map(row => row.league))].sort().map(leagueId => ({ league: leagueId,
    ...summarize(filtered.filter(row => row.league === leagueId)) }));
  return [{ totals: summarize(filtered), leagues, rows: page }];
};

const first = await queryMarketLineHistory(parse({ league: 'KBO', until, limit: '500' }), { sql });
assert.equal(first.rows.length, 500); assert.equal(first.totals.savedStates, 502); assert.equal(first.totals.gameDateKeys, 502);
assert.equal(first.productionWrites, false); assert.equal(first.coverageComplete, false); assert.equal(first.cutoffBasis, 'observed_at');
assert.equal(first.leagues.length, 1); assert.equal(first.leagues[0].league, 'KBO'); assert.equal(calls.length, 1);
assert.ok(first.rows.every(row => row.league === 'KBO' && row.integrity.ok));
const second = await queryMarketLineHistory(parse({ league: 'KBO', after: first.nextAfter, limit: '500' }), { sql });
assert.equal(second.until, until); assert.equal(second.rows.length, 2); assert.equal(second.nextAfter, null);
assert.equal(second.totals.savedStates, 502, 'whole-filter total must remain independent of pagination');
assert.equal(new Set([...first.rows, ...second.rows].map(row => JSON.stringify([row.league, row.boardDate, row.gameKey, row.observedAt]))).size, 502);
assert.notEqual(first.rows[0].observedAt, first.rows[1].observedAt, 'microsecond cursors must not truncate to JavaScript milliseconds');

const allQuery = { until, limit: '2' };
let page = await queryMarketLineHistory(parse(allQuery), { sql }), collected = [...page.rows];
while (page.nextAfter) {
  page = await queryMarketLineHistory(parse({ ...allQuery, after: page.nextAfter }), { sql });
  assert.equal(page.totals.savedStates, 508); collected.push(...page.rows);
}
assert.equal(collected.length, 508); assert.equal(new Set(collected.map(row => JSON.stringify([row.observedAt, row.league, row.boardDate, row.gameKey]))).size, 508);
assert.deepEqual(collected.map(row => [row.observedAt, row.league, row.boardDate, row.gameKey]),
  inventory.filter(row => row.observed_at < '2026-10-14').sort((a, b) => compare(tuple(a), tuple(b))).map(tuple));

const nbaResult = await queryMarketLineHistory(parse({ league: 'NBA', until, gameKey: '19:30|LAL|GSW' }), { sql });
assert.equal(nbaResult.totals.savedStates, 2); assert.equal(nbaResult.totals.gameDateKeys, 2, 'same NBA matchup/time on different board days is two date keys');
assert.equal(nbaResult.totals.boardDates, 2); assert.equal(nbaResult.totals.firstBoardDate, '2026-10-08'); assert.equal(nbaResult.totals.lastBoardDate, '2026-10-09');
assert.equal(nbaResult.rows[0].markets[0].directions[1].pick, 'GSW讓2+50');
assert.equal(nbaResult.rows[0].markets[1].directions[0].pick, '大224-50');
assert.equal(nbaResult.rows[0].markets[1].directions[0].line, '224-50');
assert.equal(nbaResult.rows[0].markets[2].directions[0].pick, 'LAL讓1+20');
assert.equal(nbaResult.rows[0].markets[3].status, 'NOT_CAPTURED');
assert.equal(nbaResult.rows[0].gameLabel, 'LAL @ GSW 19:30');
const oneDay = await queryMarketLineHistory(parse({ league: 'NBA', date: '2026-10-09', until }), { sql });
assert.equal(oneDay.totals.savedStates, 1);
assert.deepEqual(parse({ date: '2026-10-09', until }).filters, parse({ from: '2026-10-09', through: '2026-10-09', until }).filters);
const fromOnly = await queryMarketLineHistory(parse({ from: '2026-10-09', until }), { sql });
const throughOnly = await queryMarketLineHistory(parse({ through: '2026-10-08', until }), { sql });
assert.equal(fromOnly.totals.savedStates, 1); assert.equal(throughOnly.totals.savedStates, 507);
const exact = expandMarketLineHistoryRow(makeRow('CPBL', '900', '2026-10-08T10:00:00.000001Z'));
assert.equal(exact.markets[0].directions[0].pick, '兄弟讓1+60'); assert.equal(exact.markets[0].directions[0].water, 1.06);
assert.equal(exact.markets[1].directions[0].pick, '大8+20'); assert.equal(exact.markets[2].status, 'NOT_CAPTURED');
const corrupt = await queryMarketLineHistory(parse({ league: 'CPBL', gameKey: '803', until }), { sql });
assert.equal(corrupt.totals.savedStates, 1); assert.equal(corrupt.rows[0].integrity.ok, false);
assert.ok(corrupt.rows[0].integrity.issues.includes('MARKETS_JSON_INVALID')); assert.equal(corrupt.rows[0].rawMarkets, '{not JSON');
assert.ok(corrupt.rows[0].markets.every(market => market.status === 'INVALID' && !market.directions.length));
for (const compact of [[['broken'], null, null, null], [null], [null, null, null, null]]) {
  assert.equal(expandMarketLineHistoryRow(makeRow('CPBL', '900', '2026-10-08T10:00:00.000001Z', compact)).integrity.ok, false);
}
const modified = makeRow('CPBL', '900', '2026-10-08T10:00:00.000001Z'); modified.state_hash = 'f'.repeat(16);
assert.ok(expandMarketLineHistoryRow(modified).integrity.issues.includes('STATE_HASH_MISMATCH'));
const empty = await queryMarketLineHistory(parse({ date: '2020-01-01', until }), { sql });
assert.equal(empty.totals.savedStates, 0); assert.equal(empty.rows.length, 0); assert.equal(empty.leagues.length, 0); assert.equal(empty.totals.firstBoardDate, null);

for (const invalid of [
  { league: '' }, { league: 'kbo' }, { league: 'NHL' }, { league: "KBO';DROP TABLE x;--" },
  { date: '2026-02-30' }, { from: '' }, { through: '2026-13-01' }, { from: '2026-10-09', through: '2026-10-08' },
  { date: '2026-10-08', from: '2026-10-08' }, { gameKey: '' }, { gameKey: ' x ' }, { gameKey: 'x'.repeat(81) },
  { gameKey: 'x\u0000' }, { limit: '0' }, { limit: '501' }, { limit: '1.5' }, { limit: '01' },
  { until: '2026-02-30T00:00:00.000Z' }, { until: '2026-10-14T02:00:00.000Z' }, { until: '2026-10-08T00:00:00Z' },
  { after: '' }, { after: 'bad' }, { after: 'x'.repeat(1500) }, { unknown: '1' },
]) assert.throws(() => parse({ until, ...invalid }), error => error.status === 400);
assert.throws(() => parseMarketLineHistoryQuery(new URLSearchParams('league=KBO&league=NBA'), { now }), error => error.status === 400);
assert.throws(() => parse({ league: 'NBA', until, after: first.nextAfter }), /範圍不一致/);
assert.throws(() => parse({ league: 'KBO', until, gameKey: '1', after: first.nextAfter }), /範圍不一致/);
assert.throws(() => parse({ league: 'KBO', until: '2026-10-13T00:00:00.000Z', after: first.nextAfter }), /截止時間/);
const [cursorPayload, cursorSignature] = first.nextAfter.split('.');
assert.throws(() => parse({ league: 'KBO', until, after: `${cursorPayload}.${cursorSignature[0] === 'a' ? 'b' : 'a'}${cursorSignature.slice(1)}` }), /無效/);
const futureCursor = createMarketLineHistoryCursor(makeRow('KBO', '1', '2026-10-15T00:00:00.000001Z'), parse({ league: 'KBO', until }));
assert.throws(() => parse({ league: 'KBO', until, after: futureCursor }), /內容錯誤/);

// A suspicious game key is bound literally; it never becomes SQL source.
const injectionKey = "1'; SELECT pg_sleep(30);--";
calls = [];
const escaped = await queryMarketLineHistory(parse({ league: 'KBO', until, gameKey: injectionKey }), { sql });
assert.equal(escaped.totals.savedStates, 0); assert.ok(calls[0].values.includes(injectionKey)); assert.ok(!calls[0].statement.includes(injectionKey));
await assert.rejects(queryMarketLineHistory(parse({ until }), { env: {} }), error => error.code === 'HISTORY_DATABASE_NOT_CONFIGURED');
databaseError = Object.assign(new Error('fixture table missing'), { code: '42P01' });
await assert.rejects(queryMarketLineHistory(parse({ until }), { sql }), error => error.code === 'HISTORY_TABLE_NOT_READY' && error.status === 503);
databaseError = new Error('fixture connection failed');
await assert.rejects(queryMarketLineHistory(parse({ until }), { sql }), error => error.code === 'HISTORY_READ_FAILED' && error.status === 503);
databaseError = null;

// Execute the actual route with real cookie auth and a mocked read-only DB boundary.
const source = readFileSync(new URL('../app/api/market-line-history/route.js', import.meta.url), 'utf8');
const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
let rateBlocked = false;
const services = { NextResponse, requireApiAuth, rateLimitResponse, MARKET_LINE_HISTORY_QUERY_HEADERS,
  checkRateLimit: () => ({ allowed: !rateBlocked, retryAfter: 60 }),
  parseMarketLineHistoryQuery, queryMarketLineHistory: query => queryMarketLineHistory(query, { sql }) };
const GET = new Function(...Object.keys(services), `${body}; return GET;`)(...Object.values(services));
const request = (params = {}, authenticated = true) => new Request(`http://localhost/api/market-line-history?${new URLSearchParams(params)}`, {
  headers: authenticated ? { cookie: `mlb_session=${token}` } : {},
});
calls = [];
assert.equal((await GET(request({ league: 'KBO', until }, false))).status, 401); assert.equal(calls.length, 0);
rateBlocked = true; assert.equal((await GET(request({ until }))).status, 429); assert.equal(calls.length, 0); rateBlocked = false;
assert.equal((await GET(request({ league: 'NHL', until }))).status, 400); assert.equal(calls.length, 0);
const success = await GET(request({ league: 'CPBL', until }));
assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'private, no-store');
assert.equal(success.headers.get('x-content-type-options'), 'nosniff'); assert.equal((await success.json()).totals.savedStates, 2);
databaseError = Object.assign(new Error('table not found'), { code: '42P01' });
const failure = await GET(request({ until })); assert.equal(failure.status, 503); assert.equal((await failure.json()).code, 'HISTORY_TABLE_NOT_READY');
assert.equal(failure.headers.get('cache-control'), 'private, no-store'); databaseError = null;
console.log('PASS: market line history authenticated read-only query, exact credits/waters, five-league counts, date identities, microsecond keyset pagination, signed filter-bound cursors and honest corruption/database errors');
