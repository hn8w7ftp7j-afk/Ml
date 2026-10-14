import assert from 'node:assert/strict';
import { nbaManualPerformanceBet } from '../lib/nba/performance-ledger.js';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { nbaManualContractHash, NBA_SETTLEMENT_VERSION } from '../lib/nba/manual-bet-settlement.js';
import { listNbaPerformanceLedgerPage, normalizeNbaPerformanceReadOptions } from '../lib/nba/manual-bet-store.js';
import { filterBetLedgerByPeriod, summarizeBetLedger, hasUnverifiedFirst5Settlement, matchesBetStatMarket } from '../lib/bet-stats.js';

const id = n => `11111111-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
const base = { alreadyPlaced: true, gameId: 'nba:espn:game:401999001', date: '2026-10-13',
  marketKey: 'fullTotal', side: 'over', line: '220+35.5', water: .94, stake: 10000,
  away: 'Boston Celtics', home: 'Los Angeles Lakers', startTime: '2026-10-13T02:00:00Z' };
const record = patch => ({ ...normalizeNbaManualBetRecord({ ...base, ...patch }), id: id(1),
  status: 'OPEN', recordedAt: '2026-10-13T16:10:00Z' });
function settled(value, fraction, scores = { away: 110, home: 110 }) {
  const rebate = value.stake * Math.abs(fraction) * .015;
  const profit = value.stake * Math.max(fraction, 0) * value.water - value.stake * Math.max(-fraction, 0) + rebate;
  const result = fraction === 0 ? 'PUSH' : fraction === 1 ? 'WIN' : fraction === -1 ? 'LOSS'
    : fraction > 0 ? 'PARTIAL_WIN' : 'PARTIAL_LOSS';
  return { ...value, settlementStatus: 'SETTLED', settlement: {
    status: 'SETTLED', version: NBA_SETTLEMENT_VERSION, contractHash: nbaManualContractHash(value),
    fraction, result, profit, rebate, effectiveStake: value.stake * Math.abs(fraction),
    evidenceStatus: 'MANUAL_CONTRACT_VERIFIED_OFFICIAL_RESULT',
    scores: { ...scores, period: value.marketKey.startsWith('firstHalf') ? 'FIRST_HALF' : 'FULL_GAME_INCLUDING_OVERTIME' },
    calibrationEligible: false,
  } };
}

const original = settled(record({}), .355), frozen = structuredClone(original);
const win = nbaManualPerformanceBet(original);
assert.deepEqual(original, frozen, 'display conversion must not mutate archived contract or settlement');
assert.equal(win.id, `nba-manual:${id(1)}`); assert.equal(win.nativeRecordId, id(1));
assert.equal(win.league, 'NBA'); assert.equal(win.ledgerSource, 'NBA_MANUAL_V1');
assert.equal(win.pick, '大220+35.5'); assert.equal(win.placedAt, original.recordedAt);
assert.equal(win.gameDate, original.startTime); assert.equal(win.status, 'SETTLED');
assert.equal(win.settlement.netProfit, original.settlement.profit);
assert.equal(win.settlement.rebate, original.settlement.rebate);
assert.equal(win.settlement.winFraction, .355);
assert.equal(win.settlement.outcome, 'HALF_WIN');
assert.equal(matchesBetStatMarket(win, 'FULL_TOTAL_OVER'), true, 'decimal tails remain correctly classified');
assert.equal(matchesBetStatMarket({ ...win, direction: 'UNDER' }, 'FULL_TOTAL_OVER'), false);
assert.equal(win.calibrationEligible, false); assert.equal(win.pitEvidenceVerified, false);
assert.equal(win.score, null); assert.equal(win.formulaDiagnosticScore, null);
const half = nbaManualPerformanceBet(settled(record({ marketKey: 'firstHalfTotal', side: 'under', line: '110+25' }), -.25, { away: 55, home: 55 }));
assert.equal(half.market, '上半大小'); assert.equal(half.slotId, 'FIRST5_TOTAL_UNDER');
assert.equal(half.statDirection, 'UNDER'); assert.equal(hasUnverifiedFirst5Settlement(half), false);
assert.equal(matchesBetStatMarket(half, 'FIRST5_TOTAL_UNDER'), true);
const spread = nbaManualPerformanceBet(record({ marketKey: 'fullRunline', side: 'home', lineSide: 'away', line: '8-50' }));
assert.equal(spread.pick, 'Los Angeles Lakers受讓8-50'); assert.equal(spread.statRunlineRole, 'RECEIVING');
assert.equal(spread.slotId, 'FULL_RUNLINE_HOME');
assert.equal(matchesBetStatMarket(spread, 'FULL_RUNLINE_STAT_RECEIVING'), true);
const halfSpread = nbaManualPerformanceBet(record({ marketKey: 'firstHalfRunline', side: 'away', lineSide: 'away', line: '4+25' }));
assert.equal(halfSpread.market, '上半讓分'); assert.equal(halfSpread.statRunlineRole, 'GIVING');
assert.equal(halfSpread.slotId, 'FIRST5_RUNLINE_AWAY');
const pickem = nbaManualPerformanceBet(record({ marketKey: 'fullRunline', side: 'away', lineSide: 'away', line: 'PK' }));
assert.equal(pickem.statRunlineRole, 'PICKEM'); assert.equal(matchesBetStatMarket(pickem, 'FULL_RUNLINE_STAT_PICKEM'), true);
const cancelled = nbaManualPerformanceBet({ ...original, status: 'CANCELLED' });
assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.settlement, null);
const badHash = nbaManualPerformanceBet({ ...original, line: '221+35.5' });
assert.equal(badHash.status, 'MANUAL_REVIEW'); assert.equal(badHash.settlement, null);
const badFraction = nbaManualPerformanceBet({ ...original, settlement: { ...original.settlement, fraction: .5 } });
assert.equal(badFraction.status, 'MANUAL_REVIEW');
for (const patch of [{ profit: original.settlement.profit + 1 }, { rebate: original.settlement.rebate + .01 },
  { effectiveStake: original.settlement.effectiveStake + .00000001 }]) {
  const corrupt = { ...original, settlement: { ...original.settlement, ...patch } };
  const before = structuredClone(corrupt);
  const excluded = nbaManualPerformanceBet(corrupt);
  assert.equal(excluded.status, 'MANUAL_REVIEW', 'financial mismatch must not become settled performance');
  assert.equal(excluded.settlement, null);
  assert.deepEqual(corrupt, before, 'reject mismatched evidence without rewriting saved numbers');
}
for (const scores of [{ ...original.settlement.scores, period: 'FIRST_HALF' },
  { ...original.settlement.scores, away: -1 }, { ...original.settlement.scores, home: 110.5 },
  { ...original.settlement.scores, away: 111 }, null]) {
  const excluded = nbaManualPerformanceBet({ ...original, settlement: { ...original.settlement, scores } });
  assert.equal(excluded.status, 'MANUAL_REVIEW', 'invalid score period or value cannot enter settled performance');
  assert.equal(excluded.settlement, null);
}
for (const [patch, fraction, scores] of [
  [{}, 1, { away: 111, home: 110 }],
  [{}, -1, { away: 109, home: 110 }],
  [{ line: '220' }, 0, { away: 110, home: 110 }],
  [{ marketKey: 'fullRunline', side: 'home', lineSide: 'home', line: '8+35.5' }, .355, { away: 110, home: 118 }],
  [{ marketKey: 'fullRunline', side: 'away', lineSide: 'home', line: '8+35.5' }, -.355, { away: 110, home: 118 }],
]) {
  const native = settled(record(patch), fraction, scores);
  const converted = nbaManualPerformanceBet(native);
  assert.equal(converted.status, 'SETTLED', 'consistent full, partial, push and spread settlements remain included');
  assert.equal(converted.settlement.netProfit, native.settlement.profit);
}
assert.equal(nbaManualPerformanceBet({ ...original, recordedAt: 'bad' }), null);
assert.equal(nbaManualPerformanceBet({ ...original, gameId: 'mlb:espn:game:401999001' }), null);
const now = Date.parse('2026-10-14T07:00:00Z');
assert.equal(filterBetLedgerByPeriod([win], 'TODAY', now).length, 1, 'use Taipei recording date, not previous board date');
assert.equal(filterBetLedgerByPeriod([win], 'YESTERDAY', now).length, 0);
const summary = summarizeBetLedger([win, half, cancelled, badHash, spread]).overall;
assert.equal(summary.bets, 4); assert.equal(summary.settled, 2); assert.equal(summary.cancelled, 1);
assert.equal(summary.manualReview, 1); assert.equal(summary.open, 1);
assert.equal(summary.halfWins, 1); assert.equal(summary.halfLosses, 1);
assert.equal(summary.totalStake, 20000);
assert.equal(summary.rebate, Math.round((win.settlement.rebate + half.settlement.rebate) * 10000) / 10000);
assert.equal(summary.netPnl, Math.round((win.settlement.netProfit + half.settlement.netProfit) * 10000) / 10000);
assert.ok(Math.abs(summary.winRate - .355 / (.355 + .25)) < 1e-14, 'partial results retain exact effective stake weighting');
assert.equal(summary.roi, summary.netPnl / 20000);
const baseball = { id: id(1), league: 'MLB', stake: 10000, status: 'SETTLED', market: '全場大小', settlement: {
  outcome: 'LOSS', winFraction: 0, lossFraction: 1, grossWin: 0, grossLoss: -10000, rebate: 150, netProfit: -9850,
} };
assert.notEqual(win.id, baseball.id, 'native UUID cannot collide with baseball display IDs');
const combined = summarizeBetLedger([baseball, win]).overall;
assert.equal(combined.settled, 2); assert.equal(combined.netPnl, -9850 + win.settlement.netProfit);

for (const options of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { date: '2026-02-30' }, { cursor: 'not-a-cursor' }]) {
  assert.throws(() => normalizeNbaPerformanceReadOptions(options), error => error.status === 400);
}
const rows = Array.from({ length: 1007 }, (_, index) => {
  const value = { ...record({}), id: id(index + 1) };
  return { id: value.id, payload: value, settlement: null, cursor_recorded_at: '2026-10-13T16:10:00.123456Z' };
}).sort((left, right) => right.id.localeCompare(left.id));
let queryCount = 0;
const db = async (strings, ...values) => {
  queryCount++;
  const sql = strings.join('?');
  assert.match(sql, /\(r\.recorded_at, r\.id\) </);
  assert.match(sql, /ORDER BY r\.recorded_at DESC, r\.id DESC LIMIT/);
  const [date, , , , cursorAt, , cursorId, cap] = values;
  const filtered = rows.filter(row => date == null || row.payload.date === date);
  const selected = filtered.filter(row => !cursorAt || row.cursor_recorded_at < cursorAt
    || (row.cursor_recorded_at === cursorAt && row.id < cursorId)).slice(0, cap);
  return selected.length ? selected.map(row => ({ ...row, total_records: String(filtered.length) }))
    : [{ total_records: String(filtered.length), id: null }];
};
let cursor = null, pageCount = 0, all = [];
do {
  const page = await listNbaPerformanceLedgerPage({ limit: 500, cursor }, { db, prepareSchema: false });
  assert.equal(page.pagination.totalRecords, 1007); assert.equal(page.pagination.invalidRecordsOnPage, 0);
  all.push(...page.bets); cursor = page.pagination.nextCursor; pageCount++;
  if (cursor) {
    const parsed = normalizeNbaPerformanceReadOptions({ cursor }).cursor;
    assert.equal(parsed.recordedAt, '2026-10-13T16:10:00.123456Z');
    assert.throws(() => normalizeNbaPerformanceReadOptions({ cursor, date: '2026-10-13' }), /分頁識別/);
  }
} while (cursor);
assert.equal(pageCount, 3); assert.equal(all.length, 1007); assert.equal(new Set(all.map(row => row.id)).size, 1007);
assert.equal(queryCount, 3);
const empty = await listNbaPerformanceLedgerPage({ date: '2026-10-14' }, { db, prepareSchema: false });
assert.equal(empty.pagination.totalRecords, 0); assert.equal(empty.pagination.hasMore, false); assert.deepEqual(empty.bets, []);
await assert.rejects(listNbaPerformanceLedgerPage({}, { db: async () => [], prepareSchema: false }), /總筆數/);
const invalid = await listNbaPerformanceLedgerPage({}, { prepareSchema: false, db: async () => [{
  total_records: '1', id: id(2), payload: record({}), cursor_recorded_at: '2026-10-13T16:10:00.123456Z',
}] });
assert.equal(invalid.pagination.invalidRecordsOnPage, 1); assert.equal(invalid.pagination.totalRecords, 1);
console.log('NBA performance ledger PASS: immutable native contracts, four-market mapping, decimal partial values, Taipei placement date, weighted math, league/ID isolation, fail-closed settlement, complete 1007-row keyset read and explicit invalid counts');
