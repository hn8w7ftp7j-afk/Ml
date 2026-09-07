import assert from 'node:assert/strict';
import { BET_PERIODS, filterBetLedgerByPeriod, hasUnverifiedFirst5Settlement, summarizeBetLedger } from '../lib/bet-stats.js';

const settled = (id, league, market, outcome, netProfit, values = {}) => ({
  id,
  league,
  market,
  status: 'SETTLED',
  stake: values.stake ?? 10000,
  settlement: {
    outcome,
    winFraction: values.winFraction ?? (outcome === 'WIN' ? 1 : outcome === 'HALF_WIN' ? 0.5 : 0),
    lossFraction: values.lossFraction ?? (outcome === 'LOSS' ? 1 : outcome === 'HALF_LOSS' ? 0.5 : 0),
    grossWin: values.grossWin ?? Math.max(0, netProfit),
    grossLoss: values.grossLoss ?? Math.min(0, netProfit),
    rebate: values.rebate ?? 0,
    netProfit,
  },
});

const ledger = [
  settled('1', 'MLB', '全場大小', 'WIN', 9650, { grossWin: 9500, grossLoss: 0, rebate: 150 }),
  settled('2', 'MLB', '全場大小', 'LOSS', -9850, { grossWin: 0, grossLoss: -10000, rebate: 150 }),
  settled('3', 'MLB', '上半讓分', 'HALF_WIN', 4825, { winFraction: 0.5, lossFraction: 0, grossWin: 4750, rebate: 75 }),
  settled('4', 'NPB', '全場讓分', 'HALF_LOSS', -4925, { winFraction: 0, lossFraction: 0.5, grossLoss: -5000, rebate: 75 }),
  { id: '5', league: 'KBO', market: '上半大小', status: 'OPEN', stake: 10000 },
  { id: '6', league: 'CPBL', market: '全場大小', status: 'MANUAL_REVIEW', stake: 10000 },
  { id: 'cancelled', league: 'NPB', market: '全場大小', status: 'CANCELLED', stake: 10000 },
  { id: 'legacy', league: 'MLB', market: '全場大小', status: 'SETTLED', stake: 99999,
    performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY', settlement: { outcome: 'WIN', netProfit: 99999 } },
];

const stats = summarizeBetLedger(ledger);
assert.equal(stats.overall.bets, 6);
assert.equal(stats.overall.settled, 4);
assert.equal(stats.overall.open, 1);
assert.equal(stats.overall.manualReview, 1);
assert.equal(stats.overall.cancelled, 1);
assert.equal(stats.overall.quarantined, 1);
assert.equal(stats.overall.placedStake, 60000);
assert.equal(stats.overall.wins, 1);
assert.equal(stats.overall.losses, 1);
assert.equal(stats.overall.halfWins, 1);
assert.equal(stats.overall.halfLosses, 1);
assert.equal(stats.overall.totalStake, 40000);
assert.equal(stats.overall.rebate, 450);
assert.equal(stats.overall.netPnl, -300);
assert.ok(Math.abs(stats.overall.roi - (-0.0075)) < 1e-12);
assert.ok(Math.abs(stats.overall.winRate - 0.5) < 1e-12);

const mlbTotal = stats.groups.find(row => row.key === 'MLB|||全場大小');
assert.ok(mlbTotal);
assert.equal(mlbTotal.bets, 2);
assert.equal(mlbTotal.placedStake, 20000);
assert.equal(mlbTotal.settled, 2);
assert.equal(mlbTotal.netPnl, -200);
assert.equal(mlbTotal.winRate, 0.5);
assert.equal(mlbTotal.roi, -0.01);

const npbRunline = stats.groups.find(row => row.key === 'NPB|||全場讓分');
assert.ok(npbRunline);
assert.equal(npbRunline.halfLosses, 1);
assert.equal(npbRunline.effectiveLossStake, 5000);
assert.equal(npbRunline.winRate, 0);

// A stale result must not become a decision until the ledger status is settled.
const staleOutcomes = ['WIN', 'LOSS', 'PUSH', 'HALF_WIN', 'HALF_LOSS', 'VOID'];
const pendingWithStaleResults = ['OPEN', 'MANUAL_REVIEW'].flatMap(status =>
  staleOutcomes.map(outcome => ({
    ...settled(`${status}-${outcome}`, 'MLB', '全場大小', outcome, 9650),
    status,
  })));
const pendingBefore = structuredClone(pendingWithStaleResults);
const pendingStats = summarizeBetLedger(pendingWithStaleResults);
for (const summary of [pendingStats.overall, ...pendingStats.groups]) {
  assert.equal(summary.bets, 12);
  assert.equal(summary.open, 6);
  assert.equal(summary.manualReview, 6);
  assert.equal(summary.placedStake, 120000);
  for (const key of ['settled', 'wins', 'losses', 'pushes', 'halfWins', 'halfLosses', 'voids',
    'totalStake', 'grossPnl', 'rebate', 'netPnl', 'effectiveWinStake', 'effectiveLossStake']) {
    assert.equal(summary[key], 0, `未結算的舊賽果不得增加 ${key}`);
  }
  assert.equal(summary.winRate, null);
  assert.equal(summary.roi, null);
}
assert.deepEqual(pendingWithStaleResults, pendingBefore, '統計不得清除或修改帳本內保留的賽果');

const voidStats = summarizeBetLedger([
  { ...settled('void-result', 'NPB', '全場讓分', 'VOID', 0), status: 'VOID' },
  { ...settled('void-stale-win', 'NPB', '全場讓分', 'WIN', 9650), status: 'VOID' },
]);
for (const summary of [voidStats.overall, ...voidStats.groups]) {
  assert.equal(summary.voids, 2, '每筆 VOID 只能計一次，保留舊賽果不得重複計數');
  assert.equal(summary.settled, 0);
  assert.equal(summary.wins, 0);
  assert.equal(summary.totalStake, 0);
  assert.equal(summary.netPnl, 0);
}
const recovered = { ...pendingWithStaleResults[0], status: 'SETTLED' };
const recoveredStats = summarizeBetLedger([recovered]).overall;
assert.equal(recoveredStats.settled, 1);
assert.equal(recoveredStats.wins, 1);
assert.equal(recoveredStats.netPnl, 9650, '正式結算後才可收錄保留賽果的勝敗與盈虧');
assert.equal(summarizeBetLedger([settled('settled-void', 'NPB', '全場讓分', 'VOID', 0)]).overall.voids, 1);

// Old first-five settlement payloads converted absent official scores to 0:0.
const unverifiedFirst5Bets = Array.from({ length: 6 }, (_, index) => ({
  ...settled(`old-cpbl-${index}`, 'CPBL', index < 3 ? '上半讓分' : '上半大小', 'WIN', 9650),
  resultSnapshot: {
    first5Complete: false, awayFirst5: null, homeFirst5: null,
    selectedPeriod: 'FIRST5', selectedAwayRuns: 0, selectedHomeRuns: 0,
    serviceVersion: index < 3 ? 'v1.0.1' : 'v1.1.0',
  },
}));
const unverifiedBefore = structuredClone(unverifiedFirst5Bets);
const unverifiedStats = summarizeBetLedger(unverifiedFirst5Bets);
assert.equal(unverifiedStats.overall.bets, 6, '真實下注紀錄仍須保留在下注數');
assert.equal(unverifiedStats.overall.placedStake, 60000);
assert.equal(unverifiedStats.overall.unverifiedSettlements, 6);
assert.deepEqual(unverifiedStats.groups.map(row => row.unverifiedSettlements), [3, 3]);
for (const summary of [unverifiedStats.overall, ...unverifiedStats.groups]) {
  for (const key of ['settled', 'wins', 'losses', 'pushes', 'halfWins', 'halfLosses',
    'totalStake', 'grossPnl', 'rebate', 'netPnl', 'effectiveWinStake', 'effectiveLossStake']) {
    assert.equal(summary[key], 0, `缺少明確上半比分的舊結算不得增加 ${key}`);
  }
  assert.equal(summary.winRate, null);
  assert.equal(summary.roi, null);
}
assert.deepEqual(unverifiedFirst5Bets, unverifiedBefore, '績效排除不得修改 SETTLED 狀態或舊結算證據');

const verifiedZeroFirst5 = ['MLB', 'NPB', 'KBO', 'CPBL'].map(league => ({
  ...settled(`verified-zero-${league}`, league, '上半讓分', 'PUSH', 0),
  resultSnapshot: { first5Complete: true, awayFirst5: 0, homeFirst5: 0,
    selectedPeriod: 'FIRST5', selectedAwayRuns: 0, selectedHomeRuns: 0 },
}));
const zeroStats = summarizeBetLedger(verifiedZeroFirst5).overall;
assert.equal(zeroStats.settled, 4, '經正式驗證的 0:0 必須正常列入結算');
assert.equal(zeroStats.pushes, 4);
assert.equal(zeroStats.totalStake, 40000);
assert.equal(zeroStats.unverifiedSettlements, 0);

const fullGameWithNoFirst5 = ['全場讓分', '全場大小'].map(market => ({
  ...unverifiedFirst5Bets[0], id: market, market,
  resultSnapshot: { ...unverifiedFirst5Bets[0].resultSnapshot, selectedPeriod: 'FULL_GAME' },
}));
assert.equal(summarizeBetLedger(fullGameWithNoFirst5).overall.settled, 2, '全場結算不得要求上半比分');
assert.equal(summarizeBetLedger(fullGameWithNoFirst5).overall.netPnl, 19300);
const legacyWithoutSnapshot = settled('legacy-no-snapshot', 'CPBL', '上半大小', 'WIN', 9650);
assert.equal(hasUnverifiedFirst5Settlement(legacyWithoutSnapshot), false, '不得僅因舊資料無 snapshot 就一律排除');
assert.equal(summarizeBetLedger([legacyWithoutSnapshot]).overall.settled, 1);
assert.equal(hasUnverifiedFirst5Settlement({ ...legacyWithoutSnapshot, resultSnapshot: { selectedPeriod: 'FIRST5' } }), false);
assert.equal(hasUnverifiedFirst5Settlement({ ...legacyWithoutSnapshot, resultSnapshot: { first5Complete: false } }), true);
for (const side of ['awayFirst5', 'homeFirst5']) {
  assert.equal(hasUnverifiedFirst5Settlement({ ...legacyWithoutSnapshot,
    resultSnapshot: { selectedPeriod: 'FIRST5', [side]: null } }), true, '明確缺少任一方前五局比分須排除');
  for (const value of ['', ' ', undefined, false, true, [], {}, -1, 0.5, Infinity]) {
    assert.equal(hasUnverifiedFirst5Settlement({ ...legacyWithoutSnapshot,
      resultSnapshot: { selectedPeriod: 'FIRST5', first5Complete: true, [side]: value } }), true,
    'An explicit invalid official score cannot become verified solely through first5Complete');
  }
  for (const value of [0, '0', 3, '3']) {
    assert.equal(hasUnverifiedFirst5Settlement({ ...legacyWithoutSnapshot,
      resultSnapshot: { selectedPeriod: 'FIRST5', first5Complete: true, [side]: value } }), false,
    'Genuine numeric official scores remain valid');
  }
}
for (const status of ['OPEN', 'MANUAL_REVIEW', 'VOID', 'CANCELLED']) {
  assert.equal(hasUnverifiedFirst5Settlement({ ...unverifiedFirst5Bets[0], status }), false);
}

console.log('Actual bet performance: net PnL, rebate, effective win rate, ROI and league-market grouping PASS');

const periodLedger = [
  { id: 'today', placedAt: '2026-08-25T04:00:00.000Z' },
  { id: 'yesterday', placedAt: '2026-08-24T04:00:00.000Z' },
  { id: 'last-week', placedAt: '2026-08-17T04:00:00.000Z' },
  { id: 'this-month', placedAt: '2026-08-05T04:00:00.000Z' },
  { id: 'last-month', placedAt: '2026-07-31T15:59:59.000Z' },
];
const periodNow = '2026-08-25T05:00:00.000Z';
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'TODAY', periodNow).map(row => row.id), ['today']);
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'YESTERDAY', periodNow).map(row => row.id), ['yesterday']);
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'THIS_WEEK', periodNow).map(row => row.id), ['today', 'yesterday']);
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'LAST_WEEK', periodNow).map(row => row.id), ['last-week']);
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'THIS_MONTH', periodNow).map(row => row.id), ['today', 'yesterday', 'last-week', 'this-month']);
assert.deepEqual(filterBetLedgerByPeriod(periodLedger, 'LAST_MONTH', periodNow).map(row => row.id), ['last-month']);
assert.equal(BET_PERIODS.map(row => row.id).join(','), 'TODAY,YESTERDAY,THIS_WEEK,LAST_WEEK,THIS_MONTH,LAST_MONTH,ALL');

const midnightBoundary = [
  { id: 'before', placedAt: '2026-12-31T15:59:59.999Z' },
  { id: 'after', placedAt: '2026-12-31T16:00:00.000Z' },
  { id: 'missing', placedAt: null },
  { id: 'invalid', placedAt: '' },
];
assert.deepEqual(filterBetLedgerByPeriod(midnightBoundary, 'TODAY', '2026-12-31T16:00:00Z').map(row => row.id), ['after']);
assert.deepEqual(filterBetLedgerByPeriod(midnightBoundary, 'LAST_MONTH', '2026-12-31T16:00:00Z').map(row => row.id), ['before']);
assert.deepEqual(filterBetLedgerByPeriod([{ id: 'missing', placedAt: null }], 'TODAY', '1970-01-01T01:00:00Z'), [],
  'An absent placement date cannot be interpreted as the Unix epoch');
