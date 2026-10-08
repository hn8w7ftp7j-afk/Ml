import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, parseReaderMarketRows } from '../reader/parser.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
import { buildNbaShadowRanking } from '../lib/nba/shadow-ranking.js';

const now = Date.parse('2026-10-08T15:31:00Z'), observedAt = new Date(now).toISOString();
const cell = pair => ({ pair });
const capture = total => ({ league: 'NBA', sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/newapp/#/BS', observedAt,
  tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小'], rows: [{ cells: [cell(['10-09', '08:05']),
    cell(['ATL-老鷹', 'SA-馬刺[主]']), cell(['0.950', '9.5 0.950']), cell([`${total} 大 0.940`, '小 0.940'])] }] }],
  diagnostics: { expectedGameCount: 1, lastMutationAt: observedAt } });
function payload(total) {
  const parsed = parseTai888Capture(capture(total), new Date(now));
  const value = { ...parsed, readerVersion: '2.1.29', deviceId: 'synthetic-fragment-device', pageActivityAt: observedAt,
    expectedGameCount: 1, detectedGameCount: 1 };
  value.payloadHash = createHash('sha256').update(canonicalReaderPayload(value)).digest('hex');
  return value;
}
const normalize = value => normalizeNbaReaderPayload(value, { now, deviceId: value.deviceId });
for (const text of ['224-50', '224 -50', '224- 50', '224 - 50', '224 − 50', '224 －50']) {
  const input = payload(text);
  assert.equal(input.games[0].fullTotal.line, '224-50', text);
  assert.equal(normalize(input).games[0].fullTotal.line, '224-50', text);
}
for (const text of ['224平 -50', '224平 224-50', '224-50 225-50', '224 -', '224 +']) {
  const parsed = parseTai888Capture(capture(text), new Date(now));
  assert.equal(parsed.games[0].fullTotal, null, text);
  assert.equal(parsed.games[0].marketStates.fullTotal, 'BLOCKED', text);
}
for (const [text, line] of [['224 平', '224平'], ['224 + 50', '224+50'], ['224.5', '224.5'], ['224/224.5', '224/224.5']]) {
  assert.equal(normalize(payload(text)).games[0].fullTotal.line, line);
}
assert.equal(parseReaderMarketRows('fullRunline', ['0.950', '9 - 50 0.950']).line, '9-50');
assert.equal(parseReaderMarketRows('fullRunline', ['9平 -50 0.950', '0.950']), null);
assert.equal(parseReaderMarketRows('fullTotal', ['224-50 大 0.940', '225-50 小 0.940']), null);
// The hash covers the contract. Even a rehashed incorrect contract must not
// pass when captured evidence still says 224-50.
const tampered = payload('224 -50');
tampered.games[0].fullTotal.line = '224平';
tampered.payloadHash = createHash('sha256').update(canonicalReaderPayload(tampered)).digest('hex');
assert.throws(() => normalize(tampered), error => error.code === 'NBA_READER_MARKET_EVIDENCE_MISMATCH');
const game = { league: 'NBA', id: 'nba:espn:game:401999001', sourceId: '401999001', seasonType: 'preseason',
  season: { year: 2027 }, taipeiDate: '2026-10-09', startTime: '2026-10-09T00:00:00Z',
  home: { id: 'nba:espn:team:24' }, away: { id: 'nba:espn:team:1' } };
const snapshot = normalize(payload('224 -50'));
const quote = { fullTotal: snapshot.games[0].fullTotal, fullRunline: snapshot.games[0].fullRunline };
const result = { ...analyzeNbaPreseason(game, quote), league: 'NBA', gameId: game.id, date: game.taipeiDate, observedAt };
const rank = buildNbaShadowRanking([{ game, quote, result, observedAt, pageActivityAt: observedAt, canAnalyze: true }], game.taipeiDate, now);
const totals = rank.entries.filter(entry => entry.marketKey === 'fullTotal');
assert.equal(totals.length, 2);
assert.ok(totals.every(entry => entry.line === '224-50'));
assert.notEqual(result.marketAnalyses.fullTotal.sides.over.expectedNet,
  analyzeNbaPreseason(game, { ...quote, fullTotal: { ...quote.fullTotal, line: '224平' } }).marketAnalyses.fullTotal.sides.over.expectedNet);
console.log('Reader credit fragments PASS: signed tails, Unicode signs, ambiguity rejection, intake evidence and exact NBA model/ranking contract');
