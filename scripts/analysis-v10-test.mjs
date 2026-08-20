import assert from 'node:assert/strict';
import {
  MODEL_VERSION,
  RULES_VERSION,
  buildDistributionSnapshot,
  evaluateMarketsFromDistribution,
  repriceMarkets,
} from '../lib/analysis-v11.js';
import {
  FORMAL_SCORING_ENABLED,
  SCORE_RELEASE_STATUS,
  finalizeDeterministicAnalysis,
} from '../lib/deterministic-finalizer-v10.js';

const context = {
  leagueId: 'MLB',
  analysisMode: 'EXPERIMENTAL_SHADOW',
  modelVersion: MODEL_VERSION,
  rulesVersion: RULES_VERSION,
  modelConfig: {},
  game: { gamePk: 990001, leagueId: 'MLB', away: 'A', home: 'H' },
  league: { runsPerTeamGame: 4.42, era: 4.15, whip: 1.29, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15, ops: 0.724 },
  away: {
    hitting: { available: true, status: 'CONFIRMED', games: 120, runsPerGame: 4.7, ops: 0.745 },
    recentHitting: { available: true, status: 'PROJECTED', games: 14, runsPerGame: 4.5, ops: 0.730 },
    pitching: { available: true, status: 'CONFIRMED', inningsPitched: 1050, gamesStarted: 120, era: 4.05, fip: 4.10, whip: 1.27 },
    recentPitching: { available: true, status: 'PROJECTED', inningsPitched: 120, gamesStarted: 14, era: 3.90, fip: 4.00, whip: 1.25 },
    starter: { available: true, status: 'CONFIRMED', inningsPitched: 130, gamesStarted: 22, era: 3.65, fip: 3.78, whip: 1.19 },
    scoring: { games: 60, meanRuns: 4.6, varianceRuns: 10.0 },
    injuriesAvailable: true,
    injuries: [],
  },
  home: {
    hitting: { available: true, status: 'CONFIRMED', games: 120, runsPerGame: 4.4, ops: 0.718 },
    recentHitting: { available: true, status: 'PROJECTED', games: 14, runsPerGame: 4.3, ops: 0.710 },
    pitching: { available: true, status: 'CONFIRMED', inningsPitched: 1050, gamesStarted: 120, era: 4.25, fip: 4.22, whip: 1.31 },
    recentPitching: { available: true, status: 'PROJECTED', inningsPitched: 120, gamesStarted: 14, era: 4.30, fip: 4.25, whip: 1.32 },
    starter: { available: true, status: 'CONFIRMED', inningsPitched: 125, gamesStarted: 22, era: 4.10, fip: 4.05, whip: 1.28 },
    scoring: { games: 60, meanRuns: 4.4, varianceRuns: 9.2 },
    injuriesAvailable: true,
    injuries: [],
  },
  park: { available: true, runFactor: 1.01, factorStatus: 'PROJECTED' },
  weather: { available: true, meanRunFactor: 1.00, status: 'PROJECTED' },
  sourceStatuses: {
    leagueBaseline: 'CONFIRMED', awaySeasonHitting: 'CONFIRMED', homeSeasonHitting: 'CONFIRMED',
    awaySeasonPitching: 'CONFIRMED', homeSeasonPitching: 'CONFIRMED', venueRegistry: 'CONFIRMED',
    awayStarter: 'CONFIRMED', homeStarter: 'CONFIRMED', awayRecentHitting: 'PROJECTED',
    homeRecentHitting: 'PROJECTED', awayRecentPitching: 'PROJECTED', homeRecentPitching: 'PROJECTED',
    parkFactor: 'PROJECTED', weather: 'PROJECTED', awayInjuries: 'CONFIRMED', homeInjuries: 'CONFIRMED',
    lineups: 'MISSING', umpire: 'MISSING', catcherFraming: 'MISSING', defenseOAA: 'MISSING',
  },
  dataGateV10: {
    passedForShadowScore: true,
    passedForFormalScore: false,
    quality: 0.78,
    modelErrorMarginEV: 0.022,
    missing: ['lineups','umpire','catcherFraming','defenseOAA'],
    projected: ['awayRecentHitting','homeRecentHitting','awayRecentPitching','homeRecentPitching','parkFactor','weather'],
    blocking: [],
  },
};

const markets = [
  { market: '全場讓分', pick: 'A受讓1平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '全場讓分', pick: 'H讓1平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '全場大小', pick: '大9平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '全場大小', pick: '小9平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '上半讓分', pick: 'A受讓0平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '上半讓分', pick: 'H讓0平', water: 0.94, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '上半大小', pick: '大5平', water: 0.93, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
  { market: '上半大小', pick: '小5平', water: 0.93, sourceType: 'ACTUAL_TW_CREDIT', executable: true, waterEstimated: false, marketVerification: { verified: false, referencePriorEligible: false } },
];
const settings = { rebateRate: 0.015, candidateThreshold: 7.2 };

const snapshot = buildDistributionSnapshot({ context, settings });
assert.equal(snapshot.modelVersion, MODEL_VERSION);
assert.equal(snapshot.rulesVersion, RULES_VERSION);
assert.equal(snapshot.legacyDistributionUsed, false);
assert.equal(snapshot.targetMarketCalibrationApplied, false);
assert.ok(Math.abs(snapshot.scenarioWeight - 1) < 1e-12);

const preliminary = evaluateMarketsFromDistribution({ context, markets, settings, distributionSnapshot: snapshot });
assert.equal(preliminary.modelVersion, MODEL_VERSION);
assert.equal(preliminary.rulesVersion, RULES_VERSION);
assert.equal(preliminary.distributionHash, snapshot.distributionHash);
assert.equal(preliminary.results.length, markets.length);
for (const row of preliminary.results) {
  assert.equal(row.marketCalibrationApplied, false);
  assert.equal(row.targetPriceCalibratesDistribution, false);
  assert.ok(Number.isFinite(row.rawWeightedEV));
  assert.ok(Number.isFinite(row.rawRobustEV));
  assert.ok(row.rawRobustEV <= row.rawWeightedEV + 1e-12);
  assert.equal(row.evDoubleCheck.passed, true);
  assert.ok(Math.abs(row.distributionCoverage - 1) < 1e-9);
  if (row.evCalibration.qualified) {
    assert.ok(Number.isFinite(row.weightedEV));
    assert.ok(Number.isFinite(row.robustEV));
    assert.ok(row.robustEV <= row.weightedEV + 1e-12);
  } else {
    assert.equal(row.weightedEV, null);
    assert.equal(row.robustEV, null);
  }
}

const repricedMarkets = markets.map(row => row.pick === '小9平' ? { ...row, water: 0.90 } : row);
const repriced = repriceMarkets({ context, markets: repricedMarkets, settings, distributionSnapshot: snapshot });
const originalUnder = preliminary.results.find(row => row.pick === '小9平');
const repricedUnder = repriced.results.find(row => row.pick === '小9平');
assert.equal(repriced.distributionHash, preliminary.distributionHash);
assert.ok(Math.abs(originalUnder.modelProbability - repricedUnder.modelProbability) < 1e-12,
  'Tai888水位改變不得反向改寫棒球模型勝率');
assert.notEqual(originalUnder.rawWeightedEV, repricedUnder.rawWeightedEV, '成交水位改變必須重算payoff EV');

const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
assert.equal(FORMAL_SCORING_ENABLED, false);
assert.equal(SCORE_RELEASE_STATUS, 'SHADOW_DIAGNOSTIC_UNCALIBRATED_NOT_FORMAL');
assert.equal(finalized.formalScoringEnabled, false);
assert.equal(finalized.formalRecommendationsEnabled, false);
assert.ok(finalized.results.some(row => Number.isFinite(Number(row.shadowDiagnosticScore))), '至少應保留可稽核影子分數');
for (const row of finalized.results) {
  assert.equal(row.score, null, '正式分數仍須為null');
  assert.equal(row.betEligible, false);
  if (row.evCalibration?.qualified === false) {
    assert.equal(row.formulaDiagnosticScore, null);
    assert.equal(row.scoreStatus, 'UNSCORED');
    assert.match(row.tag, /EV校準未通過/);
  } else {
    assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true, '校準合格方向須保留固定公式診斷分');
    assert.ok(['SHADOW_DIAGNOSTIC_UNCALIBRATED', 'BLOCKED'].includes(row.scoreStatus));
    if (row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED') assert.ok(Number.isFinite(Number(row.shadowDiagnosticScore)));
  }
}

console.log(JSON.stringify({
  ok: true,
  modelVersion: MODEL_VERSION,
  distributionHash: snapshot.distributionHash,
  scoreReleaseStatus: SCORE_RELEASE_STATUS,
  resultCount: finalized.results.length,
}, null, 2));
