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
  assert.ok(row.formulaDiagnosticScore >= 1.0 && row.formulaDiagnosticScore <= 8.9);
  assert.equal(row.score, null);
  assert.equal(row.betEligible, false);
}
const negativeScores = allDirections.results.filter(row => row.weightedEV <= 0).map(row => row.formulaDiagnosticScore);
assert.ok(new Set(negativeScores).size > 1, '不同負W/R必須產生可比較的1.0～6.6連續分數');
assert.ok(negativeScores.every(value => value >= 1.0 && value <= 6.6));
assert.ok(allDirections.results.some(row => row.formulaDiagnosticScore >= 7.2));

const observation = finalizeDeterministicAnalysis({ analysis: { leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true }, results: [direction('全場大小', '大9平', 0.01, -0.01)] }, game });
assert.equal(observation.results[0].formulaDiagnosticScore, 6.9, 'W>0且R≤0必須依實際W/R落在6.7～7.1');

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
assert.equal(qualifiedObservation.results[0].formulaDiagnosticScore, 6.9);
assert.equal(qualifiedObservation.results[0].shadowDiagnosticScore, 6.9, '合格W>0/R≤0必須顯示連續觀察分數，不得被signStable誤擋');
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
assert.equal(extremeVisible.rankingQualified, true, '不得只因W達15%就取消排名；應由資料、數學、情境穩定與模型/Tai888差距QA判斷');
assert.ok(extremeVisible.scoreBreakdown.rawScore >= extremeVisible.formulaDiagnosticScore);
assert.equal(extremeVisible.scoreBreakdown.caps.includes('UNCALIBRATED_W_OVER_15_PERCENT'), false);

const implausibleDistribution = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大6平', 0.355, 0.3214, 0.708),
      rawMarketProbabilityGap: null,
      tai888MarketProbabilityGap: 0.208,
      marketVerification: { verified: true, referencePriorEligible: true, secondaryIndependentMarketVerified: true },
      evCalibration: { ...common.evCalibration, extreme: true, auditWarnings: ['未校準模型W達35.5%'] },
    }],
  },
  game,
}).results[0];
assert.equal(implausibleDistribution.formulaDiagnosticScore, 8.9, '市場高度分歧不得取消固定公式S分數');
assert.equal(implausibleDistribution.scoreBreakdown.rawUnqualifiedScore, null);
assert.equal(implausibleDistribution.shadowDiagnosticScore, 8.9);
assert.equal(implausibleDistribution.scoreAudit.ok, true, '沒有實質資料或數學錯誤時QA必須PASS');
assert.equal(implausibleDistribution.rankingQualified, true, '市場差距與極高EV都只能WARNING，不得取消排名');
assert.doesNotMatch(implausibleDistribution.tag, /QA BLOCK|不可下注|不下注/);
assert.deepEqual(implausibleDistribution.scoreAudit.plausibility.failures, []);
assert.match(implausibleDistribution.scoreAudit.plausibility.auditWarnings.join('；'), /高度分歧 20\.80pp/);
assert.ok(implausibleDistribution.scoreBreakdown.caps.includes('TARGET_MARKET_PROBABILITY_GAP_WARNING'));
assert.ok(implausibleDistribution.scoreBreakdown.caps.includes('WEIGHTED_EV_20_PERCENT_WARNING'));
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
assert.equal(strongestInput(false).formulaDiagnosticScore, 8.4, '缺少兩個獨立同合約市場時，最強區間必須封頂8.4');
assert.equal(strongestInput(false).rankingQualified, true, '外部市場未使用不得阻擋7.2～8.4分析排名');
assert.ok(strongestInput(false).scoreBreakdown.caps.includes('TWO_INDEPENDENT_MARKETS_NOT_VERIFIED'));
assert.ok(strongestInput(true).formulaDiagnosticScore >= 8.5, '外部市場驗證只控制8.5資格，不得改寫分布或W/R');

const extremeReview = finalizeDeterministicAnalysis({
  analysis: {
    leagueId: 'MLB', alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' }, dataGateV10: { passedForShadowScore: true },
    results: [{
      ...direction('全場大小', '大9平', 0.20, 0.08),
      marketVerification: { verified: true, referencePriorEligible: true, secondaryIndependentMarketVerified: true },
    }],
  },
  game,
}).results[0];
assert.ok(extremeReview.formulaDiagnosticScore >= 8.5, '極端EV複核不得改寫固定公式分數');
assert.equal(extremeReview.rankingQualified, true, 'W達20%以上只作警示，不得暫停排名');
assert.equal(extremeReview.extremeEvReviewRequired, true);
assert.equal(extremeReview.scoreAudit.extremeEvReview.passed, true);
assert.equal(extremeReview.scoreAudit.extremeEvReview.hardGate, false);
assert.ok(extremeReview.scoreBreakdown.caps.includes('WEIGHTED_EV_20_PERCENT_WARNING'));

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

for (const leagueId of ['NPB', 'KBO', 'CPBL']) {
  const asian = finalizeDeterministicAnalysis({
    analysis: {
      leagueId,
      alignmentAudit: { targetMarketCalibration: 'DISABLED' },
      dataGateV10: { passedForShadowScore: true },
      results: [direction('全場大小', '大8平', 0.025, 0.01)],
    },
    game: { ...game, leagueId },
  });
  assert.equal(Number.isFinite(asian.results[0].formulaDiagnosticScore), true, `${leagueId}應顯示驗證中公式分數`);
  assert.equal(asian.results[0].scoreStatus, 'SHADOW_DIAGNOSTIC_UNCALIBRATED');
  assert.equal(asian.results[0].betEligible, false);

  const largeTai888Gap = finalizeDeterministicAnalysis({
    analysis: {
      leagueId,
      alignmentAudit: { targetMarketCalibration: 'DISABLED' },
      dataGateV10: { passedForShadowScore: true },
      results: [{
        ...direction('全場大小', '大8平', 0.025, 0.01),
        rawMarketProbabilityGap: null,
        tai888MarketProbabilityGap: 0.25,
      }],
    },
    game: { ...game, leagueId },
  });
  assert.equal(Number.isFinite(largeTai888Gap.results[0].formulaDiagnosticScore), true, `${leagueId} Tai888差距只作影子稽核，不得硬性BLOCK`);
  assert.equal(largeTai888Gap.results[0].scoreAudit.plausibility.hardGate, false);
  assert.equal(largeTai888Gap.results[0].scoreAudit.plausibility.observedWithinLimit, false);
  assert.equal(largeTai888Gap.results[0].scoreAudit.plausibility.auditWarnings.length, 1);
}

console.log('shadow-score-visibility-v102-test: PASS');
