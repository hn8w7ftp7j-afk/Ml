import assert from 'node:assert/strict';
import { compareBetPrice, sameBetPrice } from '../lib/bet-price-comparison.js';

const game = { away: '客隊', home: '主隊' };
const baseBet = {
  league: 'MLB',
  date: '2026-08-20',
  gamePk: 1,
  market: '全場大小',
  pick: '小8+50',
  water: 0.94,
  away: '客隊',
  home: '主隊',
  rebateRate: 0.015,
};

assert.equal(sameBetPrice(baseBet, { pick: '小8+50', water: 0.94 }), true);
assert.equal(sameBetPrice(baseBet, { pick: '小8+50', water: 0.93 }), false);

const worseCurrent = compareBetPrice({
  bet: baseBet,
  row: { market: '全場大小', pick: '小8+60', water: 0.94 },
  game,
});
assert.equal(worseCurrent.comparable, true);
assert.equal(worseCurrent.lineStatus, 'BETTER', '目前小8+60在8分輸0.60u，原下注小8+50較優');
assert.equal(worseCurrent.waterStatus, 'EQUIVALENT');
assert.equal(worseCurrent.combinedStatus, 'BETTER');
assert.equal(worseCurrent.keyDifference.totalRuns, 8);
assert.ok(Math.abs(worseCurrent.keyDifference.delta - 0.1) < 1e-9);
assert.match(worseCurrent.keyDifference.text, /少輸／多贏0\.10u/);

const betterCurrent = compareBetPrice({
  bet: baseBet,
  row: { market: '全場大小', pick: '小8+40', water: 0.94 },
  game,
});
assert.equal(betterCurrent.lineStatus, 'WORSE', '目前小8+40在8分只輸0.40u，原下注較劣');
assert.equal(betterCurrent.combinedStatus, 'WORSE');
assert.ok(Math.abs(betterCurrent.keyDifference.delta + 0.1) < 1e-9);

const waterBetter = compareBetPrice({
  bet: { ...baseBet, water: 0.95 },
  row: { market: '全場大小', pick: '小8+50', water: 0.90 },
  game,
});
assert.equal(waterBetter.lineStatus, 'EQUIVALENT');
assert.equal(waterBetter.waterStatus, 'BETTER');
assert.equal(waterBetter.combinedStatus, 'BETTER');

const mixed = compareBetPrice({
  bet: { ...baseBet, pick: '小8+50', water: 0.90 },
  row: { market: '全場大小', pick: '小8+60', water: 1.05 },
  game,
});
assert.equal(mixed.lineStatus, 'BETTER');
assert.equal(mixed.waterStatus, 'WORSE');
assert.equal(['MIXED', 'BETTER', 'WORSE'].includes(mixed.combinedStatus), true);

const exact = compareBetPrice({
  bet: baseBet,
  row: { market: '全場大小', pick: '小8+50', water: 0.94 },
  game,
});
assert.equal(exact.exact, true);
assert.equal(exact.combinedStatus, 'EQUIVALENT');

const wrongDirection = compareBetPrice({
  bet: baseBet,
  row: { market: '全場大小', pick: '大8+50', water: 0.94 },
  game,
});
assert.equal(wrongDirection.comparable, false);
assert.equal(wrongDirection.combinedStatus, 'UNKNOWN');

console.log('Placed-versus-current Taiwan price comparison, exact suppression and key-hole delta PASS');
