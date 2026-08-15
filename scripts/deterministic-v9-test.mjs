import assert from 'node:assert/strict';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import {
  SETTLEMENT_RULE_VERSION,
  mirrorSettlementAudit,
  parseTaiwanContract,
  settleTaiwanContract,
  settlementProfit,
} from '../lib/taiwan-settlement-v9.js';

const score = (weightedEV, robustEV, options = {}) => deterministicScore({
  weightedEV,
  robustEV,
  qaPassed: true,
  actualWater: true,
  executable: true,
  crossMarketVerified: false,
  ...options,
});

assert.equal(SCORE_FORMULA_VERSION, 'DUAL-EV-BOTTLENECK-2026-08-v1.1.0');
assert.equal(score(0, 0).score, 6.6);
assert.equal(score(-0.001, 0.02).score, 6.6);
assert.equal(score(0.01, 0).score, 7.1);
assert.equal(score(0.01, -0.001).score, 7.1);

// 7.2-7.4 uses the next 7.5 threshold (2.0% / 0.8%) as mathematical upper bound.
assert.equal(score(0.005, 0.004).score, 7.2);
assert.equal(score(0.012, 0.004).score, 7.3);
assert.equal(score(0.018, 0.006).score, 7.4);
assert.equal(score(0.020, 0.008).score, 7.5); // exact boundary belongs to next band

// 7.5-7.9 uses 8.0 as the mathematical upper score.
assert.equal(score(0.024, 0.0104).score, 7.6);
assert.equal(score(0.030, 0.014).score, 7.7);
assert.equal(score(0.038, 0.0176).score, 7.9);
assert.equal(score(0.040, 0.020).score, 8.0);

// 8.0-8.4 uses 8.5 as mathematical upper score.
assert.equal(score(0.046, 0.024).score, 8.1);
assert.equal(score(0.055, 0.030).score, 8.2);
assert.equal(score(0.067, 0.038).score, 8.4);

// High weighted EV cannot pull a weak robust EV into the next band.
assert.equal(score(0.080, 0.019).score, 7.9);

// 8.5-8.9 requires two independent same-contract markets.
assert.equal(score(0.080, 0.048, { crossMarketVerified: true }).score, 8.6);
assert.equal(score(0.095, 0.060, { crossMarketVerified: true }).score, 8.7);
assert.equal(score(0.115, 0.076, { crossMarketVerified: true }).score, 8.9);
assert.equal(score(0.115, 0.076, { crossMarketVerified: false }).score, 8.4);
assert.equal(score(0.080, 0.048, { crossMarketVerified: true, rawMarketProbabilityGap: 0.12 }).score, 7.9);
assert.equal(score(0.080, 0.048, { crossMarketVerified: true, rawMarketProbabilityGap: 0.18 }).score, 7.4);
assert.ok(score(0.080, 0.048, { crossMarketVerified: true, rawMarketProbabilityGap: 0.18 }).caps.includes('RAW_MARKET_PROBABILITY_GAP_GTE_18_PERCENT'));
const saturated = score(0.120, 0.080, { crossMarketVerified: true });
assert.equal(saturated.score, 8.9);
assert.equal(saturated.rawScore, 9);
assert.equal(saturated.highScoreAnomaly, true);

const blocked = deterministicScore({ weightedEV: 0.2, robustEV: 0.1, qaPassed: false });
assert.equal(blocked.score, null);
assert.equal(blocked.eligible, false);

const away = '紐約洋基';
const home = '波士頓紅襪';
const parsed = parseTaiwanContract(`${away}讓1+50`);
assert.equal(parsed.valid, true);
assert.equal(parsed.legs[0], 1);
assert.equal(parsed.tailSign, 'positive');
assert.equal(parsed.tailPercent, 50);

const truth = [
  [`${away}讓1+50`, 4, 3, 0.5],
  [`${home}受讓1+50`, 4, 3, -0.5],
  [`${away}讓1-30`, 4, 3, -0.3],
  [`${home}受讓1-30`, 4, 3, 0.3],
  ['大8+50', 4, 4, 0.5],
  ['小8+50', 4, 4, -0.5],
  ['大8-30', 4, 4, -0.3],
  ['小8-30', 4, 4, 0.3],
  [`${away}讓0+70`, 3, 3, 0.7],
  [`${home}受讓0+70`, 3, 3, -0.7],
  [`${away}讓0-70`, 3, 3, -0.7],
  [`${home}受讓0-70`, 3, 3, 0.7],
  [`${away}讓1平`, 4, 3, 0],
];
for (const [pick, awayRuns, homeRuns, expected] of truth) {
  const settlement = settleTaiwanContract(pick, awayRuns, homeRuns, away, home);
  assert.ok(settlement, pick);
  assert.ok(Math.abs(settlement.netFraction - expected) < 1e-12, `${pick}: ${settlement.netFraction}`);
  assert.ok(Math.abs(settlement.winFraction + settlement.lossFraction + settlement.pushFraction - 1) < 1e-12);
}

const profitTruth = [
  [1, 9650],
  [-1, -9850],
  [0.5, 4825],
  [-0.5, -4925],
  [0, 0],
];
for (const [fraction, expected] of profitTruth) {
  const settlement = {
    legs: [{ allocation: 1, fraction, winShare: Math.max(0, fraction), lossShare: Math.max(0, -fraction), pushShare: 1 - Math.abs(fraction) }],
  };
  const result = settlementProfit({ stake: 10000, water: 0.95, settlement, rebateRate: 0.015 });
  assert.ok(Math.abs(result.profit - expected) < 1e-9);
}

// Critical regression: split tickets must settle each leg before rebate, never net first.
const mixed = settleTaiwanContract(`${away}讓1/1.5+50`, 4, 3, away, home);
assert.equal(mixed.legs.length, 2);
assert.equal(mixed.legs[0].fraction, 0.5);
assert.equal(mixed.legs[1].fraction, -1);
assert.equal(mixed.winFraction, 0.25);
assert.equal(mixed.lossFraction, 0.5);
assert.equal(mixed.pushFraction, 0.25);
const mixedProfit = settlementProfit({ stake: 10000, water: 0.95, settlement: mixed, rebateRate: 0.015 });
assert.equal(mixedProfit.profit, -2512.5);
assert.equal(mixedProfit.rebate, 112.5);
assert.equal(mixedProfit.settledAmount, 7500);

const mirror = mirrorSettlementAudit(`${away}讓1/1.5+50`, `${home}受讓1/1.5+50`, 4, 3, away, home);
assert.equal(mirror.ok, true);
assert.equal(SETTLEMENT_RULE_VERSION, 'TW-CREDIT-PER-LEG-REBATE-2026-08-v1.0.0');

console.log(JSON.stringify({
  ok: true,
  scoreFormulaVersion: SCORE_FORMULA_VERSION,
  settlementRuleVersion: SETTLEMENT_RULE_VERSION,
  mixedSplitProfit: mixedProfit,
}, null, 2));


// Source/eligibility and score boundaries remain deterministic.
assert.equal(score(0.08, 0.048, { crossMarketVerified: false }).score, 8.4);
assert.equal(score(0.08, 0.048, { crossMarketVerified: true }).score, 8.6);
