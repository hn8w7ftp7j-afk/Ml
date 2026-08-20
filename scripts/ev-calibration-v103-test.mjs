import assert from 'node:assert/strict';
import { estimateRunProfileV103, MLB_RUN_MODEL_V103_VERSION } from '../lib/mlb-run-model-v103.js';
import { qualifyEvV103, UNVERIFIED_EXTREME_EV_LIMIT } from '../lib/ev-calibration-v103.js';
import { applyIndependentMarketVerification, MARKET_VERIFICATION_V2_VERSION } from '../lib/market-verification-v2.js';

function team({ starterEra = 4.2, starterWhip = 1.30, starterK9 = 8.6, starterBB9 = 3.2, starterHR9 = 1.15, starterIp = 110, starterStarts = 21 } = {}) {
  return {
    hitting: { available: true, status: 'CONFIRMED', games: 120, runsPerGame: 4.50, ops: 0.730 },
    recentHitting: { available: true, status: 'PROJECTED', games: 12, runsPerGame: 4.62, ops: 0.738 },
    pitching: { available: true, status: 'CONFIRMED', inningsPitched: 1080, gamesStarted: 120, era: 4.20, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 },
    recentPitching: { available: true, status: 'PROJECTED', inningsPitched: 108, gamesStarted: 12, era: 4.10, whip: 1.28, kPer9: 8.8, bbPer9: 3.1, hrPer9: 1.10 },
    starter: { available: true, status: 'CONFIRMED', inningsPitched: starterIp, gamesStarted: starterStarts, era: starterEra, whip: starterWhip, kPer9: starterK9, bbPer9: starterBB9, hrPer9: starterHR9 },
    injuriesAvailable: true,
    injuries: [],
    scoring: { games: 60, meanRuns: 4.5, varianceRuns: 6.4 },
  };
}

const baseContext = {
  leagueId: 'MLB',
  league: { runsPerTeamGame: 4.50, era: 4.20, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15, ops: 0.720 },
  away: team(),
  home: team(),
  park: { runFactor: 1, factorStatus: 'PROJECTED' },
  weather: { meanRunFactor: 1, status: 'PROJECTED' },
  sourceStatuses: { lineups: 'MISSING' },
};

const neutral = estimateRunProfileV103(baseContext);
assert.equal(neutral.version, MLB_RUN_MODEL_V103_VERSION);
assert.ok(neutral.full.away > 3.5 && neutral.full.away < 5.5);
assert.ok(neutral.full.home > 3.5 && neutral.full.home < 5.6);
assert.ok(neutral.components.awayOffense >= 0.86 && neutral.components.awayOffense <= 1.16);
assert.ok(neutral.components.awayStarter >= 0.84 && neutral.components.awayStarter <= 1.18);

const strongLongStarter = estimateRunProfileV103({
  ...baseContext,
  home: team({ starterEra: 2.55, starterWhip: 1.02, starterK9: 10.2, starterBB9: 2.0, starterHR9: 0.70, starterIp: 120, starterStarts: 18 }),
});
const strongShortStarter = estimateRunProfileV103({
  ...baseContext,
  home: team({ starterEra: 2.55, starterWhip: 1.02, starterK9: 10.2, starterBB9: 2.0, starterHR9: 0.70, starterIp: 80, starterStarts: 18 }),
});
assert.ok(strongLongStarter.first5.away < neutral.first5.away, 'strong starter must reduce F5 scoring mean');
assert.ok(strongLongStarter.full.away < strongShortStarter.full.away, 'longer expected starter workload must reduce opponent full-game mean');
assert.ok(strongLongStarter.components.homeStarterExpectedInnings > strongShortStarter.components.homeStarterExpectedInnings);
assert.ok(strongLongStarter.components.homeStarter >= 0.84, 'correlated ERA/FIP/WHIP inputs must not create an unbounded pitching multiplier');

const gate = { passedForShadowScore: true, quality: 0.90 };
const noPriorExtreme = qualifyEvV103({
  row: { water: 0.94, marketVerification: { referencePriorEligible: false } },
  rawWeightedEV: 0.22,
  rawRobustEV: 0.14,
  modelProbability: 0.63,
  rebateRate: 0.015,
  gate,
});
assert.equal(UNVERIFIED_EXTREME_EV_LIMIT, 0.15);
assert.equal(noPriorExtreme.qualified, false);
assert.equal(noPriorExtreme.weightedEV, null);
assert.match(noPriorExtreme.reasons.join('｜'), /缺少可去水/);

const moderateNoPrior = qualifyEvV103({
  row: { water: 0.94, marketVerification: { referencePriorEligible: false } },
  rawWeightedEV: 0.08,
  rawRobustEV: 0.025,
  modelProbability: 0.55,
  rebateRate: 0.015,
  gate,
});
assert.equal(moderateNoPrior.qualified, true);
assert.equal(moderateNoPrior.weightedEV, 0.08);

const confirmedExtreme = qualifyEvV103({
  row: { water: 0.94, marketVerification: { referencePriorEligible: true, referenceNoVigProbability: 0.55 } },
  rawWeightedEV: 0.20,
  rawRobustEV: 0.12,
  modelProbability: 0.56,
  rebateRate: 0.015,
  gate,
});
assert.equal(confirmedExtreme.qualified, true);
assert.ok(confirmedExtreme.robustEV < 0.09, 'independent reference EV must enter the robust short side');
assert.ok(confirmedExtreme.robustEV <= confirmedExtreme.rawRobustEV);

const disagreement = qualifyEvV103({
  row: { water: 0.94, marketVerification: { referencePriorEligible: true, referenceNoVigProbability: 0.51 } },
  rawWeightedEV: 0.20,
  rawRobustEV: 0.12,
  modelProbability: 0.63,
  rebateRate: 0.015,
  gate,
});
assert.equal(disagreement.qualified, false);
assert.match(disagreement.reasons.join('｜'), /差距/);

const observedAt = '2026-08-21T00:00:00.000Z';
const actual = [
  { market: '全場大小', pick: '大8.5', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineAsOf: observedAt },
  { market: '全場大小', pick: '小8.5', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineAsOf: observedAt },
];
const references = [
  { market: '全場大小', pick: '大8.5', water: 0.91, sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS', providerEventId: 'event-1', lineAsOf: observedAt },
  { market: '全場大小', pick: '小8.5', water: 0.95, sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS', providerEventId: 'event-1', lineAsOf: observedAt },
];
const verified = applyIndependentMarketVerification(actual, references);
assert.equal(verified[0].marketVerification.version, MARKET_VERIFICATION_V2_VERSION);
assert.equal(verified[0].marketVerification.referencePriorEligible, true);
assert.equal(verified[1].marketVerification.referencePriorEligible, true);
assert.ok(Math.abs(
  verified[0].marketVerification.referenceNoVigProbability
    + verified[1].marketVerification.referenceNoVigProbability
    - 1
) < 1e-12);

const integerVerified = applyIndependentMarketVerification(
  [{ ...actual[0], pick: '大8平' }, { ...actual[1], pick: '小8平' }],
  [{ ...references[0], pick: '大8平' }, { ...references[1], pick: '小8平' }],
);
assert.equal(integerVerified[0].marketVerification.referencePriorEligible, false);
assert.match(integerVerified[0].marketVerification.priorIneligibleReason, /走水|部分輸贏/);

console.log(JSON.stringify({
  ok: true,
  runModelVersion: MLB_RUN_MODEL_V103_VERSION,
  marketVerificationVersion: MARKET_VERIFICATION_V2_VERSION,
  neutralMeans: neutral.full,
  strongLongMeans: strongLongStarter.full,
}, null, 2));
