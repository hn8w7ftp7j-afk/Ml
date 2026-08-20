import assert from 'node:assert/strict';
import { normalizeModelConfig, SHADOW_ANALYSIS_MODE } from '../lib/analysis.js';
import {
  ANALYSIS_V10_VERSION,
  MODEL_VERSION,
  RULES_VERSION,
  analyzeMarkets,
  buildDistributionSnapshot,
  repriceMarkets,
} from '../lib/analysis-v10.js';
import {
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
  finalizeDeterministicAnalysis,
} from '../lib/deterministic-finalizer-v10.js';

const team = (offenseIndex = 1) => ({
  seasonHitting: { available: true, gamesPlayed: 120, runsPerGame: 4.48, ops: 0.73, iso: 0.16, kRate: 0.225, bbRate: 0.085 },
  recentHitting: { available: true, gamesPlayed: 12, runsPerGame: 4.50, ops: 0.735, iso: 0.162, kRate: 0.22, bbRate: 0.087 },
  vsLeft: { available: true, ops: 0.72 },
  vsRight: { available: true, ops: 0.73 },
  lineup: { projected: true, offensiveIndex: offenseIndex, players: [], catcher: 'Catcher' },
  injuryImpact: 0.006,
  baserunning: { runIndex: 1 },
  defense: { available: true, fieldingPercentage: 0.985, errorsPerGame: 0.55 },
  recentPitching: { inningsPitched: 50, era: 4.2, whip: 1.3 },
  bullpen: { usageAvailable: true, fatigueIndex: 0.2, highLeverageAvailability: 0.8, qualityFactor: 1 },
  rest: { available: true, days: 1, travelKm: 0 },
  starter: {
    available: true,
    confirmed: true,
    throws: 'R',
    expectedInnings: 5.4,
    season: { gamesStarted: 20, inningsPitched: 110, era: 4.05, fip: 4.10, whip: 1.27, kMinusBB: 0.15, hrPer9: 1.10 },
    recent: { gamesStarted: 5, inningsPitched: 27, era: 4.00, fip: 4.08, whip: 1.25, kMinusBB: 0.16, hrPer9: 1.05 },
    pitchQuality: { available: true, runFactor: 1 },
  },
});

const modelConfig = normalizeModelConfig({
  baselineBounds: { full: { min: 3.8, max: 5.2 }, first5: { min: 1.9, max: 3.2 } },
  scoreClamps: { full: { min: 2.0, max: 7.6 }, first5: { min: 0.7, max: 4.7 } },
  homeCoefficient: { full: 1.02, first5: 1.01 },
  shrink: { full: 0.76, first5: 0.74 },
  extraInningsLimit: 12,
  allowDraw: false,
});

const context = {
  coreModelable: true,
  coreFingerprint: 'v10-raw-distribution-regression',
  leagueId: 'MLB',
  game: { gamePk: 880001, away: '客隊', home: '主隊', leagueId: 'MLB' },
  league: { id: 'MLB', runsPerTeamGame: 4.4788, era: 4.2, kPer9: 8.5, bbPer9: 3.2, hrPer9: 1.15 },
  away: team(1.02),
  home: team(0.99),
  park: { runFactor: 1.01, roof: 'open' },
  weather: {
    available: true,
    temperature: 24,
    meanRunFactorV10: 1.01,
    windSpeed: 8,
    windDirection: 180,
    directionalWindApplied: false,
    precipitationProbability: 0,
    roofConfirmed: true,
  },
  umpire: { name: 'Regression Umpire' },
  featureProvenance: [],
  dataGateV10: {
    version: 'TEST-V10',
    rows: [],
    missing: [],
    projected: ['parkFactor'],
    blocking: [],
    passedForShadowScore: true,
    passedForFormalScore: false,
    quality: 0.90,
    modelErrorMarginEV: 0.003,
  },
  analysisMode: SHADOW_ANALYSIS_MODE,
  modelVersion: MODEL_VERSION,
  rulesVersion: RULES_VERSION,
  modelConfig,
};

const settings = { rebateRate: 0.015, simulationsPerScenario: 4000, candidateThreshold: 7.2, strongestThreshold: 8.5 };
const direction = (market, pick, water) => ({
  market,
  pick,
  water,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
  marketVerification: { verified: false },
});
const markets = [
  direction('全場讓分', '客隊讓1平', 0.95),
  direction('全場讓分', '主隊受讓1平', 0.95),
  direction('全場大小', '大9平', 0.94),
  direction('全場大小', '小9平', 0.94),
  direction('上半讓分', '客隊讓0.5', 0.94),
  direction('上半讓分', '主隊受讓0.5', 0.94),
  direction('上半大小', '大5平', 0.93),
  direction('上半大小', '小5平', 0.93),
];

const snapshot = buildDistributionSnapshot({ context, settings });
const repeated = buildDistributionSnapshot({ context, settings });
assert.equal(snapshot.distributionHash, repeated.distributionHash, '相同核心與seed必須得到相同分布');
const totalProbability = snapshot.combinedJoint.reduce((sum, row) => sum + Number(row[4]), 0);
assert.ok(Math.abs(totalProbability - 1) < 1e-9);
assert.equal(snapshot.simulationsPerScenario, 4000);

const preliminary = analyzeMarkets({ context, markets, settings });
assert.equal(preliminary.engineVersion, ANALYSIS_V10_VERSION);
assert.equal(preliminary.scenarioSummary.targetPriceCalibratesDistribution, false);
assert.equal(preliminary.scenarioSummary.marketProbabilityCalibrationApplied, false);
assert.equal(preliminary.results.length, 8);
for (const row of preliminary.results) {
  assert.equal(row.marketCalibrationApplied, false);
  assert.equal(row.targetPriceCalibratesDistribution, false);
  assert.ok(Number.isFinite(Number(row.weightedEV)));
  assert.ok(Number.isFinite(Number(row.robustEV)));
  assert.ok(row.robustEV <= row.weightedEV + 1e-12);
  assert.equal(row.evDoubleCheck.passed, true);
  assert.ok(Math.abs(row.distributionCoverage - 1) < 1e-9);
}

const repricedMarkets = markets.map(row => row.pick === '小9平' ? { ...row, water: 0.90 } : row);
const repriced = repriceMarkets({ context, markets: repricedMarkets, settings, distributionSnapshot: snapshot });
const originalUnder = preliminary.results.find(row => row.pick === '小9平');
const repricedUnder = repriced.results.find(row => row.pick === '小9平');
assert.equal(repriced.distributionHash, preliminary.distributionHash);
assert.ok(Math.abs(originalUnder.modelProbability - repricedUnder.modelProbability) < 1e-12,
  'Tai888水位改變不得反向改寫棒球模型勝率');
assert.notEqual(originalUnder.weightedEV, repricedUnder.weightedEV, '成交水位改變必須重算payoff EV');

const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
assert.equal(FORMAL_SCORING_ENABLED, false);
assert.equal(SCORE_RELEASE_STATUS, 'SHADOW_VALIDATED_NOT_FORMAL');
assert.equal(finalized.formalScoringEnabled, false);
assert.equal(finalized.formalRecommendationsEnabled, false);
assert.ok(finalized.results.some(row => Number.isFinite(Number(row.shadowDiagnosticScore))), '至少應保留可稽核影子分數');
for (const row of finalized.results) {
  assert.equal(row.score, null, '正式分數仍須為null');
  assert.equal(row.betEligible, false);
  assert.ok(['SHADOW_VALIDATED', 'BLOCKED'].includes(row.scoreStatus));
  if (row.scoreStatus === 'SHADOW_VALIDATED') assert.ok(Number.isFinite(Number(row.shadowDiagnosticScore)));
}

console.log(JSON.stringify({
  ok: true,
  modelVersion: MODEL_VERSION,
  distributionHash: snapshot.distributionHash,
  displayedShadowScores: finalized.results.filter(row => Number.isFinite(Number(row.shadowDiagnosticScore))).length,
  underProbabilityStable: repricedUnder.modelProbability,
}, null, 2));
