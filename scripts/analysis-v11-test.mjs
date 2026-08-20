import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeMarkets, buildDistributionSnapshot, MODEL_VERSION, RULES_VERSION, SHADOW_ANALYSIS_MODE } from '../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const team = (runsPerGame, ops, era, scoringMean, scoringVariance) => ({
  hitting: { available: true, status: 'CONFIRMED', games: 120, runsPerGame, ops },
  recentHitting: { available: true, status: 'PROJECTED', games: 12, runsPerGame: runsPerGame * 1.02, ops: ops * 1.01 },
  pitching: { available: true, status: 'CONFIRMED', inningsPitched: 1080, era, fip: era + 0.05, whip: 1.28 },
  recentPitching: { available: true, status: 'PROJECTED', inningsPitched: 105, era: era + 0.10, fip: era + 0.12, whip: 1.30 },
  starter: { available: true, status: 'CONFIRMED', inningsPitched: 120, era: era - 0.15, fip: era - 0.08, whip: 1.24 },
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
  sourceStatuses: { leagueBaseline: 'CONFIRMED', awaySeasonHitting: 'CONFIRMED', homeSeasonHitting: 'CONFIRMED' },
  dataGateV10: { version: 'TEST-V11', rows: [], missing: ['umpire'], projected: ['parkFactor','weather'], blocking: [], passedForShadowScore: true, passedForFormalScore: false, quality: 0.90, modelErrorMarginEV: 0.006 },
  analysisMode: SHADOW_ANALYSIS_MODE,
  modelVersion: MODEL_VERSION,
  rulesVersion: RULES_VERSION,
  modelConfig: { exactDistribution: true },
};

const direction = (market, pick, water) => ({ market, pick, water, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', executable: true, marketVerification: { verified: false } });
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
for (const scenario of snapshot.scenarios) {
  for (const pmf of Object.values(scenario.pmf)) assert.ok(Math.abs(pmf.reduce((sum, row) => sum + row[1], 0) - 1) < 1e-12);
}

const analysis = analyzeMarkets({ context, markets, settings: { rebateRate: 0.015 } });
assert.equal(analysis.scenarioSummary.legacyDistributionUsed, false);
assert.equal(analysis.scenarioSummary.exactDistribution, true);
assert.equal(analysis.results.length, 8);
for (const row of analysis.results) {
  assert.equal(row.marketCalibrationApplied, false);
  assert.ok(Number.isFinite(row.weightedEV));
  assert.ok(Number.isFinite(row.robustEV));
  assert.ok(row.robustEV <= row.weightedEV + 1e-12);
  assert.equal(row.evDoubleCheck.passed, true);
  assert.ok(Math.abs(row.distributionCoverage - 1) < 1e-9);
}
const finalized = finalizeDeterministicAnalysis({ analysis, game: context.game, settings: { candidateThreshold: 7.2 } });
for (const row of finalized.results) {
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
}

const analysisSource = fs.readFileSync(new URL('../lib/analysis-v11.js', import.meta.url), 'utf8');
const contextSource = fs.readFileSync(new URL('../lib/mlb-context-v11.js', import.meta.url), 'utf8');
assert.equal(/buildLegacy|LegacyGameContext|LegacyDistribution/.test(analysisSource), false, 'V10.1分析核心不得引用Legacy builder');
assert.equal(/buildLegacy|LegacyGameContext|LegacyDistribution/.test(contextSource), false, 'V10.1資料核心不得引用Legacy builder');

console.log(JSON.stringify({ ok: true, modelVersion: MODEL_VERSION, distributionHash: snapshot.distributionHash, scenarios: snapshot.scenarios.length }, null, 2));
