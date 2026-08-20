import assert from 'node:assert/strict';
import { estimateRunProfileV103, MLB_RUN_MODEL_V103_VERSION } from '../lib/mlb-run-model-v103.js';
import {
  qualifyEvV103,
  EV_CALIBRATION_V103_VERSION,
  MAX_RAW_SCENARIO_EV_SPREAD,
  MAX_WEIGHTED_ROBUST_EV_GAP,
  MINIMUM_DATA_QUALITY,
  UNVERIFIED_EXTREME_EV_LIMIT,
} from '../lib/ev-calibration-v103.js';
import {
  applyIndependentMarketVerification,
  MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  MARKET_VERIFICATION_V2_VERSION,
  MINIMUM_CONSENSUS_BOOKS,
} from '../lib/market-verification-v2.js';

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
const eligibleVerification = (overrides = {}) => ({
  referencePriorEligible: true,
  referenceNoVigProbability: 0.52,
  referenceRobustProbability: 0.515,
  referenceConsensusBookCount: MINIMUM_CONSENSUS_BOOKS,
  referenceConsensusTimeSpanMs: 2 * 60 * 1000,
  referenceConsensusFreshnessMaxMs: 4 * 60 * 1000,
  referenceProbabilitySpread: 0.02,
  referenceProbabilityMad: 0.005,
  ...overrides,
});
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
assert.equal(noPriorExtreme.status, 'EXTREME_EV_HELD_FOR_LOCKED_OOS');
assert.match(noPriorExtreme.reasons.join('｜'), /locked OOS/);

const moderateNoPrior = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: {
      referencePriorEligible: false,
      priorIneligibleReason: '缺少至少3家獨立國際市場的同合約去水機率',
    },
  },
  rawWeightedEV: 0.08,
  rawRobustEV: 0.025,
  modelProbability: 0.55,
  rebateRate: 0.015,
  gate,
});
assert.match(EV_CALIBRATION_V103_VERSION, /v10\.4\.1/);
assert.equal(moderateNoPrior.qualified, false, 'V10.4 must fail closed when no independent consensus prior exists');
assert.equal(moderateNoPrior.weightedEV, null);
assert.equal(moderateNoPrior.robustEV, null);
assert.equal(moderateNoPrior.status, 'CALIBRATION_BLOCK');
assert.match(moderateNoPrior.reasons.join('｜'), /3家獨立國際市場/);

const qualifiedConsensus = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.045,
  rawRobustEV: 0.012,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(qualifiedConsensus.qualified, true);
assert.equal(qualifiedConsensus.status, 'QUALIFIED_WITH_INDEPENDENT_EXACT_CONTRACT_CONSENSUS');
assert.ok(Math.abs(qualifiedConsensus.weightedEV - qualifiedConsensus.referenceEV) < 1e-12);
assert.ok(Math.abs(qualifiedConsensus.robustEV - qualifiedConsensus.referenceRobustEV) < 1e-12);
assert.notEqual(qualifiedConsensus.weightedEV, qualifiedConsensus.rawWeightedEV, 'usable W must come from independent price consensus, not raw model EV');
assert.ok(qualifiedConsensus.robustEV <= qualifiedConsensus.weightedEV);

const optionalMissingDoesNotBlock = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.045,
  rawRobustEV: 0.012,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate: {
    passedForShadowScore: true,
    quality: 0.71,
    rows: [
      { id: 'starter', core: true, status: 'CONFIRMED' },
      { id: 'team-season', core: true, status: 'CONFIRMED' },
      { id: 'lineups', core: false, status: 'MISSING' },
      { id: 'umpire', core: false, status: 'MISSING' },
      { id: 'weather', core: false, status: 'PROJECTED' },
    ],
  },
});
assert.equal(MINIMUM_DATA_QUALITY, 0.85);
assert.equal(optionalMissingDoesNotBlock.qualified, true, 'optional missing inputs must increase uncertainty, not trip the core hard gate');
assert.equal(optionalMissingDoesNotBlock.qualificationDataQuality, 0.97);
assert.equal(optionalMissingDoesNotBlock.overallDataQuality, 0.71);

const projectedCoreStillBlocks = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.045,
  rawRobustEV: 0.012,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate: {
    passedForShadowScore: true,
    quality: 0.90,
    rows: [
      { id: 'starter', core: true, status: 'PROJECTED' },
      { id: 'team-season', core: true, status: 'PROJECTED' },
      { id: 'market-contract', core: true, status: 'PROJECTED' },
      { id: 'market-water', core: true, status: 'PROJECTED' },
    ],
  },
});
assert.equal(projectedCoreStillBlocks.qualified, false, 'the 0.85 hard gate must remain enforced for core data');
assert.ok(Math.abs(projectedCoreStillBlocks.qualificationDataQuality - 0.81) < 1e-12);
assert.match(projectedCoreStillBlocks.reasons.join('｜'), /核心資料品質0\.81低於0\.85/);

const unstableRawScenario = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.08,
  rawRobustEV: -0.01,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(unstableRawScenario.qualified, false);
assert.ok(unstableRawScenario.rawScenarioSpread > MAX_RAW_SCENARIO_EV_SPREAD);
assert.match(unstableRawScenario.reasons.join('｜'), /中央與壓力情境EV差距/);

const unstableConsensus = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification({ referenceNoVigProbability: 0.54 }),
  },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.54,
  rebateRate: 0.015,
  gate,
});
assert.equal(unstableConsensus.qualified, false);
assert.ok(unstableConsensus.weightedRobustGap > MAX_WEIGHTED_ROBUST_EV_GAP);
assert.match(unstableConsensus.reasons.join('｜'), /獨立市場加權與保守EV差距/);

const confirmedExtreme = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.55, referenceRobustProbability: 0.545 }) },
  rawWeightedEV: 0.20,
  rawRobustEV: 0.12,
  modelProbability: 0.56,
  rebateRate: 0.015,
  gate,
});
assert.equal(confirmedExtreme.qualified, false, '15%+ raw EV must remain blocked even when an independent prior agrees');
assert.equal(confirmedExtreme.weightedEV, null);
assert.equal(confirmedExtreme.robustEV, null);
assert.equal(confirmedExtreme.status, 'EXTREME_EV_HELD_FOR_LOCKED_OOS');
assert.match(confirmedExtreme.reasons.join('｜'), /只供稽核/);

const disagreement = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.51, referenceRobustProbability: 0.505 }) },
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
const consensusBookKeys = ['book-a', 'book-b', 'book-c'];
const consensusEvidence = {
  referenceProbabilitySpread: 0.02,
  referenceProbabilityMad: 0.005,
  referenceEvidenceEligible: true,
  consensusBookCount: MINIMUM_CONSENSUS_BOOKS,
  consensusBookKeys,
  consensusOldestObservedAt: observedAt,
  consensusNewestObservedAt: observedAt,
  consensusTimeSpanMs: 0,
  consensusFreshnessMaxMs: 0,
  consensusSnapshotId: 'THE_ODDS_API:event-1:TOTAL:8.50:snapshot-1',
};
const references = [
  {
    market: '全場大小', pick: '大8.5', water: 0.91, sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS', providerEventId: 'event-1', lineAsOf: observedAt,
    referenceNoVigProbability: 0.51, referenceRobustProbability: 0.5025,
    referenceProbabilityMinimum: 0.50, referenceProbabilityMaximum: 0.52,
    ...consensusEvidence,
  },
  {
    market: '全場大小', pick: '小8.5', water: 0.95, sourceType: 'INTERNATIONAL', provider: 'THE_ODDS_API_CONSENSUS', providerEventId: 'event-1', lineAsOf: observedAt,
    referenceNoVigProbability: 0.49, referenceRobustProbability: 0.4825,
    referenceProbabilityMinimum: 0.48, referenceProbabilityMaximum: 0.50,
    ...consensusEvidence,
  },
];
const verificationNow = Date.parse(observedAt) + 4 * 60 * 1000;
const verified = applyIndependentMarketVerification(
  actual,
  references,
  MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  verificationNow,
);
assert.equal(verified[0].marketVerification.version, MARKET_VERIFICATION_V2_VERSION);
assert.equal(verified[0].marketVerification.referencePriorEligible, true);
assert.equal(verified[1].marketVerification.referencePriorEligible, true);
assert.equal(verified[0].marketVerification.referenceConsensusBookCount, MINIMUM_CONSENSUS_BOOKS);
assert.ok(verified[0].marketVerification.referenceRobustProbability <= verified[0].marketVerification.referenceNoVigProbability);
assert.ok(Math.abs(
  verified[0].marketVerification.referenceNoVigProbability
    + verified[1].marketVerification.referenceNoVigProbability
    - 1
) < 1e-12);

const insufficientBooks = applyIndependentMarketVerification(
  actual,
  references.map(row => ({
    ...row,
    consensusBookCount: MINIMUM_CONSENSUS_BOOKS - 1,
    consensusBookKeys: consensusBookKeys.slice(0, MINIMUM_CONSENSUS_BOOKS - 1),
    referenceEvidenceEligible: false,
  })),
  MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  verificationNow,
);
assert.equal(insufficientBooks[0].marketVerification.referencePriorEligible, false);
assert.equal(insufficientBooks[0].marketVerification.referenceNoVigProbability, null);
assert.match(insufficientBooks[0].marketVerification.priorIneligibleReason, /至少需要3家/);

const integerVerified = applyIndependentMarketVerification(
  [{ ...actual[0], pick: '大8平' }, { ...actual[1], pick: '小8平' }],
  [{ ...references[0], pick: '大8平' }, { ...references[1], pick: '小8平' }],
  MAX_ACTUAL_REFERENCE_DISTANCE_MS,
  verificationNow,
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
