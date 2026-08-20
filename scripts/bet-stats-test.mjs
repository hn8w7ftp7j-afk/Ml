import assert from 'node:assert/strict';
import { summarizeBetLedger } from '../lib/bet-stats.js';

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
];

const stats = summarizeBetLedger(ledger);
assert.equal(stats.overall.bets, 6);
assert.equal(stats.overall.settled, 4);
assert.equal(stats.overall.open, 1);
assert.equal(stats.overall.manualReview, 1);
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
assert.equal(mlbTotal.settled, 2);
assert.equal(mlbTotal.netPnl, -200);
assert.equal(mlbTotal.winRate, 0.5);
assert.equal(mlbTotal.roi, -0.01);

const npbRunline = stats.groups.find(row => row.key === 'NPB|||全場讓分');
assert.ok(npbRunline);
assert.equal(npbRunline.halfLosses, 1);
assert.equal(npbRunline.effectiveLossStake, 5000);
assert.equal(npbRunline.winRate, 0);

console.log('Actual bet performance: net PnL, rebate, effective win rate, ROI and league-market grouping PASS');
