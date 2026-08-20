import assert from 'node:assert/strict';
import {
  FORMAL_ANALYSIS_MODE,
  SHADOW_ANALYSIS_MODE,
  SHADOW_RESULT_TAG,
  SHADOW_SCORE_TYPE,
  analyzeMarkets,
  assertAnalysisModeContract,
  buildDistributionSnapshot,
  enforceAnalysisModeSafety,
  enforceShadowAnalysisSafety,
  normalizeModelConfig,
} from '../lib/analysis.js';
import {
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
  finalizeDeterministicAnalysis,
} from '../lib/deterministic-finalizer.js';
import { leagueAnalysisContract } from '../lib/league-provider.js';
import { LEAGUE_IDS } from '../lib/leagues.js';

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

const settings = {
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 500,
};

const modelConfig = normalizeModelConfig({
  baselineBounds: { full: { min: 3.6, max: 5.2 }, first5: { min: 1.8, max: 3.1 } },
  scoreClamps: { full: { min: 1.8, max: 8.2 }, first5: { min: 0.6, max: 5.0 } },
  homeCoefficient: { full: 1.018, first5: 1.009 },
  shrink: { full: 0.71, first5: 0.68 },
  extraInningsLimit: 0,
  allowDraw: true,
});
assert.deepEqual(modelConfig.shrink, { full: 0.71, first5: 0.68 });

for (const league of LEAGUE_IDS) {
  const contract = leagueAnalysisContract(league);
  assert.equal(contract.analysisMode, SHADOW_ANALYSIS_MODE, `${league}必須由provider強制Shadow`);
  assert.equal(contract.betEligible, false);
  assert.equal(contract.executable, false);
  assert.equal(contract.formalScoringEnabled, false);
  assert.ok(contract.modelConfig);
}

const shadowContext = {
  coreModelable: true,
  coreFingerprint: 'all-league-shadow-regression-v2',
  leagueId: 'NPB',
  game: { gamePk: 550001, away: '客隊', home: '主隊', leagueId: 'NPB' },
  league: { id: 'NPB', runsPerTeamGame: 4.05 },
  away: team(),
  home: team(),
  park: { runFactor: 1, roof: 'open' },
  weather: { available: true, temperature: 21, windSpeed: 0, precipitationProbability: 0, roofConfirmed: true },
  umpire: { name: 'Regression Umpire' },
  featureProvenance: [],
  analysisMode: SHADOW_ANALYSIS_MODE,
  modelVersion: 'NPB-JOINT-SCORE-SHADOW-2026-08-v1.0.0',
  rulesVersion: 'NPB-TW-SHADOW-2026-08-v1.0.0',
  modelConfig,
};

const contract = assertAnalysisModeContract(shadowContext);
assert.equal(contract.shadow, true);
assert.ok(contract.modelContractHash);
assert.throws(() => assertAnalysisModeContract({ ...shadowContext, analysisMode: FORMAL_ANALYSIS_MODE }), /只允許 EXPERIMENTAL_SHADOW/);
assert.throws(() => assertAnalysisModeContract({ ...shadowContext, betEligible: true }), /不得宣告 betEligible 或 executable/);

const snapshot = buildDistributionSnapshot({ context: shadowContext, settings });
assert.equal(snapshot.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(snapshot.modelContractHash, contract.modelContractHash);
assert.ok(snapshot.drawProb > 0 && snapshot.drawProb < 1);

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

const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: shadowContext.game, settings });
assert.equal(FORMAL_SCORING_ENABLED, false);
assert.equal(SCORE_RELEASE_STATUS, 'LEGACY_INVALID');
assert.equal(finalized.formalScoringEnabled, false);
assert.equal(finalized.scoreReleaseStatus, 'LEGACY_INVALID');
assert.deepEqual(finalized.portfolio, []);
assert.equal(finalized.results.some(row => Number.isFinite(Number(row.shadowDiagnosticScore))), true, 'Shadow保留可稽核的診斷分數');
for (const row of finalized.results) {
  assert.equal(row.score, null, '正式分數必須為null');
  assert.equal(row.scoreStatus, 'LEGACY_INVALID');
  assert.equal(row.betEligible, false);
  assert.equal(row.scoreType, 'SHADOW_DIAGNOSTIC');
}

const secured = enforceShadowAnalysisSafety({
  ...finalized,
  executable: true,
  betEligible: true,
  portfolio: [{ pick: '不應保留' }],
  results: finalized.results.map(row => ({ ...row, executable: true, betEligible: true, tag: '正式候選' })),
}, shadowContext);
assert.equal(enforceAnalysisModeSafety, enforceShadowAnalysisSafety);
assert.equal(secured.analysisMode, SHADOW_ANALYSIS_MODE);
assert.equal(secured.executable, false);
assert.equal(secured.betEligible, false);
assert.deepEqual(secured.portfolio, []);
for (const row of secured.results) {
  assert.equal(row.executable, false);
  assert.equal(row.betEligible, false);
  assert.equal(row.score, null);
  assert.equal(row.scoreType, SHADOW_SCORE_TYPE);
  assert.equal(row.tag, SHADOW_RESULT_TAG);
}

console.log(JSON.stringify({
  ok: true,
  formalScoringEnabled: finalized.formalScoringEnabled,
  diagnosticDirections: finalized.results.filter(row => Number.isFinite(Number(row.shadowDiagnosticScore))).length,
  distributionHash: snapshot.distributionHash,
}, null, 2));
