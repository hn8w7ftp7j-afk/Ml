import assert from 'node:assert/strict';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const game = { leagueId: 'MLB', away: '小熊', home: '響尾蛇' };
const baseRow = {
  market: '全場大小',
  pick: '大8-60',
  water: 0.94,
  waterEstimated: false,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  weightedEV: 0.4141,
  robustEV: 0.3741,
  modelProbability: 0.7269,
  tai888MarketProbabilityGap: 0.2269,
  numericalQA: { passed: true, signStable: true },
  dataGateV10: { passedForShadowScore: true, blocking: [] },
  evCalibration: {
    qualified: true,
    actualReaderEligible: true,
    scenarioStable: true,
    rawScenarioSpread: 0.04,
    reasons: [],
    auditWarnings: [],
  },
  marketVerification: {
    verified: true,
    referencePriorEligible: true,
    secondaryIndependentMarketVerified: true,
  },
  marketCalibrationApplied: false,
  marketBaselineApplied: false,
  targetPriceCalibratesDistribution: false,
};

const analysis = row => ({
  leagueId: 'MLB',
  alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' },
  dataGateV10: { passedForShadowScore: true },
  results: [row],
});

const highEv = finalizeDeterministicAnalysis({ analysis: analysis(baseRow), game }).results[0];
assert.equal(highEv.formulaDiagnosticScore, 8.9, 'fixed dual-EV formula must retain the existing 8.9 maximum');
assert.equal(highEv.shadowDiagnosticScore, 8.9);
assert.equal(highEv.rankingQualified, true, 'high EV and >10pp market disagreement must remain rankable');
assert.equal(highEv.scoreAudit.ok, true);
assert.equal(highEv.scoreAudit.plausibility.passed, true);
assert.equal(highEv.scoreAudit.plausibility.hardGate, false);
assert.equal(highEv.scoreAudit.extremeEvReview.passed, true);
assert.equal(highEv.scoreAudit.extremeEvReview.hardGate, false);
assert.match(highEv.diagnosticWarnings.join('；'), /高度分歧 22\.69pp/);
assert.match(highEv.diagnosticWarnings.join('；'), /極高模型EV，建議複核/);
assert.ok(highEv.scoreBreakdown.caps.includes('TARGET_MARKET_PROBABILITY_GAP_WARNING'));
assert.ok(highEv.scoreBreakdown.caps.includes('WEIGHTED_EV_20_PERCENT_WARNING'));
assert.equal(highEv.scoreBreakdown.caps.includes('TARGET_MARKET_PROBABILITY_GAP_QA_BLOCK'), false);
assert.equal(highEv.scoreBreakdown.caps.includes('WEIGHTED_EV_20_PERCENT_REVIEW'), false);

const invalidMath = finalizeDeterministicAnalysis({
  analysis: analysis({ ...baseRow, weightedEV: 0.10, robustEV: 0.12, tai888MarketProbabilityGap: 0.01 }),
  game,
}).results[0];
assert.equal(invalidMath.formulaDiagnosticScore, null, 'a real W/R mathematical contradiction must still BLOCK');
assert.equal(invalidMath.shadowDiagnosticScore, null);
assert.equal(invalidMath.rankingQualified, false);
assert.equal(invalidMath.scoreAudit.ok, false);
assert.match(invalidMath.scoreAudit.baseQa.failures.join('；'), /Robust EV高於Weighted EV/);

console.log('high EV warning-only ranking and true-QA blocking regression PASS');
