import assert from 'node:assert/strict';
import {
  summarizeBetLedger, filterBetLedgerByPeriod, matchesBetStatMarket,
  hasUnverifiedFirst5Settlement,
} from '../lib/bet-stats.js';
import { summarizeOriginalBetPrices, summarizeOriginalBetPricesAsync } from '../lib/bet-price-summary.js';

// Native adapter output: display slots intentionally share labels, not sport models.
const soccer = (id, patch = {}) => ({
  id: `soccer-manual:${id}`, league: 'EPL', ledgerSource: 'SOCCER_MANUAL_V1',
  status: 'SETTLED', stake: 10000, market: '全場大小',
  placedAt: '2026-11-23T16:10:00Z', gameDate: '2026-11-23T14:00:00Z',
  pick: '大2+25.5', direction: 'OVER', statDirection: 'OVER', slotId: 'FULL_TOTAL_OVER',
  settlement: { outcome: 'HALF_WIN', winFraction: .255, lossFraction: 0,
    pushFraction: .745, grossWin: 2397, grossLoss: 0, rebate: 25.5, netProfit: 2422.5 },
  ...patch,
});
const win = soccer('win');
const loss = soccer('loss', { league: 'UCL', settlement: {
  outcome: 'LOSS', winFraction: 0, lossFraction: 1, pushFraction: 0,
  grossWin: 0, grossLoss: -10000, rebate: 100, netProfit: -9900,
} });
const account = soccer('account', { settlement: {
  source: 'SELF_REPORTED_USER_CONFIRMED', rebateTreatment: 'INCLUDED', netProfit: 1234.56,
} });
const accountLoss = soccer('account-loss', { league: 'UCL', settlement: {
  source: 'SELF_REPORTED_USER_CONFIRMED', rebateTreatment: 'INCLUDED', netProfit: -432.1,
} });
const cancelled = soccer('cancelled', { status: 'CANCELLED', settlement: account.settlement });
const revoked = soccer('revoked', { status: 'OPEN', settlement: null });
const reviewed = soccer('reviewed', { status: 'MANUAL_REVIEW', settlement: null });
const original = structuredClone([win, loss, account, accountLoss, cancelled, revoked, reviewed]);
const summary = summarizeBetLedger(original).overall;
assert.equal(summary.bets, 6);
assert.equal(summary.settled, 4);
assert.equal(summary.cancelled, 1);
assert.equal(summary.open, 1);
assert.equal(summary.manualReview, 1);
assert.equal(summary.selfReportedSettlements, 2);
assert.equal(summary.unknownOutcomeSettlements, 2);
assert.equal(summary.unknownRebateSettlements, 2);
assert.equal(summary.halfWins, 1);
assert.equal(summary.losses, 1);
assert.equal(summary.wins, 0, 'positive reported money is not proof of a full win');
assert.equal(summary.effectiveWinStake, 2550);
assert.equal(summary.effectiveLossStake, 10000, 'negative reported money is not a loss fraction');
assert.equal(summary.winRate, 2550 / 12550);
assert.equal(summary.totalStake, 40000);
assert.equal(summary.netPnl, -6675.04);
assert.ok(Math.abs(summary.roi - (-6675.04 / 40000)) < 1e-12);
assert.equal(summary.rebate, 125.5, 'only separately verified rebates enter known rebate subtotal');
assert.equal(summary.grossPnl, -7603);
assert.deepEqual(original, [win, loss, account, accountLoss, cancelled, revoked, reviewed]);
const reportedOnly = summarizeBetLedger([account, accountLoss]).overall;
assert.equal(reportedOnly.winRate, null);
assert.equal(reportedOnly.rebate, 0);
assert.equal(reportedOnly.unknownRebateSettlements, 2, 'zero known rebate is explicitly incomplete');
assert.equal(reportedOnly.netPnl, 802.46);

const epl = summarizeBetLedger(original.filter(bet => bet.league === 'EPL')).overall;
const ucl = summarizeBetLedger(original.filter(bet => bet.league === 'UCL')).overall;
assert.equal(epl.netPnl, 3657.06);
assert.equal(ucl.netPnl, -10332.1);
assert.equal(Math.round((epl.netPnl + ucl.netPnl) * 100) / 100, summary.netPnl);
assert.equal(filterBetLedgerByPeriod(original, 'TODAY', Date.parse('2026-11-24T07:00:00Z')).length, 7,
  'performance date follows Taipei placement time, not match date');

for (const [market, period] of [['全場大小', 'FULL'], ['上半大小', 'FIRST5']]) {
  for (const direction of ['OVER', 'UNDER']) {
    const bet = soccer('total', { market, direction, statDirection: direction, slotId: `${period}_TOTAL_${direction}` });
    assert.equal(matchesBetStatMarket(bet, `${period}_TOTAL_${direction}`), true);
    assert.equal(matchesBetStatMarket({ ...bet, direction: direction === 'OVER' ? 'UNDER' : 'OVER' }, `${period}_TOTAL_${direction}`), false);
    assert.equal(matchesBetStatMarket({ ...bet, slotId: 'CONFLICTING' }, `${period}_TOTAL_${direction}`), false);
  }
}
for (const [market, period] of [['全場讓分', 'FULL'], ['上半讓分', 'FIRST5']]) {
  for (const role of ['GIVING', 'RECEIVING', 'PICKEM']) {
    const bet = soccer('spread', { market, statRunlineRole: role, slotId: `${period}_RUNLINE_HOME` });
    assert.equal(matchesBetStatMarket(bet, `${period}_RUNLINE_STAT_${role}`), true);
    assert.equal(matchesBetStatMarket({ ...bet, slotId: 'CONFLICTING' }, `${period}_RUNLINE_STAT_${role}`), false);
  }
}
const half = soccer('half', { market: '上半大小', resultSnapshot: { first5Complete: false } });
assert.equal(hasUnverifiedFirst5Settlement(half), false, 'soccer half-time is checked by its native adapter');
assert.equal(hasUnverifiedFirst5Settlement({ ...half, league: 'MLB', ledgerSource: undefined }), true,
  'baseball five-inning completeness must remain enforced');

// Even a retained reference cannot feed non-baseball bets into baseball comparison math.
const reference = { pick: '大2+50', water: .95, market: '全場大小' };
const values = [win, loss, account, { ...win, id: 'NBA', league: 'NBA', ledgerSource: 'NBA_MANUAL_V1' }];
const feed = Object.fromEntries(values.map(bet => [bet.id, { current: reference }]));
const prices = summarizeOriginalBetPrices(values, feed);
assert.equal(prices.eligible, 4);
assert.equal(prices.unsupported, 4);
assert.equal(prices.supported, 0);
assert.equal(prices.missingReference, 0);
assert.equal(prices.comparable, 0);
let compared = 0;
assert.deepEqual(await summarizeOriginalBetPricesAsync(values, feed, {
  yieldControl: async () => {}, compare: () => { compared++; throw Error('non-baseball math'); },
}), prices);
assert.equal(compared, 0);
const baseball = { ...win, id: 'MLB', league: 'MLB', ledgerSource: undefined, market: '全場大小' };
assert.equal(summarizeOriginalBetPrices([baseball], {}).supported, 1);
assert.equal(summarizeBetLedger([baseball]).overall.selfReportedSettlements, 0);
console.log('PASS soccer performance stats: separate leagues, exact native fractions/P&L, reported-net coverage, cancellations/revocations, Taipei dates and isolated filters/comparisons');
