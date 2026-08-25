import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeMarkets, buildDistributionSnapshot, independentMinimumWater, MODEL_VERSION, RULES_VERSION, SHADOW_ANALYSIS_MODE } from '../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const team = (runsPerGame, ops, era, scoringMean, scoringVariance) => ({
  hitting: { available: true, status: 'CONFIRMED', games: 120, runsPerGame, ops },
  recentHitting: { available: true, status: 'PROJECTED', games: 12, runsPerGame: runsPerGame * 1.02, ops: ops * 1.01 },
  pitching: { available: true, status: 'CONFIRMED', inningsPitched: 1080, era, fip: era + 0.05, whip: 1.28 },
  recentPitching: { available: true, status: 'PROJECTED', inningsPitched: 105, era: era + 0.10, fip: era + 0.12, whip: 1.30 },
  starter: { available: true, status: 'CONFIRMED', inningsPitched: 120, gamesStarted: 22, era: era - 0.15, fip: era - 0.08, whip: 1.24 },
  injuriesAvailable: true,
  injuries: [],
  scoring: { games: 60, meanRuns: scoringMean, varianceRuns: scoringVariance },
});

const context = {
  coreModelable: true,
  legacyContextUsed: false,
  leagueId: 'MLB',
  game: { gamePk: 990001, away: '客隊', home: '主隊', leagueId: 'MLB' },
  league: { runsPerTeamGame: 4.48, era: 4.22, whip: 1.29, kPer9: 8.7, bbPer9: 3.2, hrPer9: 1.15, ops: 0.725 },
  away: team(4.55, 0.735, 4.12, 4.55, 6.5),
  home: team(4.40, 0.718, 4.28, 4.40, 6.2),
  park: { runFactor: 1.01, factorStatus: 'PROJECTED' },
  weather: { meanRunFactor: 1.005, status: 'PROJECTED' },
  sourceStatuses: { leagueBaseline: 'CONFIRMED', awaySeasonHitting: 'CONFIRMED', homeSeasonHitting: 'CONFIRMED', lineups: 'MISSING' },
  dataGateV10: { version: 'TEST-V11', rows: [], missing: ['umpire','lineups'], projected: ['parkFactor','weather'], blocking: [], passedForShadowScore: true, passedForFormalScore: false, quality: 0.86, modelErrorMarginEV: 0.010 },
  analysisMode: SHADOW_ANALYSIS_MODE,
  modelVersion: MODEL_VERSION,
  rulesVersion: RULES_VERSION,
  modelConfig: { exactDistribution: true },
};

const direction = (market, pick, water) => ({ market, pick, water, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineFresh: true, executable: true, marketVerification: { verified: false, referencePriorEligible: false } });
const markets = [
  direction('全場讓分', '客隊讓1平', 0.95), direction('全場讓分', '主隊受讓1平', 0.95),
  direction('全場大小', '大9平', 0.94), direction('全場大小', '小9平', 0.94),
  direction('上半讓分', '客隊讓0.5', 0.94), direction('上半讓分', '主隊受讓0.5', 0.94),
  direction('上半大小', '大5平', 0.93), direction('上半大小', '小5平', 0.93),
];

const snapshot = buildDistributionSnapshot({ context });
assert.equal(snapshot.legacyDistributionUsed, false);
assert.equal(snapshot.exactDistribution, true);
assert.equal(snapshot.scenarios.length, 27);
assert.ok(Math.abs(snapshot.scenarioWeight - 1) < 1e-12);
assert.match(String(snapshot.runProfileVersion || ''), /v11\.0\.0/);
assert.equal(snapshot.stateAwareBottomNinth, true);
assert.equal(snapshot.stateAwareWalkoff, true);
assert.equal(snapshot.linkedSegmentPath, true);
for (const scenario of snapshot.scenarios) {
  for (const pmf of Object.values(scenario.pmf)) assert.ok(Math.abs(pmf.reduce((sum, row) => sum + row[1], 0) - 1) < 1e-12);
}

const analysis = analyzeMarkets({ context, markets, settings: { rebateRate: 0.015 } });
assert.equal(analysis.scenarioSummary.legacyDistributionUsed, false);
assert.equal(analysis.scenarioSummary.exactDistribution, true);
assert.equal(analysis.results.length, 8);
const scenarioGaps = analysis.results.map(row => ({ market: row.market, pick: row.pick, gap: row.evCalibration?.rawScenarioSpread }));
assert.ok(scenarioGaps.every(row => Number(row.gap) <= 0.05), 'a normal complete-data board must naturally stay within the 5% scenario stability target');
assert.equal(analysis.scenarioSummary.sharedDistribution, true);
assert.equal(analysis.scenarioSummary.targetPriceCalibratesDistribution, false);
assert.equal(analysis.scenarioSummary.marketProbabilityCalibrationApplied, false);
assert.equal(analysis.alignmentAudit.targetMarketCalibration, 'DISABLED_EXECUTION_PRICE_ONLY');
for (const row of analysis.results) {
  assert.equal(row.marketCalibrationWeight, 0);
  assert.equal(row.marketCalibrationApplied, false);
  assert.equal(row.marketBaselineApplied, false);
  assert.equal(row.targetPriceCalibratesDistribution, false);
  assert.equal(row.marketBaselineTargetProbability, null);
  assert.ok(Math.abs(row.modelProbability - row.rawModelProbabilityBeforeBaseline) < 1e-12, 'Tai888 must never rewrite the baseball model probability');
  assert.equal(row.rawMarketProbabilityGap, row.tai888MarketProbabilityGap, 'QA gap fields must share the raw model-vs-Tai888 no-vig gap');
  assert.ok(Math.abs(row.rawMarketProbabilityGap - Math.abs(row.rawModelProbability - row.marketAnchorProbability)) < 1e-12);
  assert.ok(Number.isFinite(row.rawWeightedEV));
  assert.ok(Number.isFinite(row.rawRobustEV));
  assert.ok(row.rawRobustEV <= row.rawWeightedEV + 1e-12);
  assert.equal(row.evDoubleCheck.passed, true);
  assert.ok(Math.abs(row.distributionCoverage - 1) < 1e-9);
  assert.equal(typeof row.evCalibration?.qualified, 'boolean');
  const visibleBucketCoverage = row.fullWinProbability + row.partialWinProbability + row.pushProbability
    + row.partialLossProbability + row.fullLossProbability + row.mixedNeutralProbability;
  assert.ok(Math.abs(visibleBucketCoverage - row.distributionCoverage) < 1e-9, 'all settlement buckets must cover the complete score distribution');
  assert.ok(Math.abs(row.equivalentWinProbability + row.equivalentLossProbability + row.equivalentPushProbability - row.distributionCoverage) < 1e-9, 'equivalent win/loss/push probabilities must cover the complete score distribution');
  assert.ok(row.settlementIdentityAudit.probabilityIdentityError < 1e-12, 'displayed model probability must match equivalent settlement probability');
  assert.ok(row.settlementIdentityAudit.evIdentityError < 1e-9, 'raw W must match the equivalent settlement payoff identity');
  assert.equal(row.evCalibration?.qualified, true, 'fresh Reader + valid model must score without an international same-contract market');
  if (row.evCalibration.qualified) {
    assert.ok(Number.isFinite(row.weightedEV));
    assert.ok(Number.isFinite(row.robustEV));
    assert.ok(row.robustEV <= row.weightedEV + 1e-12);
  } else {
    assert.equal(row.weightedEV, null);
    assert.equal(row.robustEV, null);
    assert.ok((row.evCalibration.reasons || []).length > 0);
  }
}

const modifierAnalysis = analyzeMarkets({
  context,
  markets: [
    direction('全場讓分', '客隊讓1-90', 0.95),
    direction('全場讓分', '主隊受讓1-90', 0.95),
  ],
  settings: { rebateRate: 0.015 },
});
const givingModifier = modifierAnalysis.results.find(row => row.pick === '客隊讓1-90');
const receivingModifier = modifierAnalysis.results.find(row => row.pick === '主隊受讓1-90');
assert.ok(givingModifier.partialLossProbability > 0, '讓1-90在淨勝1分時必須顯示部分輸機率');
assert.ok(receivingModifier.partialWinProbability > 0, '受讓1-90在淨輸1分時必須顯示部分贏機率');
assert.ok(Math.abs(receivingModifier.pushProbability) < 1e-12, '受讓1-90的整數命中是部分結算，不是純走水');
assert.ok(receivingModifier.settlementIdentityAudit.evIdentityError < 1e-9);

const lowTotalAnalysis = analyzeMarkets({
  context,
  markets: [direction('全場大小', '大6-20', 0.94), direction('全場大小', '小6-20', 0.94)],
  settings: { rebateRate: 0.015 },
});
const lowTotalOver = lowTotalAnalysis.results.find(row => row.pick === '大6-20');
const lowTotalUnder = lowTotalAnalysis.results.find(row => row.pick === '小6-20');
for (const row of lowTotalAnalysis.results) {
  assert.equal(row.marketBaselineApplied, false, 'even an extreme model/market gap must not rewrite the shared score distribution');
  assert.equal(row.marketCalibrationWeight, 0);
  assert.equal(row.targetPriceCalibratesDistribution, false);
  assert.ok(Math.abs(row.modelProbability - row.rawModelProbabilityBeforeBaseline) < 1e-12);
  assert.ok(row.robustEV <= row.weightedEV + 1e-12);
  assert.ok(row.settlementIdentityAudit.evIdentityError < 1e-9);
  assert.ok(row.rawModelTai888ProbabilityGap > 0.10);
}
assert.ok(Math.abs(lowTotalOver.modelProbability + lowTotalUnder.modelProbability - 1) < 1e-12, 'opposite directions must remain complementary on one frozen score world');
assert.ok(Math.abs(lowTotalOver.equivalentWinProbability - lowTotalUnder.equivalentLossProbability) < 1e-12);
assert.ok(Math.abs(lowTotalOver.equivalentLossProbability - lowTotalUnder.equivalentWinProbability) < 1e-12);
assert.ok(Math.abs(lowTotalOver.equivalentPushProbability - lowTotalUnder.equivalentPushProbability) < 1e-12);
assert.ok(Math.abs(lowTotalOver.weightedEV - lowTotalUnder.weightedEV) > 0.20, 'extreme opposing views must not collapse to identical market-implied W/R');
const finalizedLowTotal = finalizeDeterministicAnalysis({ analysis: lowTotalAnalysis, game: context.game });
for (const row of finalizedLowTotal.results) {
  assert.equal(row.scoreAudit.ok, false);
  assert.equal(row.scoreAudit.plausibility.passed, false);
  assert.equal(row.formulaDiagnosticScore, null, 'a >10pp model/market gap must QA BLOCK instead of being hidden by probability feedback');
  assert.ok(row.scoreBreakdown.caps.includes('TARGET_MARKET_PROBABILITY_GAP_QA_BLOCK'));
  assert.equal(row.pairAudit.passed, true, 'the raw shared distribution must still pass mirror and complement QA');
}
const finalized = finalizeDeterministicAnalysis({ analysis, game: context.game, settings: { candidateThreshold: 7.2 } });
for (const row of finalized.results) {
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
  if (row.evCalibration?.qualified === false) {
    assert.equal(row.formulaDiagnosticScore, null);
    assert.match(row.tag, /模型評分未通過/);
  } else {
    assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true, '校準合格方向須保留固定公式診斷分');
  }
}

const analysisSource = fs.readFileSync(new URL('../lib/analysis-v11.js', import.meta.url), 'utf8');
const contextSource = fs.readFileSync(new URL('../lib/mlb-context-v11.js', import.meta.url), 'utf8');
assert.equal(/buildLegacy|LegacyGameContext|LegacyDistribution/.test(analysisSource), false, 'V10.3分析核心不得引用Legacy builder');
assert.equal(/buildLegacy|LegacyGameContext|LegacyDistribution/.test(contextSource), false, 'V10.3資料核心不得引用Legacy builder');

const unreachableRobustTarget = independentMinimumWater({
  qualified: true,
  referencePriorType: 'PAYOFF_VECTOR',
  referenceBookPayoffVectors: ['book-a', 'book-b', 'book-c'].map(bookmakerKey => ({
    bookmakerKey,
    equivalentWin: 0.248,
    equivalentLoss: 0.752,
    equivalentPush: 0,
  })),
}, 0.015, true);
assert.ok(Number.isFinite(unreachableRobustTarget.score7_2.weightedWater), 'W=0 must be reachable before the water search ceiling');
assert.equal(unreachableRobustTarget.score7_2.robustWater, null, 'R=0 must remain unreachable after the explicit 1.5pp haircut');
assert.equal(unreachableRobustTarget.score7_2.requiredWater, null, 'combined threshold guidance must not claim success when either W or R is unreachable');

console.log(JSON.stringify({ ok: true, modelVersion: MODEL_VERSION, distributionHash: snapshot.distributionHash, scenarios: snapshot.scenarios.length }, null, 2));
