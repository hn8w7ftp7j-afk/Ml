import assert from 'node:assert/strict';
import {
  FINAL_SCORE_INSTRUCTION_VERSION,
  FINAL_SCORE_VERSION,
  applyFinalScoreAssessment,
  normalizeFinalScoreTimeout,
  parseRetryAfter,
} from '../lib/final-scorer.js';

assert.equal(Number.isInteger(normalizeFinalScoreTimeout(12917.52)), true);
assert.equal(normalizeFinalScoreTimeout(12917.52), 12917);
assert.equal(normalizeFinalScoreTimeout(undefined, 8000), 8000);
assert.equal(parseRetryAfter('2'), 2000);
assert.equal(Number.isInteger(parseRetryAfter('2.75')), true);

const result = (market, pick, values) => ({
  market,
  pick,
  water: values.water ?? 0.95,
  waterEstimated: Boolean(values.waterEstimated),
  integrityWarning: Boolean(values.integrityWarning),
  weightedEV: values.weightedEV,
  robustEV: values.robustEV,
  conservativeEV: values.conservativeEV,
  rawEV: values.rawEV ?? values.weightedEV,
  evFlipProbability: values.evFlipProbability ?? 0.25,
  modelProbability: values.modelProbability,
  rawModelProbability: values.rawModelProbability ?? values.modelProbability,
  marketAnchorProbability: 0.5,
  confidence: values.confidence ?? 0.84,
  modelErrorFloor: values.modelErrorFloor ?? 0.025,
  independentEvidenceStrength: values.independentEvidenceStrength ?? 0.60,
  divergenceRisk: values.divergenceRisk ?? 0.05,
  score: values.legacyScore ?? 3.5,
  scoreAudit: { ok: true },
  betEligible: false,
  unitSuggestion: 0,
});

const rows = [
  result('全場讓分', '客隊受讓0平', { weightedEV: -0.012, robustEV: -0.047, conservativeEV: -0.076, modelProbability: 0.49, legacyScore: 3.5 }),
  result('全場讓分', '主隊讓0平', { weightedEV: -0.008, robustEV: -0.042, conservativeEV: -0.063, modelProbability: 0.51, legacyScore: 3.5 }),
  // Both directions are intentionally positive to exercise the opposite-direction guard.
  result('全場大小', '小9-50', { weightedEV: 0.037, robustEV: 0.019, conservativeEV: -0.009, modelProbability: 0.54, evFlipProbability: 0.20, legacyScore: 3.5 }),
  result('全場大小', '大9-50', { weightedEV: 0.012, robustEV: 0.003, conservativeEV: -0.020, modelProbability: 0.46, evFlipProbability: 0.35, legacyScore: 3.5 }),
  result('上半讓分', '客隊受讓1+80', { weightedEV: 0.004, robustEV: -0.013, conservativeEV: -0.026, modelProbability: 0.52, legacyScore: 3.5, water: 0.94 }),
  result('上半讓分', '主隊讓1+80', { weightedEV: -0.033, robustEV: -0.050, conservativeEV: -0.062, modelProbability: 0.48, legacyScore: 3.5, water: 0.94 }),
  result('上半大小', '小5-60', { weightedEV: 0.030, robustEV: 0.016, conservativeEV: -0.002, modelProbability: 0.55, evFlipProbability: 0.18, legacyScore: 3.5, water: 0.93 }),
  result('上半大小', '大5-60', { weightedEV: -0.068, robustEV: -0.081, conservativeEV: -0.105, modelProbability: 0.45, legacyScore: 3.5, water: 0.93 }),
];

const key = row => `${row.market}|||${row.pick}`;
const assessment = {
  used: true,
  version: FINAL_SCORE_VERSION,
  instructionVersion: FINAL_SCORE_INSTRUCTION_VERSION,
  model: 'openai/gpt-5.6-sol',
  summary: '最新 MLB 指令共同比較八個方向。',
  audit: {
    noFixedFormula: true,
    noDoubleCounting: true,
    hardGatesChecked: true,
    oppositesChecked: true,
    relativeRankingChecked: true,
  },
  directions: [
    { key: key(rows[0]), score: 8.0, reason: '加權EV為負，僅供測試硬上限' },
    { key: key(rows[1]), score: 4.1, reason: '加權與穩健EV皆為負' },
    { key: key(rows[2]), score: 7.6, reason: '穩健正EV，但保守尾端略為負值' },
    { key: key(rows[3]), score: 7.4, reason: '弱正EV且翻負風險較高' },
    { key: key(rows[4]), score: 5.0, reason: '加權微正但穩健EV翻負' },
    { key: key(rows[5]), score: 3.2, reason: '三種EV均明顯為負' },
    { key: key(rows[6]), score: 7.3, reason: '穩健正EV，保守尾端接近零' },
    { key: key(rows[7]), score: 2.8, reason: '三種EV均顯著為負' },
  ],
};

const analysis = {
  results: rows,
  portfolio: [],
  scoreValidation: { passed: true },
};
const finalized = applyFinalScoreAssessment({
  analysis,
  assessment,
  settings: { candidateThreshold: 7.2, strongestThreshold: 8.5 },
});

assert.equal(finalized.finalScoreVersion, FINAL_SCORE_VERSION);
assert.equal(finalized.finalScoreInstructionVersion, FINAL_SCORE_INSTRUCTION_VERSION);
assert.equal(finalized.finalScoreModel, 'openai/gpt-5.6-sol');
assert.equal(finalized.scoreValidation.noFixedFormula, true);
assert.equal(finalized.scoreValidation.latestInstructionWins, true);
assert.equal(finalized.scoreValidation.passed, true);
assert.ok(finalized.results.every(row => row.scoreSource === 'GPT 最終 Execution 判讀'));
assert.ok(finalized.results.every(row => row.scoreBreakdown?.noFixedFormula === true));
assert.ok(finalized.results.every(row => row.scoreAudit?.ok === true));

// Negative weighted EV can never retain an invented high GPT score.
const capped = finalized.results.find(row => row.pick === '客隊受讓0平');
assert.equal(capped.score, 6.6);
assert.ok(capped.scoreAudit.corrections.some(value => value.includes('硬門檻')));
assert.equal(capped.betEligible, false);

// Latest daily instruction: robust EV > 0 is the hard qualification gate;
// conservative EV is sensitivity evidence, not an extra mandatory positive gate.
const conservativeNegativeCandidate = finalized.results.find(row => row.pick === '小5-60');
assert.equal(conservativeNegativeCandidate.conservativeEV < 0, true);
assert.equal(conservativeNegativeCandidate.robustEV > 0, true);
assert.equal(conservativeNegativeCandidate.score, 7.3);
assert.equal(conservativeNegativeCandidate.betEligible, true);

// Opposite directions may not both remain at 7.2+.
const totalPair = finalized.results.filter(row => row.market === '全場大小');
assert.equal(totalPair.filter(row => row.score >= 7.2).length, 1);
assert.equal(totalPair.filter(row => row.score === 7.1).length, 1);
assert.ok(finalized.scoreValidation.corrections.some(value => value.includes('正反方向衝突')));

// Old formula score is retained only for audit, never used as the published score.
assert.ok(finalized.results.every(row => row.legacyDiagnosticScore === 3.5));
assert.ok(new Set(finalized.results.map(row => row.score.toFixed(1))).size >= 5);
assert.equal(finalized.scoreValidation.distributionAudit.passed, true);
assert.ok(finalized.portfolio.reduce((sum, row) => sum + row.recommendedUnit, 0) <= 2.000001);

const missingWaterRow = {
  ...result('全場大小', '小8+50', { weightedEV: 0, robustEV: 0, conservativeEV: 0, modelProbability: 0.5 }),
  water: null,
  score: null,
  tag: '水位未提供｜不評分',
  betEligible: false,
};
const withMissing = applyFinalScoreAssessment({
  analysis: { ...analysis, results: [...rows, missingWaterRow] },
  assessment,
  settings: { candidateThreshold: 7.2, strongestThreshold: 8.5 },
});
const preserved = withMissing.results.find(row => row.pick === '小8+50');
assert.equal(preserved.score, null);
assert.equal(preserved.tag, '水位未提供｜不評分');
assert.equal(preserved.scoreSource, '上游資料閘門未通過');
assert.equal(preserved.scoreAudit.ok, true);
assert.equal(preserved.scoreAudit.skipped, true);
assert.equal(preserved.betEligible, false);
assert.equal(withMissing.scoreValidation.passed, true);

console.log(JSON.stringify({
  ok: true,
  version: FINAL_SCORE_VERSION,
  scores: finalized.results.map(row => ({ market: row.market, pick: row.pick, score: row.score, eligible: row.betEligible })),
  corrections: finalized.scoreValidation.corrections,
}, null, 2));
