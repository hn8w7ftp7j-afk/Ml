import assert from 'node:assert/strict';
import { estimateRunProfileV103, MLB_RUN_MODEL_V103_VERSION } from '../lib/mlb-run-model-v103.js';
import {
  aggregatePayoffVectorEV,
  evFromPayoffVector,
  minimumWaterFromPayoffVector,
  qualifyEvV103 as qualifyEvV103Core,
  ABSOLUTE_MARKET_EDGE_LIMIT,
  EV_CALIBRATION_V103_VERSION,
  MAX_RAW_SCENARIO_EV_SPREAD,
  MAX_WEIGHTED_ROBUST_EV_GAP,
  MINIMUM_DATA_QUALITY,
  UNVERIFIED_EXTREME_EV_LIMIT,
  UNVERIFIED_MARKET_EDGE_LIMIT,
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
const readerRow = (row = {}) => ({
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineFresh: true,
  executable: true,
  ...row,
});
const qualifyEvV103 = input => qualifyEvV103Core({ ...input, row: readerRow(input?.row) });
const noPriorExtreme = qualifyEvV103({
  row: { water: 0.94, marketVerification: { referencePriorEligible: false } },
  rawWeightedEV: 0.22,
  rawRobustEV: 0.14,
  modelProbability: 0.63,
  rebateRate: 0.015,
  gate,
});
assert.equal(UNVERIFIED_EXTREME_EV_LIMIT, 0.15);
assert.equal(noPriorExtreme.qualified, true);
assert.equal(noPriorExtreme.weightedEV, 0.22);
assert.equal(noPriorExtreme.status, 'QUALIFIED_MODEL_EV_EXTERNAL_AUDIT_UNAVAILABLE');
assert.equal(noPriorExtreme.extreme, true);
assert.match(noPriorExtreme.auditWarnings.join('｜'), /待複核/);

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
assert.match(EV_CALIBRATION_V103_VERSION, /v10\.5\.1/);
assert.equal(moderateNoPrior.qualified, true, 'international markets are optional audit evidence');
assert.equal(moderateNoPrior.weightedEV, 0.08);
assert.equal(moderateNoPrior.robustEV, 0.025);
assert.equal(moderateNoPrior.status, 'QUALIFIED_MODEL_EV_EXTERNAL_AUDIT_UNAVAILABLE');
assert.match(moderateNoPrior.auditWarnings.join('｜'), /不影響模型W\/R/);

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
assert.equal(qualifiedConsensus.status, 'QUALIFIED_MODEL_EV_WITH_INDEPENDENT_MARKET_AUDIT');
assert.ok(Math.abs(qualifiedConsensus.weightedEV - qualifiedConsensus.rawWeightedEV) < 1e-12);
assert.ok(Math.abs(qualifiedConsensus.robustEV - qualifiedConsensus.rawRobustEV) < 1e-12);
assert.notEqual(qualifiedConsensus.weightedEV, qualifiedConsensus.referenceEV, 'independent market price must not replace model W');
assert.ok(qualifiedConsensus.robustEV <= qualifiedConsensus.weightedEV);
assert.equal(qualifiedConsensus.actualReaderEligible, true);

const staleReader = qualifyEvV103({
  row: {
    water: 0.94,
    lineFresh: false,
    executable: false,
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.045,
  rawRobustEV: 0.012,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(staleReader.qualified, false, 'expired Reader prices must never retain W/R or a score');
assert.equal(staleReader.actualReaderEligible, false);
assert.equal(staleReader.weightedEV, null);
assert.match(staleReader.reasons.join('｜'), /Reader 實際盤已過期/);

const manualEntry = qualifyEvV103({
  row: {
    water: 0.94,
    sourceType: 'USER_MANUAL_ENTRY',
    provider: 'USER_MANUAL_ENTRY',
    marketVerification: eligibleVerification(),
  },
  rawWeightedEV: 0.045,
  rawRobustEV: 0.012,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(manualEntry.qualified, false, 'manual entries may be recorded but must never create W/R or ranking');
assert.equal(manualEntry.actualReaderSource, false);
assert.equal(manualEntry.weightedEV, null);
assert.match(manualEntry.reasons.join('｜'), /只允許 Tai888 Reader/);

const overEightPlusEightyVector = ({ below, exact, above, bookmakerKey = '' }) => ({
  bookmakerKey,
  equivalentWin: above + 0.8 * exact,
  equivalentLoss: below,
  equivalentPush: 0.2 * exact,
});
const payoffVector = overEightPlusEightyVector({ below: 0.47, exact: 0.10, above: 0.43 });
const referenceBookPayoffVectors = [
  overEightPlusEightyVector({ bookmakerKey: 'book-a', below: 0.47, exact: 0.10, above: 0.43 }),
  overEightPlusEightyVector({ bookmakerKey: 'book-b', below: 0.475, exact: 0.09, above: 0.435 }),
  overEightPlusEightyVector({ bookmakerKey: 'book-c', below: 0.465, exact: 0.11, above: 0.425 }),
];
const payoffAggregate = aggregatePayoffVectorEV(referenceBookPayoffVectors, 0.94, 0.015);
assert.ok(Math.abs(payoffVector.equivalentWin - 0.51) < 1e-12, '大8+80 exact bucket must settle 80% as a partial win');
assert.ok(Math.abs(payoffVector.equivalentLoss - 0.47) < 1e-12);
assert.ok(Math.abs(payoffVector.equivalentPush - 0.02) < 1e-12, 'the unsettled 20% of the exact bucket must remain push');
assert.ok(Math.abs(evFromPayoffVector(payoffVector, 0.94, 0.015) - (0.51 * 0.955 - 0.47 * 0.985)) < 1e-12);
assert.ok(Math.abs(payoffAggregate.weightedEV - 0.0241) < 1e-12, 'W must be the median of the three bookmaker payoff EVs');
assert.ok(Math.abs(payoffAggregate.robustEV - 0.0091) < 1e-12, 'R must be min(q10, W-0.015)');
assert.ok(payoffAggregate.robustEV <= payoffAggregate.weightedEV, 'R must never exceed W');

const payoffConsensus = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification({
      // The payoff path must use A/(A+B), not this legacy binary field.
      referenceNoVigProbability: 0.90,
      referenceRobustProbability: 0.89,
      referencePayoffVector: payoffVector,
      referenceBookPayoffVectors,
    }),
  },
  rawWeightedEV: 0.03,
  rawRobustEV: 0.005,
  modelProbability: 0.52,
  rebateRate: 0.015,
  gate,
});
assert.equal(payoffConsensus.qualified, true);
assert.equal(payoffConsensus.status, 'QUALIFIED_MODEL_EV_WITH_INDEPENDENT_MARKET_AUDIT');
assert.equal(payoffConsensus.referencePriorType, 'PAYOFF_VECTOR');
assert.ok(Math.abs(payoffConsensus.referenceProbability - (0.51 / 0.98)) < 1e-12, 'model consistency must compare effective win probability A/(A+B)');
assert.ok(Math.abs(payoffConsensus.weightedEV - payoffConsensus.rawWeightedEV) < 1e-12);
assert.ok(Math.abs(payoffConsensus.robustEV - payoffConsensus.rawRobustEV) < 1e-12);
assert.ok(Math.abs(payoffConsensus.marketPriceWeightedEV - payoffAggregate.weightedEV) < 1e-12);
assert.ok(payoffConsensus.robustEV <= payoffConsensus.weightedEV);

const payoffBreakEvenWater = minimumWaterFromPayoffVector(payoffVector, 0, 0.015);
assert.ok(Math.abs(payoffBreakEvenWater - ((0.47 * 0.985) / 0.51 - 0.015)) < 1e-12, 'minimum water must use payoff A/B rather than a binary probability shortcut');
assert.ok(Math.abs(evFromPayoffVector(payoffVector, payoffBreakEvenWater, 0.015)) < 1e-12);

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
assert.equal(projectedCoreStillBlocks.qualified, false, 'core baseball data quality must fail closed');
assert.ok(Math.abs(projectedCoreStillBlocks.qualificationDataQuality - 0.81) < 1e-12);
assert.match(projectedCoreStillBlocks.reasons.join('｜'), /核心棒球資料品質0\.81低於0\.85/);

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
assert.equal(unstableRawScenario.qualified, true, 'unstable scenarios remain visible but cannot rank');
assert.ok(unstableRawScenario.rawScenarioSpread > MAX_RAW_SCENARIO_EV_SPREAD);
assert.equal(unstableRawScenario.scenarioStable, false);
assert.match(unstableRawScenario.auditWarnings.join('｜'), /情境差距/);

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
assert.equal(unstableConsensus.qualified, true);
assert.ok(unstableConsensus.weightedRobustGap > MAX_WEIGHTED_ROBUST_EV_GAP);
assert.match(unstableConsensus.auditWarnings.join('｜'), /獨立市場加權與保守價格差距/);

const confirmedExtreme = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.53, referenceRobustProbability: 0.525 }) },
  rawWeightedEV: 0.20,
  rawRobustEV: 0.12,
  modelProbability: 0.56,
  rebateRate: 0.015,
  gate,
});
assert.equal(confirmedExtreme.qualified, true, '15%+ raw model EV stays visible for review');
assert.equal(confirmedExtreme.weightedEV, 0.20);
assert.equal(confirmedExtreme.robustEV, 0.12);
assert.match(confirmedExtreme.auditWarnings.join('｜'), /待複核/);

const disagreement = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.50, referenceRobustProbability: 0.495 }) },
  rawWeightedEV: 0.20,
  rawRobustEV: 0.12,
  modelProbability: 0.63,
  rebateRate: 0.015,
  gate,
});
assert.equal(disagreement.qualified, true, 'external disagreement is audit-only');
assert.match(disagreement.auditWarnings.join('｜'), /機率差距/);
assert.match(disagreement.auditWarnings.join('｜'), /方向相反/);

const extremeIndependentMarketGap = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.65, referenceRobustProbability: 0.645 }) },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(UNVERIFIED_MARKET_EDGE_LIMIT, 0.05);
assert.equal(ABSOLUTE_MARKET_EDGE_LIMIT, 0.15);
assert.equal(extremeIndependentMarketGap.qualified, true, 'external price anomalies must not hide model W/R');
assert.equal(extremeIndependentMarketGap.status, 'QUALIFIED_MODEL_EV_WITH_INDEPENDENT_MARKET_AUDIT');
assert.match(extremeIndependentMarketGap.auditWarnings.join('｜'), /價格差達/);

const unverifiedLargeMarketGap = qualifyEvV103({
  row: { water: 0.94, marketVerification: eligibleVerification({ referenceNoVigProbability: 0.55, referenceRobustProbability: 0.545 }) },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(unverifiedLargeMarketGap.qualified, true, 'external price gaps are audit-only');
assert.match(unverifiedLargeMarketGap.auditWarnings.join('｜'), /第二個外部市場/);

const secondMarketValidatedGap = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification({
      referenceNoVigProbability: 0.55,
      referenceRobustProbability: 0.545,
      secondaryIndependentMarketVerified: true,
    }),
  },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.55,
  rebateRate: 0.015,
  gate,
});
assert.equal(secondMarketValidatedGap.qualified, true, 'a second independent external validation may lift only the 5% review gate');

const exactFivePercentProbability = (0.985 + UNVERIFIED_MARKET_EDGE_LIMIT) / 1.94;
const exactFivePercentBoundary = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification({
      referenceNoVigProbability: exactFivePercentProbability,
      referenceRobustProbability: exactFivePercentProbability - 0.005,
    }),
  },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(exactFivePercentBoundary.qualified, true, 'external 5% boundary remains visible as audit-only');

const exactFifteenPercentProbability = (0.985 + ABSOLUTE_MARKET_EDGE_LIMIT) / 1.94;
const exactFifteenPercentBoundary = qualifyEvV103({
  row: {
    water: 0.94,
    marketVerification: eligibleVerification({
      referenceNoVigProbability: exactFifteenPercentProbability,
      referenceRobustProbability: exactFifteenPercentProbability - 0.005,
      secondaryIndependentMarketVerified: true,
    }),
  },
  rawWeightedEV: 0.04,
  rawRobustEV: 0.01,
  modelProbability: 0.53,
  rebateRate: 0.015,
  gate,
});
assert.equal(exactFifteenPercentBoundary.qualified, true, 'external 15% boundary remains visible as audit-only');

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
