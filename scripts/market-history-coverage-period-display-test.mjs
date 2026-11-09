import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { PGlite } from '@electric-sql/pglite';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';
import { soccerJournalHash } from '../lib/soccer/journal.js';
import { parseMarketHistoryCoverageQuery, queryMarketHistoryCoverage } from '../lib/market-history-coverage.js';
import { coverageMarketsForDisplay, nbaHistoricalAvailabilityLabel, validateCoverageDisplay } from '../app/market-line-history/coverage-display.js';
import { taipeiHistoryTime } from '../app/market-line-history/history-view.js';

for (const [capture, expected] of [
  [{ status: 'LOCKED', availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' }, '來源明示鎖盤'],
  [{ status: 'NOT_CAPTURED', availabilityEvidence: 'NO_PARSED_MARKETS' }, '未讀到價格'],
  [{ status: 'LOCKED' }, '來源標記鎖盤，實際狀態未確認'],
  [{ status: 'NOT_CAPTURED' }, null],
  [{ status: 'INVALID', availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' }, null],
  [{ status: 'AVAILABLE', availabilityEvidence: 'NO_PARSED_MARKETS' }, null],
]) {
  const before = JSON.stringify(capture);
  assert.equal(nbaHistoricalAvailabilityLabel('NBA', capture), expected);
  assert.equal(nbaHistoricalAvailabilityLabel('MLB', capture), null, 'NBA evidence labels cannot change other leagues');
  assert.equal(JSON.stringify(capture), before);
}

// Render the real coverage panel: new read labels coexist with original
// statuses, immutable quote evidence and the older soccer interpretation UI.
const marketNames = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
const fixtureAt = '2026-11-08T01:00:00.000Z';
const fixtureMarkets = [
  { status: 'LOCKED', availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' },
  { status: 'NOT_CAPTURED', availabilityEvidence: 'NO_PARSED_MARKETS' },
  { status: 'LOCKED' },
  { status: 'INVALID', availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' },
].map((market, index) => ({ market: marketNames[index], lastObservedAt: fixtureAt, ...market }));
const fixtureGame = { league: 'NBA', boardDate: '2026-11-08', gameKey: '09:00|LAL|GSW',
  lastReaderObservedAt: fixtureAt, captureStatus: 'NOT_CAPTURED', integrity: { status: 'PASS' },
  markets: fixtureMarkets, latestCaptureMarkets: fixtureMarkets,
  retainedHistoryComplete: false, retainedLookupBasis: 'LATEST_STATE_AND_PER_MARKET_RECEIPT_REFERENCES',
  retainedMarkets: marketNames.map((market, index) => index === 1 ? { market, status: 'AVAILABLE', lastObservedAt: fixtureAt,
    evidence: { observedAt: fixtureAt, gameKey: '09:00|LAL|GSW', sourceTable: 'tai888_market_line_history_v1',
      stateHash: 'b'.repeat(16), directions: [{ pick: '大220平', water: 0.95 }, { pick: '小220平', water: 0.94 }] } }
    : { market, status: 'NOT_VERIFIED', lastObservedAt: null }) };
const fixture = { ok: true, schema: 'market-history-coverage-v1', status: 'PASS', until: fixtureAt, leagues: [], sources: [],
  games: [fixtureGame, { league: 'MLB', boardDate: '2026-11-08', gameKey: '123', integrity: { status: 'PASS' },
    markets: [{ market: '全場讓分', status: 'LOCKED', availabilityEvidence: 'EXPLICIT_SOURCE_LOCK' }] }] };
const fixtureBefore = JSON.stringify(fixture);
const panelSource = fs.readFileSync('app/market-line-history/coverage-panel.js', 'utf8');
const { code: panelCode } = await transform(panelSource.replace(/^import .*?;\n/gm, '').replace(/export default function/g, 'function'), {
  filename: 'coverage-panel.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
let stateIndex = 0;
const panelScope = vm.createContext({ React, URLSearchParams, styles: {}, taipeiHistoryTime, coverageMarketsForDisplay, nbaHistoricalAvailabilityLabel, validateCoverageDisplay,
  useState: () => [[fixture, '', false][stateIndex++], () => {}], useRef: value => ({ current: value }),
  useCallback: fn => fn, useEffect: () => {} });
vm.runInContext(panelCode, panelScope);
assert.equal(panelScope.validateCoverage(fixture), fixture);
const panelHtml = renderToStaticMarkup(panelScope.CoveragePanel());
assert.match(panelHtml, /全場讓分｜最近讀盤：來源明示鎖盤/);
assert.match(panelHtml, /全場大小｜最近讀盤：未讀到價格/);
assert.match(panelHtml, /上半讓分｜最近讀盤：來源標記鎖盤，實際狀態未確認/);
assert.match(panelHtml, /上半大小｜最近讀盤：內容異常/);
assert.match(panelHtml, /全場讓分｜最近版本：鎖盤/, 'non-NBA labels retain existing semantics');
assert.match(panelHtml, /歷來有保存｜原盤觀測/);
assert.match(panelHtml, /最新觀測狀態不代表舊盤遺失/);
assert.equal(coverageMarketsForDisplay(fixtureGame), fixtureGame.latestCaptureMarkets);
assert.equal(JSON.stringify(fixture), fixtureBefore, 'UI labels cannot mutate original market/capture statuses or retained source evidence');

const db = new PGlite();
const now = Date.parse('2026-11-08T02:00:00.000Z');
const observedAt = '2026-11-06T21:58:20.351Z';
const boardDate = '2026-11-07';
const sql = async (strings, ...values) => {
  const text = strings.reduce((out, part, index) => out + (index ? `$${index}` : '') + part, '');
  assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(text, /\b(?:bets|bet_records|sports_soccer_bets)\b/i);
  return (await db.query(text, values)).rows;
};
function payloadFor({ time = '04:00', includeHalf = true, onlyHalf = false, at = observedAt } = {}) {
  const sectionTitle = '聯盟: 英格蘭超級聯賽(25)';
  const full = { headers: ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '單雙', '備註'],
    sectionTitle, rows: [{ cells: [{ pair: ['11-07', time] }, { pair: ['高雲地利', '愛華頓[主]'] },
      { pair: ['1.050', '1+50 0.750'] }, { pair: ['大3+50 0.930', '小 0.890'] },
      { pair: ['主勝 0.550', '和 3.050', '客勝 3.700'] }] }] };
  const half = { headers: ['時間', '主客隊伍', '上半讓球', '上半大小', '', '單雙', '備註'],
    sectionTitle, rows: [{ cells: [{ pair: ['11-07', time] }, { pair: ['高雲地利', '愛華頓[主]'] },
      { pair: ['1.080', '0-50 0.800'] }, { pair: ['大1-50 1.110', '小 0.760'] }, { pair: ['主勝 -', '和 -', '客勝 -'] }] }] };
  const capture = { league: 'EPL', pageLeagueLabel: sectionTitle, sourceHost: 'www.tai888.in',
    pageUrl: 'https://www.tai888.in/newapp/', observedAt: at,
    tables: [...(!onlyHalf ? [full] : []), ...(includeHalf ? [half] : [])] };
  const wire = { ...parseSoccerCapture(capture, new Date(at)), readerVersion: '2.1.56', pageActivityAt: at };
  const checked = validateSoccerCapture(wire, { now: Date.parse(at) + 1000, headerVersion: '2.1.56' });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return { ...checked.payload, deviceId: 'synthetic-coverage-reader' };
}
async function save(payload) {
  payload.contentHash = createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex');
  const id = soccerJournalHash(payload);
  await db.query('INSERT INTO sports_soccer_reader_observations_v2 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, payload.league, payload.boardDate, payload.contentHash, payload.observedAt,
      payload.observedAt, payload.observedAt, JSON.stringify(payload)]);
  return id;
}
const read = () => queryMarketHistoryCoverage(parseMarketHistoryCoverageQuery(new URLSearchParams({ league: 'EPL', date: boardDate }),
  { now, secret: 'synthetic-history-display-cursor-key' }), { sql, now });
try {
  await db.exec(`CREATE TABLE sports_soccer_reader_observations_v2 (
    observation_id text,league text,board_date date,content_hash text,source_observed_at timestamptz,
    received_at timestamptz,persisted_at timestamptz,payload jsonb);`);
  const original = payloadFor();
  const originalText = JSON.stringify(original);
  const id = await save(original);
  let result = await read();
  assert.equal(result.ok, true); assert.equal(result.productionWrites, false); assert.equal(result.coverageComplete, false);
  let game = result.games[0];
  assert.equal(game.gameLabel, '高雲地利 @ 愛華頓[主] 04:00');
  assert.deepEqual(game.markets.map(m => m.status), ['PERIOD_UNKNOWN', 'PERIOD_UNKNOWN', 'AVAILABLE', 'AVAILABLE']);
  assert.deepEqual(game.displayMarkets.map(m => m.status), ['RETROSPECTIVE_INTERPRETATION', 'RETROSPECTIVE_INTERPRETATION', 'AVAILABLE', 'AVAILABLE']);
  assert.equal(game.integrity.status, 'NOT_VERIFIED', 'a display interpretation does not rewrite source integrity');
  assert.equal(game.closingCoverage, 'NOT_VERIFIED');
  for (const market of game.displayMarkets.slice(0, 2)) {
    assert.equal(market.lastObservedAt, observedAt);
    assert.equal(market.historyPeriodInterpretation.interpretedAt, new Date(now).toISOString());
    assert.equal(market.historyPeriodInterpretation.executable, false);
    assert.equal(market.historyPeriodInterpretation.historicalAvailabilityVerified, false);
    assert.equal(market.historyPeriodInterpretation.observationId, id);
  }
  assert.equal(coverageMarketsForDisplay(game), game.displayMarkets);
  assert.doesNotThrow(() => validateCoverageDisplay([game]));
  assert.equal(JSON.stringify(original), originalText, 'read-only overlay cannot mutate the source payload');
  const stored = (await db.query('SELECT payload FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1', [id])).rows[0].payload;
  assert.equal(soccerJournalHash(stored), id, 'original source hash remains valid');
  assert.ok(stored.games[0].markets.some(m => m.period === 'UNKNOWN'));

  for (const mutate of [
    row => { row.displayMarkets[0].status = 'AVAILABLE'; },
    row => { row.displayMarkets[0].historyPeriodInterpretation.executable = true; },
    row => { row.displayMarkets[0].historyPeriodInterpretation.historicalAvailabilityVerified = true; },
    row => { row.displayMarkets[0].historyPeriodInterpretation.interpretedAt = ''; },
    row => { row.displayMarkets[0].historyPeriodInterpretation.interpretedAt = '2026-11-01T00:00:00.000Z'; },
    row => { row.displayMarkets[0].originalStatus = 'AVAILABLE'; },
    row => { row.integrity.status = 'FAIL'; },
    row => { row.league = 'NBA'; },
  ]) {
    const changed = structuredClone(game); mutate(changed);
    assert.throws(() => validateCoverageDisplay([changed]), /不完整/);
  }
  const legacy = { markets: game.markets };
  assert.equal(coverageMarketsForDisplay(legacy), legacy.markets);
  const current = { ...game, latestCaptureMarkets: game.markets };
  assert.equal(coverageMarketsForDisplay(current), current.latestCaptureMarkets, 'current receipt states retain precedence');

  // Two separately saved observations cannot manufacture a same-capture proof.
  await save(payloadFor({ time: '05:00', includeHalf: false }));
  await save(payloadFor({ time: '05:00', onlyHalf: true, at: '2026-11-06T22:00:00.000Z' }));
  result = await read();
  const separate = result.games.find(g => g.gameKey.startsWith('05:00|'));
  assert.equal(separate.displayMarkets, undefined);
  assert.deepEqual(separate.markets.map(m => m.status), ['PERIOD_UNKNOWN', 'PERIOD_UNKNOWN', 'AVAILABLE', 'AVAILABLE']);

  await db.query("UPDATE sports_soccer_reader_observations_v2 SET payload=jsonb_set(payload,'{games,0,markets,0,line}','\"99.5\"'::jsonb) WHERE observation_id=$1", [id]);
  result = await read(); game = result.games.find(g => g.gameKey.startsWith('04:00|'));
  assert.equal(game.integrity.status, 'FAIL');
  assert.equal(game.displayMarkets, undefined, 'corruption cannot be hidden by an interpreted display');
  assert.ok(game.markets.every(m => m.status === 'INVALID'));
  console.log('PASS: PostgreSQL coverage displays same-observation retrospective FT separately, preserves UNKNOWN/source hashes/times/closing status, rejects cross-observation and corrupt evidence, and validates non-executable UI metadata; NOT Production');
} finally { await db.close(); }
