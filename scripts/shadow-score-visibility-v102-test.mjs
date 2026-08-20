import assert from 'node:assert/strict';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const common = {
  water: 0.94,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  executable: true,
  distributionCoverage: 1,
  evDoubleCheck: { passed: true },
  dataGateV10: { passedForShadowScore: true, blocking: [] },
  numericalQA: { passed: true, signStable: true },
  marketCalibrationApplied: false,
  marketVerification: { verified: false },
  rawMarketProbabilityGap: 0.01,
};

const direction = (market, pick, weightedEV, robustEV, modelProbability = 0.5) => ({
  ...common,
  market,
  pick,
  weightedEV,
  robustEV,
  modelProbability,
});

const game = { leagueId: 'MLB', away: '客隊', home: '主隊' };
const rows = [
  direction('全場讓分', '客隊讓1平', 0.015, 0.004),
  direction('全場讓分', '主隊受讓1平', -0.02, -0.03),
  direction('全場大小', '大9平', 0.015, 0.004),
  direction('全場大小', '小9平', -0.02, -0.03),
  direction('上半讓分', '客隊讓0.5', 0.015, 0.004),
  direction('上半讓分', '主隊受讓0.5', -0.02, -0.03),
  direction('上半大小', '大5平', 0.015, 0.004),
  direction('上半大小', '小5平', -0.02, -0.03),
];

const allDirections = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', results: rows }, game });
assert.equal(allDirections.results.length, 8);
for (const row of allDirections.results) {
  assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true, `${row.market} ${row.pick}應顯示公式診斷分`);
  assert.ok(row.formulaDiagnosticScore >= 1 && row.formulaDiagnosticScore <= 8.9);
  assert.equal(row.score, null, '正式分數必須維持停用');
  assert.equal(row.betEligible, false, '公式診斷分不得形成下注資格');
}
assert.ok(allDirections.results.some(row => row.formulaDiagnosticScore <= 6.6), '負EV方向也必須顯示1.0～6.6數字');
assert.ok(allDirections.results.some(row => row.formulaDiagnosticScore >= 7.2), '正雙EV方向應顯示7.2以上數字');

const observation = finalizeDeterministicAnalysis({
  analysis: { leagueId: 'MLB', results: [direction('全場大小', '大9平', 0.01, -0.01)] },
  game,
});
assert.ok(observation.results[0].formulaDiagnosticScore >= 6.7 && observation.results[0].formulaDiagnosticScore <= 7.1,
  'W>0且R<=0仍須顯示6.7～7.1數字');

const qaBlocked = finalizeDeterministicAnalysis({
  analysis: { leagueId: 'MLB', results: [{ ...direction('全場大小', '大9平', 0.015, 0.004), rawMarketProbabilityGap: 0.25 }] },
  game,
});
assert.equal(Number.isFinite(Number(qaBlocked.results[0].formulaDiagnosticScore)), true, 'QA BLOCK仍須保留公式診斷分');
assert.equal(qaBlocked.results[0].shadowDiagnosticScore, null, 'QA BLOCK不得取得排名資格分');
assert.equal(qaBlocked.results[0].scoreAudit.ok, false);
assert.equal(qaBlocked.results[0].betEligible, false);

const pairBlocked = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    results: [
      direction('全場大小', '大9平', 0.015, 0.004, 0.8),
      direction('全場大小', '小9平', 0.015, 0.004, 0.8),
    ],
  },
  game,
});
for (const row of pairBlocked.results) {
  assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true, 'pair QA失敗不可清掉公式診斷分');
  assert.equal(row.shadowDiagnosticScore, null);
  assert.equal(row.pairAudit.passed, false);
}

const missingWater = finalizeDeterministicAnalysis({
  analysis: { leagueId: 'MLB', results: [{ ...direction('全場大小', '大9平', 0.015, 0.004), water: null }] },
  game,
});
assert.equal(missingWater.results[0].formulaDiagnosticScore, null, '無合法水位不得補造分數');

for (const [field, invalid] of [
  ['weightedEV', Number.NaN],
  ['weightedEV', Number.POSITIVE_INFINITY],
  ['weightedEV', 'not-a-number'],
  ['robustEV', Number.NEGATIVE_INFINITY],
  ['robustEV', 'invalid'],
]) {
  const invalidEv = finalizeDeterministicAnalysis({
    analysis: { leagueId: 'MLB', results: [{ ...direction('全場大小', '大9平', 0.015, 0.004), [field]: invalid }] },
    game,
  });
  assert.equal(invalidEv.results[0].formulaDiagnosticScore, null, `${field}不是有限數值時不得補造分數`);
  assert.equal(invalidEv.results[0].scoreAudit.ok, false);
}

const nonMlb = finalizeDeterministicAnalysis({
  analysis: { leagueId: 'KBO', results: [direction('全場大小', '大9平', 0.015, 0.004)] },
  game: { ...game, leagueId: 'KBO' },
});
assert.equal(Number.isFinite(Number(nonMlb.results[0].formulaDiagnosticScore)), true, '非MLB仍顯示固定公式診斷分');
assert.equal(nonMlb.results[0].shadowDiagnosticScore, null, '未獨立驗證聯盟不得取得排名資格分');
assert.equal(nonMlb.results[0].scoreStatus, 'LEAGUE_MODEL_NOT_VALIDATED');
assert.equal(nonMlb.results[0].betEligible, false);

console.log('shadow-score-visibility-v102-test: PASS');
