import assert from 'node:assert/strict';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const common = { water: 0.94, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', executable: true, distributionCoverage: 1, evDoubleCheck: { passed: true }, dataGateV10: { passedForShadowScore: true, blocking: [] }, numericalQA: { passed: true, signStable: true }, marketCalibrationApplied: false, marketVerification: { verified: false }, rawMarketProbabilityGap: 0.01 };
const direction = (market, pick, weightedEV, robustEV, modelProbability = 0.5) => ({ ...common, market, pick, weightedEV, robustEV, modelProbability });
const game = { leagueId: 'MLB', away: '客隊', home: '主隊' };

const rows = [
  direction('全場讓分', '客隊讓1平', 0.015, 0.004), direction('全場讓分', '主隊受讓1平', -0.02, -0.03),
  direction('全場大小', '大9平', 0.015, 0.004), direction('全場大小', '小9平', -0.20, -0.25),
  direction('上半讓分', '客隊讓0.5', 0.015, 0.004), direction('上半讓分', '主隊受讓0.5', -0.08, -0.12),
  direction('上半大小', '大5平', 0.015, 0.004), direction('上半大小', '小5平', -0.02, -0.03),
];
const allDirections = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', results: rows }, game });
assert.equal(allDirections.results.length, 8);
for (const row of allDirections.results) {
  assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true);
  assert.ok(row.formulaDiagnosticScore >= 6.6 && row.formulaDiagnosticScore <= 8.9);
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
}
for (const row of allDirections.results.filter(row => row.weightedEV <= 0)) assert.equal(row.formulaDiagnosticScore, 6.6, 'W≤0一律固定PASS 6.6，不得產生1.x/2.x/3.x診斷分');
assert.ok(allDirections.results.some(row => row.formulaDiagnosticScore >= 7.2));

const observation = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', results: [direction('全場大小', '大9平', 0.01, -0.01)] }, game });
assert.equal(observation.results[0].formulaDiagnosticScore, 7.1, 'W>0且R≤0固定觀察7.1');

const calibrationBlocked = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    results: [{
      ...direction('全場大小', '大9平', null, null),
      rawWeightedEV: 0.20,
      rawRobustEV: 0.12,
      evCalibration: { qualified: false, reasons: ['極端EV缺少獨立市場先驗'] },
    }],
  },
  game,
});
assert.equal(calibrationBlocked.results[0].formulaDiagnosticScore, null);
assert.equal(calibrationBlocked.results[0].shadowDiagnosticScore, null);
assert.equal(calibrationBlocked.results[0].scoreAudit.ok, false);
assert.match(calibrationBlocked.results[0].tag, /EV校準未通過/);

const missingWater = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', results: [{ ...direction('全場大小', '大9平', 0.015, 0.004), water: null }] }, game });
assert.equal(missingWater.results[0].formulaDiagnosticScore, null);

const nonMlb = finalizeDeterministicAnalysis({ analysis: { leagueId: 'KBO', results: [direction('全場大小', '大9平', 0.015, 0.004)] }, game: { ...game, leagueId: 'KBO' } });
assert.equal(Number.isFinite(Number(nonMlb.results[0].formulaDiagnosticScore)), true);
assert.equal(nonMlb.results[0].shadowDiagnosticScore, null);
assert.equal(nonMlb.results[0].scoreStatus, 'LEAGUE_MODEL_NOT_VALIDATED');
assert.equal(nonMlb.results[0].betEligible, false);

console.log('shadow-score-visibility-v102-test: PASS');
