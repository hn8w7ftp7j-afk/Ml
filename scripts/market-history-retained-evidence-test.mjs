import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildMarketLineHistoryRows } from '../lib/market-line-history-v1.js';
import { buildMarketCaptureReceipt } from '../lib/market-capture-receipts.js';
import { parseMarketHistoryCoverageQuery, queryMarketHistoryCoverage } from '../lib/market-history-coverage.js';
import { parseMarketLineHistoryQuery, queryMarketLineHistory } from '../lib/market-line-history-query.js';
import { validateCoverageDisplay } from '../app/market-line-history/coverage-display.js';

const db = new PGlite();
const now = Date.parse('2026-11-09T02:00:00.000Z');
const sql = async (strings, ...values) => {
  const statement = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(statement, /\b(?:bets|bet_records|sports_soccer_bets)\b/i);
  return (await db.query(statement, values)).rows;
};
const spread = line => ({ line, lineSide: 'home', awayWater: 0.95, homeWater: 1.05 });
const total = line => ({ line, overWater: 0.96, underWater: 0.94 });
const game = { boardTime: '09:05', awayCode: 'NY', homeCode: 'CLE',
  fullRunline: spread('3+50'), fullTotal: total('221-80'),
  firstHalfRunline: spread('1+25'), firstHalfTotal: total('110.5') };
async function save(at, games, { boardDate = '2026-11-08', unopenedGames = [] } = {}) {
  const snapshot = { league: 'NBA', boardDate, observedAt: at, pageActivityAt: at, readerVersion: '2.1.58', games, unopenedGames };
  for (const row of buildMarketLineHistoryRows(snapshot)) {
    await db.query('INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', Object.values(row));
  }
  const receipt = buildMarketCaptureReceipt(snapshot);
  await db.query('INSERT INTO tai888_market_capture_receipts_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [receipt.receiptId, receipt.league, receipt.boardDate, receipt.sourceObservedAt, receipt.pageActivityAt,
      at, at, receipt.sourceHash, receipt.readerVersion, receipt.gamesFormat, JSON.stringify(receipt.games)]);
  return receipt;
}
const read = params => queryMarketHistoryCoverage(parseMarketHistoryCoverageQuery(new URLSearchParams({ league: 'NBA', ...params }),
  { now, secret: 'synthetic-retained-market-cursor-secret' }), { sql });
try {
  await db.exec(`CREATE TABLE tai888_market_line_history_v1 (
    league text,board_date date,game_key text,game_pk bigint,observed_at timestamptz,
    state_hash text,markets text,source_hash text,reader_version text);
    CREATE TABLE tai888_market_capture_receipts_v1 (
    receipt_id text,league text,board_date date,source_observed_at timestamptz,page_activity_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,source_hash text,reader_version text,games_format text,games jsonb);
    CREATE TABLE sports_soccer_reader_observations_v2 (
    observation_id text,league text,board_date date,content_hash text,source_observed_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,payload jsonb);`);
  const first = await save('2026-11-08T00:00:00.000Z', [game]);
  await save('2026-11-08T00:01:00.000Z', [{ ...game, firstHalfRunline: null, firstHalfTotal: null }]);
  await save('2026-11-08T00:02:00.000Z', [{ ...game, marketStatus: 'locked' }]);
  await save('2026-11-08T00:03:00.000Z', [], { unopenedGames: [{ ...game, boardTime: '09:00',
    fullRunline: null, fullTotal: null, firstHalfRunline: null, firstHalfTotal: null, unavailableReason: 'not-rendered-by-reader' }] });
  await save('2026-11-09T00:00:00.000Z', [{ ...game, marketStatus: 'locked' }], { boardDate: '2026-11-09' });
  let result = await read({ limit: '500' });
  let row = result.games.find(item => item.boardDate === '2026-11-08' && item.gameKey === '09:05|NY|CLE');
  assert.deepEqual(row.markets.map(market => market.status), ['AVAILABLE', 'AVAILABLE', 'NOT_CAPTURED', 'NOT_CAPTURED'], 'latest immutable state remains unchanged');
  assert.ok(row.latestCaptureMarkets.every(market => market.status === 'LOCKED'), 'latest capture remains locked');
  assert.ok(row.retainedMarkets.every(market => market.status === 'AVAILABLE'), 'later partial/locked captures cannot hide previously retained half markets');
  assert.deepEqual(row.retainedMarkets.map(market => market.lastObservedAt), [
    '2026-11-08T00:01:00.000Z', '2026-11-08T00:01:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-08T00:00:00.000Z']);
  assert.equal(row.retainedMarkets[2].evidence.receiptId, first.receiptId);
  assert.equal(row.retainedMarkets[2].evidence.directions[0].line, '1+25');
  assert.equal(row.retainedMarkets[3].evidence.directions[1].water, 0.94);
  assert.equal(row.retainedEvidenceIntegrity.status, 'PASS');
  assert.equal(row.retainedHistoryComplete, false, 'a per-market evidence list is not a simultaneous quote or complete legacy scan');
  assert.ok(result.games.filter(item => item !== row).every(item => item.retainedMarkets.every(market => market.status === 'NOT_VERIFIED')),
    'same teams five minutes apart or on another date are not silently merged without authoritative identity evidence');
  assert.deepEqual(row.relatedIdentityCandidates, [{ gameKey: '09:00|NY|CLE', status: 'NOT_VERIFIED', basis: 'SAME_BOARD_DATE_AND_ORDERED_TEAM_CODES' }]);
  assert.deepEqual(result.games.find(item => item.gameKey === '09:00|NY|CLE').relatedIdentityCandidates,
    [{ gameKey: '09:05|NY|CLE', status: 'NOT_VERIFIED', basis: 'SAME_BOARD_DATE_AND_ORDERED_TEAM_CODES' }],
    'receipt-only time variants link to retained quotes without inheriting their availability');
  assert.equal(result.games.find(item => item.boardDate === '2026-11-09').relatedIdentityCandidates, undefined, 'candidate discovery is isolated by board date');
  assert.equal(result.coverageComplete, false); assert.equal(result.closingCoverage, 'NOT_VERIFIED');
  assert.doesNotThrow(() => validateCoverageDisplay(result.games));
  for (const mutation of [copy => { copy.retainedHistoryComplete = true; },
    copy => { copy.retainedMarkets[2].evidence.gameKey = '09:00|NY|CLE'; },
    copy => { copy.retainedMarkets[2].lastObservedAt = '2026-11-08T00:02:00.000Z'; },
    copy => { copy.retainedMarkets[2].evidence.directions[0].water = null; }]) {
    const copy = structuredClone(row); mutation(copy);
    assert.throws(() => validateCoverageDisplay([copy]), /來源證據不完整/);
  }
  for (const mutation of [copy => { copy.relatedIdentityCandidates[0].status = 'PASS'; },
    copy => { copy.relatedIdentityCandidates[0].gameKey = '09:00|CLE|NY'; },
    copy => { copy.relatedIdentityCandidates.push(copy.relatedIdentityCandidates[0]); }]) {
    const copy = structuredClone(row); mutation(copy);
    assert.throws(() => validateCoverageDisplay([copy]), /未合併為同一場/);
  }
  const expected = result.games.map(item => `${item.boardDate}|${item.gameKey}`);
  const loaded = [];
  let page = await read({ limit: '1' });
  for (;;) {
    loaded.push(...page.games.map(item => `${item.boardDate}|${item.gameKey}`));
    if (!page.nextAfter) break;
    page = await read({ limit: '1', until: page.until, after: page.nextAfter });
  }
  assert.deepEqual(loaded, expected, 'separate retained evidence cannot change identity pagination');
  // Legacy changed-state archives predate receipt capture. An earlier half
  // quote is still fully retrievable even if this bounded reference lookup
  // cannot establish it from the latest partial state. Unknown is not absent.
  for (const [observedAt, half] of [['2026-11-07T00:00:00.000Z', true], ['2026-11-07T00:01:00.000Z', false]]) {
    const snapshot = { league: 'NBA', boardDate: '2026-11-07', observedAt, readerVersion: '2.1.43',
      games: [{ ...game, firstHalfRunline: half ? game.firstHalfRunline : null, firstHalfTotal: half ? game.firstHalfTotal : null }] };
    for (const state of buildMarketLineHistoryRows(snapshot)) {
      await db.query('INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', Object.values(state));
    }
  }
  const legacy = (await read({ date: '2026-11-07' })).games[0];
  assert.deepEqual(legacy.retainedMarkets.map(market => market.status), ['AVAILABLE', 'AVAILABLE', 'NOT_VERIFIED', 'NOT_VERIFIED']);
  assert.equal(legacy.retainedHistoryComplete, false);
  const legacyHistory = await queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams({
    league: 'NBA', date: '2026-11-07', gameKey: '09:05|NY|CLE' }), { now, secret: 'synthetic-legacy-timeline-secret' }), { sql });
  assert.equal(legacyHistory.hasMore, false); assert.equal(legacyHistory.rows.length, 2);
  assert.ok(legacyHistory.rows[0].markets.every(market => market.status === 'AVAILABLE'), 'legacy half quotes remain accessible through the complete per-game timeline');
  assert.equal(legacyHistory.rows[0].markets[2].directions[0].line, '1+25');
  assert.equal(legacyHistory.rows[0].markets[3].directions[1].water, 0.94);
  const mislabeled = structuredClone(legacy); mislabeled.retainedMarkets[2].status = 'NOT_CAPTURED';
  assert.throws(() => validateCoverageDisplay([mislabeled]), /來源證據不完整/, 'a limited lookup must not claim an unscanned legacy market was not captured');
  await db.query("UPDATE tai888_market_line_history_v1 SET markets='invalid json' WHERE observed_at=$1", ['2026-11-08T00:00:00.000Z']);
  result = await read({ date: '2026-11-08' });
  row = result.games.find(item => item.gameKey === '09:05|NY|CLE');
  assert.deepEqual(row.retainedMarkets.map(market => market.status), ['AVAILABLE', 'AVAILABLE', 'NOT_VERIFIED', 'NOT_VERIFIED']);
  assert.equal(row.retainedEvidenceIntegrity.status, 'PARTIAL');
  assert.ok(row.retainedEvidenceIntegrity.issues.includes('CAPTURE_STATE_REFERENCE_INVALID'));
  assert.ok(row.latestCaptureMarkets.every(market => market.status === 'LOCKED'));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM tai888_market_line_history_v1')).rows[0].count, 4);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM tai888_market_capture_receipts_v1')).rows[0].count, 5);
  console.log('PASS: per-market retained quote evidence survives later partial/locked captures; verifies exact receipt/state hash, times, line/water, read-only identity/date/page isolation, UI proof and corrupted old evidence; NOT Production');
} finally { await db.close(); }
