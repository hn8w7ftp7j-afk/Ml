import assert from 'node:assert/strict';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const common = { evCalibration: { qualified: true, referencePriorEligible: true, actualReaderEligible: true, scenarioStable: true, extreme: false, reasons: [], auditWarnings: [] }, marketVerification: { verified: true, referencePriorEligible: true }, water: 0.94, waterEstimated: false, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', lineFresh: true, executable: true, distributionCoverage: 1, evDoubleCheck: { passed: true }, dataGateV10: { passedForShadowScore: true, blocking: [] }, numericalQA: { passed: true, signStable: true }, marketCalibrationApplied: false, rawMarketProbabilityGap: 0.01 };
const direction = (market, pick, weightedEV, robustEV, modelProbability = 0.5) => ({ ...common, market, pick, weightedEV, robustEV, modelProbability });
const game = { leagueId: 'MLB', away: '客隊', home: '主隊' };

const rows = [
  direction('全場讓分', '客隊讓1平', 0.015, 0.004), direction('全場讓分', '主隊受讓1平', -0.02, -0.03),
  direction('全場大小', '大9平', 0.015, 0.004), direction('全場大小', '小9平', -0.20, -0.25),
  direction('上半讓分', '客隊讓0.5', 0.015, 0.004), direction('上半讓分', '主隊受讓0.5', -0.08, -0.12),
  direction('上半大小', '大5平', 0.015, 0.004), direction('上半大小', '小5平', -0.02, -0.03),
];
const allDirections = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true }, results: rows }, game });
assert.equal(allDirections.results.length, 8);
for (const row of allDirections.results) {
  assert.equal(Number.isFinite(Number(row.formulaDiagnosticScore)), true);
  assert.ok(row.formulaDiagnosticScore >= 6.6 && row.formulaDiagnosticScore <= 8.9);
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
}
for (const row of allDirections.results.filter(row => row.weightedEV <= 0)) assert.equal(row.formulaDiagnosticScore, 6.6, 'W≤0一律固定PASS 6.6，不得產生1.x/2.x/3.x診斷分');
assert.ok(allDirections.results.some(row => row.formulaDiagnosticScore >= 7.2));

const observation = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true }, results: [direction('全場大小', '大9平', 0.01, -0.01)] }, game });
assert.equal(observation.results[0].formulaDiagnosticScore, 7.1, 'W>0且R≤0固定觀察7.1');

const qualifiedObservation = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.01, -0.01),
      numericalQA: { passed: true, signStable: false },
      marketVerification: { verified: true, referencePriorEligible: true },
      evCalibration: { qualified: true, referencePriorEligible: true, actualReaderEligible: true, reasons: [], auditWarnings: [] },
    }],
  },
  game,
});
assert.equal(qualifiedObservation.results[0].formulaDiagnosticScore, 7.1);
assert.equal(qualifiedObservation.results[0].shadowDiagnosticScore, 7.1, '合格W>0/R≤0必須顯示7.1觀察，不得被signStable誤擋');
assert.equal(qualifiedObservation.results[0].scoreAudit.ok, true);
assert.equal(qualifiedObservation.results[0].rankingQualified, false);

const unstableVisible = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.08, 0.02),
      evCalibration: { ...common.evCalibration, rawScenarioSpread: 0.06, scenarioStable: false, auditWarnings: ['模型W/R情境差距6.0個百分點'] },
    }],
  },
  game,
}).results[0];
assert.ok(unstableVisible.formulaDiagnosticScore > 7.1, 'W/R差距超過5%仍須保留固定公式算出的原始S，不得人工封頂7.1');
assert.equal(unstableVisible.rankingQualified, false);
assert.ok(unstableVisible.scoreBreakdown.rawScore >= unstableVisible.formulaDiagnosticScore);
assert.ok(unstableVisible.scoreBreakdown.caps.includes('SCENARIO_SPREAD_OVER_5_PERCENT'));

const extremeVisible = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.16, 0.08),
      evCalibration: { ...common.evCalibration, extreme: true, auditWarnings: ['未校準模型W達16.0%'] },
    }],
  },
  game,
}).results[0];
assert.ok(extremeVisible.formulaDiagnosticScore > 7.1, 'W達15%以上仍須保留固定公式原始S，不得人工封頂');
assert.equal(extremeVisible.rankingQualified, false);
assert.ok(extremeVisible.scoreBreakdown.rawScore >= extremeVisible.formulaDiagnosticScore);
assert.ok(extremeVisible.scoreBreakdown.caps.includes('UNCALIBRATED_W_OVER_15_PERCENT'));

const implausibleDistribution = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大6平', 0.355, 0.3214, 0.708),
      rawMarketProbabilityGap: null,
      tai888MarketProbabilityGap: 0.208,
      evCalibration: { ...common.evCalibration, extreme: true, auditWarnings: ['未校準模型W達35.5%'] },
    }],
  },
  game,
}).results[0];
assert.equal(implausibleDistribution.formulaDiagnosticScore, null, '比分分布合理性未通過時不得顯示精確公式分數');
assert.equal(implausibleDistribution.shadowDiagnosticScore, null);
assert.equal(implausibleDistribution.scoreAudit.ok, false, '模型與Tai888去水機率極端背離時不得標示QA PASS');
assert.equal(implausibleDistribution.rankingQualified, false);
assert.match(implausibleDistribution.tag, /QA BLOCK/);
assert.match(implausibleDistribution.scoreAudit.plausibility.failures.join('；'), /比分分布合理性未通過/);
assert.equal(implausibleDistribution.scoreAudit.plausibility.targetMarketProbabilityGap, 0.208);
assert.equal(implausibleDistribution.scoreAudit.plausibility.source, 'tai888MarketProbabilityGap');

const strongestInput = secondaryIndependentMarketVerified => finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.082, 0.072),
      marketVerification: { verified: true, referencePriorEligible: true, secondaryIndependentMarketVerified },
      evCalibration: { qualified: true, referencePriorEligible: true, actualReaderEligible: true, reasons: [], auditWarnings: [] },
    }],
  },
  game,
}).results[0];
assert.equal(strongestInput(false).formulaDiagnosticScore, 8.4, '單一三莊快照沒有第二外部市場時必須封頂8.4');
assert.ok(strongestInput(true).formulaDiagnosticScore >= 8.5, '只有明確第二獨立外部市場驗證才能進8.5+');

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
assert.match(calibrationBlocked.results[0].tag, /模型評分未通過/);

const rawModelAuditOnly = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.03, 0.015),
      distributionCoverage: 0.7,
      integrityWarning: true,
      integrityMessage: '原始比分模型完整性警告',
      evDoubleCheck: { passed: false },
      dataGateV10: { passedForShadowScore: false, blocking: ['原始球隊資料'] },
      marketVerification: { verified: true, referencePriorEligible: true },
      evCalibration: { qualified: true, referencePriorEligible: true, actualReaderEligible: true, reasons: [], auditWarnings: ['原始模型只供稽核'] },
    }],
  },
  game,
});
assert.equal(rawModelAuditOnly.results[0].scoreAudit.ok, false, '核心模型或資料閘門失敗時必須拒絕評分');
assert.equal(rawModelAuditOnly.results[0].shadowDiagnosticScore, null);

const staleReaderMustNotScore = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB',
    alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.03, 0.015),
      lineFresh: false,
      executable: false,
      evCalibration: { qualified: true, referencePriorEligible: true, actualReaderEligible: false, reasons: [], auditWarnings: [] },
    }],
  },
  game,
});
assert.equal(staleReaderMustNotScore.results[0].formulaDiagnosticScore, null, 'stale Reader rows must lose even the visible formula score');
assert.equal(staleReaderMustNotScore.results[0].shadowDiagnosticScore, null);
assert.equal(staleReaderMustNotScore.results[0].rankingQualified, undefined);
assert.match(staleReaderMustNotScore.results[0].scoreAudit.reason, /Reader 實際盤已過期/);

const missingWater = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true }, results: [{ ...direction('全場大小', '大9平', 0.015, 0.004), water: null }] }, game });
assert.equal(missingWater.results[0].formulaDiagnosticScore, null);

const nonMlb = finalizeDeterministicAnalysis({ analysis: { leagueId: 'KBO', results: [direction('全場大小', '大9平', 0.015, 0.004)] }, game: { ...game, leagueId: 'KBO' } });
assert.equal(nonMlb.results[0].formulaDiagnosticScore, null);
assert.equal(nonMlb.results[0].shadowDiagnosticScore, null);
assert.equal(nonMlb.results[0].scoreStatus, 'LEAGUE_MODEL_NOT_VALIDATED');
assert.equal(nonMlb.results[0].betEligible, false);

console.log('shadow-score-visibility-v102-test: PASS');
