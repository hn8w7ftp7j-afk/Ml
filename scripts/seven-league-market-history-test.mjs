import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { parseMarketLineHistoryQuery, queryMarketLineHistory } from '../lib/market-line-history-query.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { soccerJournalHash } from '../lib/soccer/journal.js';

const db = new PGlite();
const statements = [];
const sql = async (strings, ...values) => {
  const text = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(text, /\b(?:bets|sports_soccer_bets|bet_records)\b/i, 'history must never depend on a placed bet');
  statements.push(text);
  return (await db.query(text, values)).rows;
};
const now = Date.parse('2026-11-06T12:00:00.000Z');
const options = { now, secret: 'seven-league-local-cursor-signing-secret' };
const read = params => queryMarketLineHistory(parseMarketLineHistoryQuery(new URLSearchParams(params), options), { sql });
const date = '2026-11-06', observedAt = '2026-11-05T21:00:00.000Z';
const market = (period, kind = 'HANDICAP', line = '1+60') => ({ period, kind, unit: 'GOALS', line,
  ...(kind === 'HANDICAP' ? { lineSide: 'away', awayWater: 0.95, homeWater: 1.05 } : { overWater: 0.94, underWater: 0.96 }),
  rawRows: ['原始第一列', '原始第二列'], periodEvidence: { period, source: 'MARKET_HEADER' } });
const game = (suffix = '', markets = [market('FT'), market('FT', 'TOTAL', '3-80')]) => ({ league: 'EPL', boardDate: date,
  boardTime: '03:00', awayKey: `arsenal${suffix}`, homeKey: `man-city${suffix}`, awayCode: 'ARS', homeCode: 'MCI', markets,
  periodsCovered: [...new Set(markets.map(m => m.period))], periodStates: Object.fromEntries(markets.map(m => [m.period, 'open'])) });
async function observation(games, overrides = {}) {
  const payload = { league: games[0]?.league || 'EPL', boardDate: date, observedAt, readerVersion: '2.1.54',
    games, periodsCovered: [...new Set(games.flatMap(g => g.periodsCovered))], ...overrides.payload };
  payload.contentHash = createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex');
  const id = soccerJournalHash(payload);
  await db.query('INSERT INTO sports_soccer_reader_observations_v2 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, payload.league, payload.boardDate, payload.contentHash, payload.observedAt,
      overrides.receivedAt || payload.observedAt, overrides.persistedAt || payload.observedAt, JSON.stringify(payload)]);
  return id;
}
try {
  await db.exec(`CREATE TABLE tai888_market_line_history_v1 (league text,board_date date,game_key text,game_pk bigint,
    observed_at timestamptz,state_hash text,markets text,source_hash text,reader_version text);
    CREATE TABLE sports_soccer_reader_observations_v2 (observation_id text PRIMARY KEY,league text,board_date date,
    content_hash text,source_observed_at timestamptz,received_at timestamptz,persisted_at timestamptz,payload jsonb);`);
  const compact = JSON.stringify([['away受讓1平', 0.95, 'home讓1平', 1.05], null, null, null]);
  for (const [index, league] of ['MLB', 'NPB', 'KBO', 'CPBL'].entries()) await db.query(
    'INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [league, date, String(index + 1), index + 1, observedAt, createHash('sha256').update(compact).digest('hex').slice(0, 16), compact, null, '2.1.54']);
  const nba = JSON.stringify([[1, '3+50', 0.95, 1.05], ['224-50', 0.94, 0.96], null, null]);
  await db.query('INSERT INTO tai888_market_line_history_v1 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    ['NBA', date, '07:05|BKN|CHA', null, observedAt, createHash('sha256').update(nba).digest('hex').slice(0, 16), nba, null, '2.1.54']);
  const ftId = await observation([game()]);
  const htId = await observation([game('', [market('HT'), market('HT', 'TOTAL', '1.5')])]);
  const multiId = await observation([game('-multi', [market('FT'), market('FT', 'HANDICAP', '1.5')])]);
  const locked = { ...game('-locked', []), periodsCovered: ['HT'], periodStates: { HT: 'locked' }, marketStatus: 'locked' };
  await observation([locked]);
  await observation([{ ...game('-unknown', [market('UNKNOWN')]), periodsCovered: ['UNKNOWN'] }]);
  await observation([{ ...game('-ucl'), league: 'UCL' }]);
  const repeatedGame = game('-repeat');
  await observation([repeatedGame, repeatedGame]); // Identical key/time remains two original source entries.
  const corruptId = await observation([game('-corrupt')]);
  await db.query("UPDATE sports_soccer_reader_observations_v2 SET payload=jsonb_set(payload,'{games,0,markets,0,line}','\"99.5\"'::jsonb) WHERE observation_id=$1", [corruptId]);
  await observation([game('-future')], { persistedAt: '2026-11-07T00:00:00.000Z' });
  const all = await read({ limit: '2' });
  assert.equal(all.totals.savedStates, 14); assert.equal(all.totals.gameDateKeys, 12);
  assert.deepEqual(all.leagues.map(row => row.league).sort(), ['CPBL', 'EPL', 'KBO', 'MLB', 'NBA', 'NPB', 'UCL']);
  assert.equal(all.leagues.find(row => row.league === 'EPL').countUnit, 'READER_GAME_OBSERVATIONS');
  assert.equal(all.leagues.find(row => row.league === 'NBA').countUnit, 'CHANGED_STATES');
  assert.equal(all.productionWrites, false); assert.equal(all.coverageComplete, false);
  assert.deepEqual(all.sourceTables, ['tai888_market_line_history_v1', 'sports_soccer_reader_observations_v2']);
  const rows = [...all.rows]; let page = all;
  while (page.nextAfter) {
    page = await read({ limit: '2', after: page.nextAfter }); rows.push(...page.rows);
    assert.equal(page.totals.savedStates, 14);
  }
  const key = row => JSON.stringify([row.observedAt, row.league, row.boardDate, row.gameKey, row.recordId]);
  assert.equal(rows.length, 14); assert.equal(new Set(rows.map(key)).size, 14, 'same timestamp and matchup observations must not be skipped or merged');
  assert.equal(rows.filter(row => row.gameKey.endsWith('man-city-repeat')).length, 2);
  assert.ok(rows.filter(row => !['EPL', 'UCL'].includes(row.league)).every(row => row.integrity.ok));
  const epl = await read({ league: 'EPL', date, gameKey: '03:00|arsenal|man-city' });
  assert.equal(epl.rows.length, 2); assert.ok(epl.rows.every(row => row.integrity.ok));
  const ft = epl.rows.find(row => row.observationId === ftId), ht = epl.rows.find(row => row.observationId === htId);
  assert.deepEqual(ft.markets.map(row => row.status), ['AVAILABLE', 'AVAILABLE', 'NOT_CAPTURED', 'NOT_CAPTURED']);
  assert.deepEqual(ht.markets.map(row => row.status), ['NOT_CAPTURED', 'NOT_CAPTURED', 'AVAILABLE', 'AVAILABLE']);
  assert.equal(ft.markets[0].directions[0].pick, 'ARS讓1+60'); assert.equal(ft.markets[1].directions[0].pick, '大3-80');
  assert.equal(ft.markets[0].directions[1].water, 1.05); assert.equal(ht.markets[3].directions[0].line, '1.5');
  assert.equal(ft.recordKind, 'READER_OBSERVATION'); assert.equal(ft.observationId, ftId); assert.match(ft.recordId, /^[a-f0-9]{64}:1$/);
  assert.equal(ft.identityBasis, 'READER_BOARD_TIME_AND_TEAM_KEYS'); assert.ok(ft.receivedAt && ft.persistedAt);
  const multi = rows.find(row => row.observationId === multiId);
  assert.equal(multi.markets[0].directions.length, 4); assert.equal(multi.markets[0].contracts.length, 2);
  assert.deepEqual(multi.markets[0].contracts[0].rawRows, ['原始第一列', '原始第二列']);
  const lockedRead = rows.find(row => row.gameKey.endsWith('man-city-locked'));
  assert.equal(lockedRead.markets[2].status, 'LOCKED'); assert.equal(lockedRead.markets[3].status, 'LOCKED');
  const unknown = rows.find(row => row.gameKey.endsWith('man-city-unknown'));
  assert.ok(unknown.markets.every(row => row.status === 'PERIOD_UNKNOWN')); assert.equal(unknown.integrity.ok, false);
  assert.ok(unknown.integrity.issues.includes('PERIOD_UNKNOWN')); assert.match(unknown.rawMarkets, /UNKNOWN/);
  const corrupted = rows.find(row => row.observationId === corruptId);
  assert.equal(corrupted.integrity.ok, false); assert.ok(corrupted.integrity.issues.includes('SOURCE_PAYLOAD_HASH_MISMATCH'));
  assert.ok(corrupted.markets.every(row => row.status === 'INVALID')); assert.match(corrupted.rawMarkets, /99.5/);
  assert.ok(!rows.some(row => row.gameKey.includes('future')));
  const longKey = '03:00|' + 'a'.repeat(90) + '|man-city';
  assert.doesNotThrow(() => parseMarketLineHistoryQuery(new URLSearchParams({ league: 'EPL', gameKey: longKey }), options));
  assert.throws(() => parseMarketLineHistoryQuery(new URLSearchParams({ league: 'NBA', gameKey: longKey }), options));

  // Broken/empty saved source observations stay discoverable as invalid source
  // records. They cannot silently disappear or pretend to identify a match.
  const emptySourceId = await observation([], { payload: { league: 'EPL', marker: 'empty-source' } });
  const malformedSourceId = await observation([game('-broken-shape')]);
  await db.query("UPDATE sports_soccer_reader_observations_v2 SET payload=jsonb_set(payload,'{games}','{}'::jsonb) WHERE observation_id=$1", [malformedSourceId]);
  const unresolved = (await read({ league: 'EPL', limit: '50' })).rows.filter(row => row.gameKey.startsWith('UNRESOLVED:'));
  assert.equal(unresolved.length, 2);
  assert.deepEqual(unresolved.map(row => row.observationId).sort(), [emptySourceId, malformedSourceId].sort());
  for (const row of unresolved) {
    assert.equal(row.gameLabel, '無法辨識場次之原始觀測'); assert.equal(row.identityBasis, 'UNRESOLVED_SOURCE_RECORD');
    assert.equal(row.integrity.ok, false); assert.ok(row.integrity.issues.includes('SOCCER_GAME_KEY_INVALID'));
    assert.ok(row.integrity.issues.includes('MARKETS_SHAPE_INVALID')); assert.ok(row.contentHash && row.observationId);
    assert.ok(row.markets.every(market => market.status === 'INVALID'));
    const exactSource = await read({ league: 'EPL', gameKey: row.gameKey }); assert.equal(exactSource.rows.length, 1);
  }
  assert.ok(statements.length > 1);
  console.log('PASS: real PostgreSQL seven-league query, original FT/HT credit strings and waters, immutable source hashes, all-game unbet history, microsecond/tied-observation cursors, mixed count units, multi-contract/lock/unknown/corrupt evidence and frozen persistence cutoff; NOT Production');
} finally { await db.close(); }
