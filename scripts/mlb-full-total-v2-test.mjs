import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MLB_FULL_TOTAL_ARTIFACT_V2 as artifact } from '../lib/mlb-full-total-artifact-v2.js';
import { fullTotalV2Availability, fullTotalV2AlignmentPassed, fullTotalV2ScenarioDistributions, MLB_FULL_TOTAL_V2_VERSION } from '../lib/mlb-full-total-v2.js';
import { analyzeMarkets, buildDistributionSnapshot, evaluateMarketsFromDistribution, repriceMarkets, MODEL_VERSION, RULES_VERSION } from '../lib/analysis-v11.js';
import { scoreDistributionForScenario } from '../lib/joint-score-v13.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { parseTaiwanLine } from '../lib/markets.js';
import { resolveRepriceDistribution } from '../lib/analysis-transport-v1.js';
import { sha256 } from '../lib/snapshot-v9.js';

const team = () => ({
  hitting: { status: 'CONFIRMED', games: 120, runsPerGame: 4.4, ops: .72 },
  recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 4.5 },
  starter: { status: 'CONFIRMED', inningsPitched: 120, gamesStarted: 22, expectedInnings: 5.4, era: 4.1, whip: 1.24 },
  scoring: { games: 60, varianceRuns: 6.2 },
  bullpen: { pureRelief: true, status: 'CONFIRMED', qualityFactor: 1 },
  lineup: { official: true, offensiveIndex: 1 },
});
const context = {
  leagueId: 'MLB', fetchedAt: '2026-10-03T00:00:00Z',
  game: { gamePk: 990222, gameDate: '2026-10-04T00:00:00Z', leagueId: 'MLB', away: '客隊', home: '主隊' },
  away: team(), home: team(), league: { runsPerTeamGame: 4.4, ops: .72, era: 4.2 },
  park: { runFactor: 1 }, weather: { meanRunFactor: 1 }, legacyContextUsed: false,
  analysisMode: 'EXPERIMENTAL_SHADOW', modelVersion: MODEL_VERSION, rulesVersion: RULES_VERSION,
  dataGateV10: { passedForShadowScore: true, quality: .9, modelErrorMarginEV: .01, blocking: [], missing: [], projected: [] },
};
const direction = (market, pick, water = .94) => ({ market, pick, water,
  waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineFresh: true, executable: true });
const markets = [direction('全場讓分', '客隊讓1平'), direction('全場讓分', '主隊受讓1平'),
  direction('全場大小', '大8+40'), direction('全場大小', '小8+40'),
  direction('上半讓分', '客隊讓0.5'), direction('上半讓分', '主隊受讓0.5'),
  direction('上半大小', '大5平'), direction('上半大小', '小5平')];
const frozen = structuredClone({ context, markets, artifact });
assert.equal(artifact.trainingGames, 539);
assert.equal(artifact.model.coefficients.length, 8);
assert.equal(artifact.model.centers.length, 7);
assert.equal(artifact.model.scales.length, 7);
assert.ok(artifact.model.scales.every(n => Number.isFinite(n) && n > 0));
assert.equal(artifact.residuals.length, 422);
assert.equal(new Set(artifact.residuals.map(r => r.gameId)).size, 422);
assert.ok(artifact.residuals.every(r => r.date <= artifact.trainingThrough && Number.isFinite(r.error)));
assert.equal(artifact.source.sourceSha256, 'f9b825122d442023ac0b250e3d1fc73e8ab9eac1211f736e781a782e75ac68ec');
assert.equal(artifact.promotionEligible, false);
assert.equal(artifact.independentValidation, false);
assert.equal(fullTotalV2Availability(context).active, true);
for (const league of ['NPB', 'KBO', 'CPBL', 'NBA', 'NHL']) assert.equal(fullTotalV2Availability({ ...context, leagueId: league }).reason, 'NOT_MLB');
assert.equal(fullTotalV2Availability({ ...context, fetchedAt: '2026-09-01T00:00:00Z' }).reason, 'CANDIDATE_NOT_YET_AVAILABLE');
assert.equal(fullTotalV2Availability({ ...context, game: { ...context.game, gameDate: '2026-09-09T00:00:00Z' } }).active, false);
assert.equal(fullTotalV2Availability({ ...context, fetchedAt: '2026-10-04T00:00:00Z' }).reason, 'GAME_NOT_PREGAME');
assert.equal(fullTotalV2Availability({ ...context, game: { ...context.game, gameDate: '2027-01-02T00:00:00Z' } }).reason, 'OUTSIDE_FROZEN_SEASON');

const snapshot = buildDistributionSnapshot({ context });
const analysis = evaluateMarketsFromDistribution({ context, markets, distributionSnapshot: snapshot });
assert.equal(analysis.fullTotalForecast.version, MLB_FULL_TOTAL_V2_VERSION);
assert.equal(analysis.fullTotalForecast.referenceLine, 8);
assert.equal(analysis.fullTotalForecast.independentValidation, false);
assert.equal(analysis.scenarioSummary.sharedDistribution, false);
assert.equal(analysis.scenarioSummary.fullTotalMarginalNotJoint, true);
assert.equal(fullTotalV2AlignmentPassed(analysis), true);
const marginal = fullTotalV2ScenarioDistributions({ context, markets, snapshot, resolveScoreDistribution: scoreDistributionForScenario });
// Independently re-evaluate each scenario's fitted regression and each
// realized integer total's Taiwan cash payoff, rather than reusing the scorer.
const c = snapshot.profile.components;
const factors = [(c.awayOffense + c.homeOffense) / 2, (c.awayStarter + c.homeStarter) / 2,
  (c.awayBullpen + c.homeBullpen) / 2, (c.awayStarterExpectedInnings + c.homeStarterExpectedInnings) / 2, c.park * c.weather];
const evByPick = new Map();
for (const row of markets.filter(r => r.market === '全場大小')) {
  const parsed = parseTaiwanLine(row.pick);
  const scenarioEVs = [];
  let w = 0;
  for (const scenario of snapshot.scenarios) {
    const baseMean = scoreDistributionForScenario(scenario).cells.reduce((s, x) => s + x.probability * (x.awayRuns + x.homeRuns), 0);
    const x = [8, baseMean - 8, ...factors];
    const center = Math.max(0, Math.min(40, artifact.model.coefficients[0] + x.reduce((s, n, i) => s + (n - artifact.model.centers[i]) / artifact.model.scales[i] * artifact.model.coefficients[i + 1], 0)));
    const totals = artifact.residuals.map(r => Math.max(0, Math.min(40, Math.round(center + r.error))));
    const counts = new Map(); for (const total of totals) counts.set(total, (counts.get(total) || 0) + 1);
    assert.deepEqual(marginal.distributions.get(scenario.id).cells, [...counts].sort(([a], [b]) => a - b).map(([totalRuns, n]) => ({ totalRuns, probability: n / totals.length })));
    const ev = totals.reduce((sum, total) => {
      let gross = 0, rebate = 0;
      for (const line of parsed.legs) {
        const tail = Number(parsed.modifier.replace('平', '0') || 0) / 100;
        let share = total > line ? 1 : total < line ? -1 : tail;
        if (parsed.isUnder) share = -share;
        gross += (share > 0 ? share * row.water : share) / parsed.legs.length;
        rebate += Math.abs(share) * .015 / parsed.legs.length;
      }
      return sum + gross + rebate;
    }, 0) / totals.length;
    scenarioEVs.push({ weight: scenario.weight, value: ev }); w += scenario.weight * ev;
  }
  const ordered = scenarioEVs.sort((a, b) => a.value - b.value); let mass = 0, q10;
  for (const r of ordered) { mass += r.weight; if (mass >= .1 - 1e-12) { q10 = r.value; break; } }
  const actual = analysis.results.find(r => r.pick === row.pick);
  assert.ok(Math.abs(actual.weightedEV - w) < 1e-12);
  assert.ok(Math.abs(actual.robustEV - Math.min(w, q10, w - .01)) < 1e-12);
  assert.equal(actual.mathematicalIntegrityPassed, true);
  assert.equal(actual.evDoubleCheck.passed, true);
  assert.ok(Math.abs(actual.settlementEvents.reduce((s, event) => s + event.modelEventProbability * event.calculation.profit, 0) - w) < 1e-12);
  evByPick.set(row.pick, w);
}

const finalized = finalizeDeterministicAnalysis({ analysis, game: context.game });
assert.equal(finalized.scoreValidation.passed, true);
assert.equal(finalized.scoreFormulaVersion, SCORE_FORMULA_VERSION);
assert.equal(finalized.formalScoringEnabled, false);
assert.equal(finalized.formalRecommendationsEnabled, false);
for (const row of finalized.results) {
  const score = deterministicScore({ weightedEV: row.weightedEV, robustEV: row.robustEV, qaPassed: true, actualWater: true, executable: true });
  assert.equal(row.formulaDiagnosticScore, score.score);
  assert.equal(row.betEligible, false);
  if (row.rankingQualified) assert.ok(row.formulaDiagnosticScore >= 7.2 && row.weightedEV > 0 && row.robustEV > 0);
}
const oldContext = { ...context, fetchedAt: '2026-09-20T00:00:00Z' };
const old = analyzeMarkets({ context: oldContext, markets });
for (const row of analysis.results.filter(r => r.market !== '全場大小')) {
  const before = old.results.find(r => r.pick === row.pick);
  for (const key of ['modelProbability', 'weightedEV', 'robustEV', 'settlementEvents', 'robustEvidence', 'minimumWater']) assert.deepEqual(row[key], before[key]);
}
assert.ok(analysis.results.filter(r => r.market === '全場大小').some(r => Math.abs(r.weightedEV - old.results.find(o => o.pick === r.pick).weightedEV) > 1e-4));

const repriced = repriceMarkets({ context, markets: markets.map(r => ({ ...r, water: r.water + .03 })), distributionSnapshot: JSON.parse(JSON.stringify(snapshot)) });
assert.equal(repriced.fullTotalForecast.expectedTotal, analysis.fullTotalForecast.expectedTotal);
for (const r of repriced.results) assert.equal(r.modelProbability, analysis.results.find(o => o.pick === r.pick).modelProbability);
const reversed = evaluateMarketsFromDistribution({ context, markets: [...markets].reverse(), distributionSnapshot: snapshot });
assert.deepEqual(reversed.fullTotalForecast, analysis.fullTotalForecast);
const poisonedContext = { ...context, actual: 99, finalScore: 99, actualRuns: 99 };
assert.deepEqual(analyzeMarkets({ context: poisonedContext, markets }).fullTotalForecast, analysis.fullTotalForecast);
const changedLine = repriceMarkets({ context, markets: markets.map(r => r.market === '全場大小' ? { ...r, pick: r.pick.replace('8', '9') } : r), distributionSnapshot: snapshot });
assert.equal(changedLine.fullTotalForecast.referenceLine, 9);
assert.notEqual(changedLine.fullTotalForecast.expectedTotal, analysis.fullTotalForecast.expectedTotal);
const missingWater = evaluateMarketsFromDistribution({ context, markets: markets.map(r => r.market === '全場大小' ? { ...r, water: null } : r), distributionSnapshot: snapshot });
assert.ok(missingWater.results.filter(r => r.market === '全場大小').every(r => r.weightedEV === null));
assert.ok(missingWater.results.filter(r => r.market !== '全場大小').every(r => Number.isFinite(r.weightedEV)));
const forged = structuredClone(snapshot); forged.fullTotalForecast.artifactHash = 'forged';
assert.throws(() => evaluateMarketsFromDistribution({ context, markets, distributionSnapshot: forged }), e => e.code === 'MLB_FULL_TOTAL_V2_SNAPSHOT_REBUILD_REQUIRED' && e.status === 409);
assert.equal(fullTotalV2AlignmentPassed({ ...analysis, fullTotalForecast: { ...analysis.fullTotalForecast, artifactHash: 'forged' } }), false);
const rebuilt = resolveRepriceDistribution({ distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, frozenContext: context }, buildDistributionSnapshot);
assert.equal(rebuilt.matches, true);
assert.deepEqual(rebuilt.distributionSnapshot, snapshot);
assert.deepEqual({ context, markets, artifact }, frozen);
assert.equal(sha256(artifact), snapshot.fullTotalForecast.artifactHash);
assert.ok(fs.readFileSync('app/page.js', 'utf8').includes('研究勝率不是本場勝率'));
console.log(JSON.stringify({ ok: true, scope: 'MLB_FULL_TOTAL_ONLY', trainingGames: artifact.trainingGames, residualGames: artifact.residuals.length,
  scenarios: snapshot.scenarios.length, checks: ['independent-regression-and-payoff', 'unchanged-six-other-directions', 'real-water-only', 'same-distribution-for-over-under', 'same-S-W-R-thresholds', 'water-only-reprice-invariance', 'line-feature-disclosure', 'no-future-outcome-input', 'signed-snapshot-rebuild', 'no-formal-promotion'] }));
