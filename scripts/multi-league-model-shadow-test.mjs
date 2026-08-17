import assert from 'node:assert/strict';
import {
  FORMAL_ANALYSIS_MODE,
  MODEL_VERSION,
  RULES_VERSION,
  SHADOW_ANALYSIS_MODE,
  SHADOW_RESULT_TAG,
  SHADOW_SCORE_TYPE,
  analyzeMarkets,
  assertAnalysisModeContract,
  buildDistributionSnapshot,
  enforceAnalysisModeSafety,
  enforceShadowAnalysisSafety,
  estimateRuns,
  normalizeModelConfig,
  repriceMarkets,
} from '../lib/analysis.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer.js';

const team = (offenseIndex = 1) => ({
  seasonHitting: { gamesPlayed: 120, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  recentHitting: { gamesPlayed: 12, runsPerGame: 4.35, ops: 0.72, iso: 0.15, kRate: 0.225, bbRate: 0.085 },
  vsLeft: { available: true, ops: 0.72 },
  vsRight: { available: true, ops: 0.72 },
  lineup: { projected: true, offensiveIndex: offenseIndex, players: [] },
  injuryImpact: 0,
  baserunning: { runIndex: 1 },
  defense: { available: true, fieldingPercentage: 0.985, errorsPerGame: 0.55 },
  recentPitching: { inningsPitched: 50, era: 4.2, whip: 1.3 },
  bullpen: { usageAvailable: true, fatigueIndex: 0.2, highLeverageAvailability: 0.75, qualityFactor: 1 },
  rest: { available: true, days: 1, travelKm: 0 },
  starter: {
    available: true,
    confirmed: true,
    throws: 'R',
    expectedInnings: 5.2,
    season: { gamesStarted: 20, inningsPitched: 110, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    recent: { gamesStarted: 5, inningsPitched: 27, era: 4.2, fip: 4.2, whip: 1.3, kMinusBB: 0.14, hrPer9: 1.15 },
    pitchQuality: { available: true, runFactor: 1 },
  },
});

const baseContext = {
  coreModelable: true,
  coreFingerprint: 'scoring-calibration-regression-v1',
  game: { gamePk: 990001, away: '客隊', home: '主隊' },
  league: { runsPerTeamGame: 4.35 },
  away: team(),
  home: team(),
  park: { runFactor: 1, roof: 'open' },
  weather: { available: true, temperature: 21, windSpeed: 0, precipitationProbability: 0, roofConfirmed: true },
  umpire: { name: 'Regression Umpire' },
  featureProvenance: [],
};

const settings = {
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 500,
};

// This exact hash was measured before modelConfig support was added. The
// absence of extra model-contract keys is intentional and protects the frozen
// MLB deterministic distribution contract byte-for-byte.
const MLB_GOLDEN_DISTRIBUTION_HASH = '4cea57055a75a26141b51e69002dd30a5c31f345a29547ac76ff2518b23218fa';
const mlbSnapshot = buildDistributionSnapshot({ context: baseContext, settings });
assert.equal(mlbSnapshot.distributionHash, MLB_GOLDEN_DISTRIBUTION_HASH);
assert.equal(mlbSnapshot.modelVersion, MODEL_VERSION);
assert.equal(mlbSnapshot.rulesVersion, RULES_VERSION);
assert.equal(mlbSnapshot.drawProb, 0);
assert.equal(Object.hasOwn(mlbSnapshot, 'modelConfig'), false);
assert.equal(Object.hasOwn(mlbSnapshot, 'analysisMode'), false);

const nestedModelConfig = {
  baselineBounds: {
    full: { min: 3.6, max: 5.2 },
    first5: { min: 1.8, max: 3.1 },
  },
  scoreClamps: {
    full: { min: 1.8, max: 8.2 },
    first5: { min: 0.6, max: 5.0 },
  },
  homeCoefficient: { full: 1.018, first5: 1.009 },
  shrink: { full: 0.71, first5: 0.68 },
  extraInningsLimit: 0,
  allowDraw: true,
};
const normalized = normalizeModelConfig(nestedModelConfig);
assert.deepEqual(normalized.baselineBounds.full, { min: 3.6, max: 5.2 });
assert.deepEqual(normalized.baselineBounds.first5, { min: 1.8, max: 3.1 });
assert.deepEqual(normalized.scoreClamps.full, { min: 1.8, max: 8.2 });
assert.deepEqual(normalized.scoreClamps.first5, { min: 0.6, max: 5.0 });
assert.deepEqual(normalized.shrink, { full: 0.71, first5: 0.68 });

const flatNormalized = normalizeModelConfig({
  baselineMin: 3.5,
  baselineMax: 5.1,
  fullRunMin: 1.7,
  fullRunMax: 8.1,
  first5RunMin: 0.5,
  first5RunMax: 4.9,
  homeAdvantageFull: 1.02,
  homeAdvantageF5: 1.01,
  shrink: 0.7,
  extraInningsLimit: 3,
  allowDraw: true,
});
assert.deepEqual(flatNormalized.baselineBounds.full, { min: 3.5, max: 5.1 });
assert.deepEqual(flatNormalized.scoreClamps.first5, { min: 0.5, max: 4.9 });
assert.deepEqual(flatNormalized.shrink, { full: 0.7, first5: 0.7 });

const shadowContext = {
  ...baseContext,
  coreFingerprint: 'npb-shadow-model-contract-v1',
  leagueId: 'NPB',
  game: { ...baseContext.game, gamePk: 550001, leagueId: 'NPB' },
  league: { id: 'NPB', runsPerTeamGame: 4.05 },
  analysisMode: SHADOW_ANALYSIS_MODE,
  modelVersion: 'NPB-JOINT-SCORE-SHADOW-2026-08-v1.0.0',
  rulesVersion: 'NPB-TW-SHADOW-2026-08-v1.0.0',
  modelConfig: nestedModelConfig,
};
const shadowContract = assertAnalysisModeContract(shadowContext);
assert.equal(shadowContract.leagueId, 'NPB');
assert.equal(shadowContract.shadow, true);
assert.ok(shadowContract.modelContractHash);

assert.throws(
  () => assertAnalysisModeContract({ ...shadowContext, modelConfig: undefined }),
  /缺少 modelConfig/,
);
assert.throws(
  () => assertAnalysisModeContract({ ...shadowContext, modelConfig: {} }),
  /缺少 modelConfig/,
);
assert.throws(
  () => normalizeModelConfig({ shrink: 'invalid' }),
  /shrink 必須是數字或物件/,
);
assert.throws(
  () => assertAnalysisModeContract({ ...shadowContext, analysisMode: FORMAL_ANALYSIS_MODE }),
  /只允許 EXPERIMENTAL_SHADOW/,
);
assert.throws(
  () => assertAnalysisModeContract({ ...shadowContext, betEligible: true }),
  /不得宣告 betEligible 或 executable/,
);

const shadowSnapshot = buildDistributionSnapshot({ context: shadowContext, settings });
assert.equal(shadowSnapshot.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(shadowSnapshot.modelVersion, shadowContext.modelVersion);
assert.equal(shadowSnapshot.rulesVersion, shadowContext.rulesVersion);
assert.equal(shadowSnapshot.modelContractHash, shadowContract.modelContractHash);
assert.ok(shadowSnapshot.modelCoreFingerprint);
assert.ok(shadowSnapshot.drawProb > 0 && shadowSnapshot.drawProb < 1);
assert.notEqual(shadowSnapshot.distributionHash, mlbSnapshot.distributionHash);

const alteredConfigContext = {
  ...shadowContext,
  modelConfig: { ...nestedModelConfig, shrink: { full: 0.73, first5: 0.68 } },
};
const alteredSnapshot = buildDistributionSnapshot({ context: alteredConfigContext, settings });
assert.notEqual(alteredSnapshot.modelContractHash, shadowSnapshot.modelContractHash);
assert.notEqual(alteredSnapshot.modelCoreFingerprint, shadowSnapshot.modelCoreFingerprint);
assert.notEqual(alteredSnapshot.distributionHash, shadowSnapshot.distributionHash);

const expectedRuns = estimateRuns(shadowContext);
assert.ok(expectedRuns.away >= nestedModelConfig.scoreClamps.full.min);
assert.ok(expectedRuns.away <= nestedModelConfig.scoreClamps.full.max);
assert.ok(expectedRuns.home >= nestedModelConfig.scoreClamps.full.min);
assert.ok(expectedRuns.home <= nestedModelConfig.scoreClamps.full.max);

const direction = (market, pick, water) => ({
  market,
  pick,
  water,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
});
const markets = [
  direction('全場讓分', '客隊讓1平', 0.95),
  direction('全場讓分', '主隊受讓1平', 0.95),
  direction('全場大小', '大8.5', 0.94),
  direction('全場大小', '小8.5', 0.94),
  direction('上半讓分', '客隊讓0.5', 0.94),
  direction('上半讓分', '主隊受讓0.5', 0.94),
  direction('上半大小', '大4.5', 0.93),
  direction('上半大小', '小4.5', 0.93),
];

const preliminary = analyzeMarkets({ context: shadowContext, markets, settings });
assert.equal(preliminary.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(preliminary.scoreType, SHADOW_SCORE_TYPE);
assert.equal(preliminary.tag, SHADOW_RESULT_TAG);
assert.equal(preliminary.executable, false);
assert.equal(preliminary.betEligible, false);
assert.deepEqual(preliminary.portfolio, []);
assert.equal(preliminary.drawProb, shadowSnapshot.drawProb);
assert.equal(preliminary.results.length, 8);
for (const row of preliminary.results) {
  assert.equal(row.analysisMode, SHADOW_ANALYSIS_MODE);
  assert.equal(row.executable, false);
  assert.equal(row.betEligible, false);
  assert.equal(row.scoreType, SHADOW_SCORE_TYPE);
  assert.equal(row.tag, SHADOW_RESULT_TAG);
  assert.equal(row.unitSuggestion, null);
}

assert.throws(
  () => repriceMarkets({
    context: alteredConfigContext,
    markets,
    settings,
    distributionSnapshot: shadowSnapshot,
  }),
  /模型契約不相容/,
);

const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: shadowContext.game, settings });
assert.ok(finalized.results.some(row => Number.isFinite(Number(row.score))), 'shadow 仍須保留固定公式診斷分數');
const secured = enforceShadowAnalysisSafety({
  ...finalized,
  executable: true,
  betEligible: true,
  portfolio: [{ pick: '不應保留' }],
  context: { analysisMode: FORMAL_ANALYSIS_MODE, executable: true, betEligible: true },
  frozenContext: { analysisMode: FORMAL_ANALYSIS_MODE, executable: true, betEligible: true },
  analysis: {
    ...finalized,
    executable: true,
    betEligible: true,
    portfolio: [{ pick: 'nested-unsafe' }],
    results: finalized.results.map(row => ({ ...row, executable: true, betEligible: true, tag: '正式候選' })),
  },
  repriceSnapshot: {
    analysisMode: FORMAL_ANALYSIS_MODE,
    executable: true,
    betEligible: true,
    portfolio: [{ pick: 'reprice-unsafe' }],
    context: { analysisMode: FORMAL_ANALYSIS_MODE, executable: true, betEligible: true },
    frozenContext: { analysisMode: FORMAL_ANALYSIS_MODE, executable: true, betEligible: true },
    results: finalized.results.map(row => ({ ...row, executable: true, betEligible: true, tag: '正式候選' })),
  },
  results: finalized.results.map(row => ({
    ...row,
    executable: true,
    betEligible: true,
    scoreType: '正式下注評分',
    tag: '正式候選',
    unitSuggestion: 1,
    portfolioUnit: 1,
  })),
}, shadowContext);
assert.equal(enforceAnalysisModeSafety, enforceShadowAnalysisSafety);
assert.equal(secured.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(secured.executable, false);
assert.equal(secured.betEligible, false);
assert.deepEqual(secured.portfolio, []);
for (const value of [secured.context, secured.frozenContext]) {
  assert.equal(value.analysisMode, SHADOW_ANALYSIS_MODE);
  assert.equal(value.executable, false);
  assert.equal(value.betEligible, false);
}
assert.equal(secured.analysis.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(secured.analysis.executable, false);
assert.equal(secured.analysis.betEligible, false);
assert.deepEqual(secured.analysis.portfolio, []);
assert.equal(secured.repriceSnapshot.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(secured.repriceSnapshot.executable, false);
assert.equal(secured.repriceSnapshot.betEligible, false);
assert.deepEqual(secured.repriceSnapshot.portfolio, []);
for (const value of [secured.repriceSnapshot.context, secured.repriceSnapshot.frozenContext]) {
  assert.equal(value.analysisMode, SHADOW_ANALYSIS_MODE);
  assert.equal(value.executable, false);
  assert.equal(value.betEligible, false);
}
for (const row of [...secured.analysis.results, ...secured.repriceSnapshot.results]) {
  assert.equal(row.executable, false);
  assert.equal(row.betEligible, false);
  assert.equal(row.scoreType, SHADOW_SCORE_TYPE);
  assert.equal(row.tag, SHADOW_RESULT_TAG);
}
for (const row of secured.results) {
  assert.equal(row.executable, false);
  assert.equal(row.betEligible, false);
  assert.equal(row.scoreType, SHADOW_SCORE_TYPE);
  assert.equal(row.tag, SHADOW_RESULT_TAG);
  assert.equal(row.unitSuggestion, null);
  assert.equal(row.portfolioUnit, null);
  assert.ok(Number.isFinite(Number(row.score)) || row.score == null);
}

console.log(JSON.stringify({
  ok: true,
  mlbGoldenDistributionHash: mlbSnapshot.distributionHash,
  shadowDistributionHash: shadowSnapshot.distributionHash,
  alteredDistributionHash: alteredSnapshot.distributionHash,
  shadowDrawProb: shadowSnapshot.drawProb,
  scoredShadowDirections: secured.results.filter(row => Number.isFinite(Number(row.score))).length,
}, null, 2));
