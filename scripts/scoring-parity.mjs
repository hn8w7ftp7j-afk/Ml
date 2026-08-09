import assert from 'node:assert/strict';
import {
  SCORE_CONTRACT_VERSION,
  scoreEvidenceBreakdown,
  scoreFromCompositeEV,
  validateScoreContract,
} from '../lib/markets.js';

const cases = [
  {
    name: '中性／無優勢',
    cev: 0,
    options: { weightedEV: -0.002, robustEV: -0.015, flipProbability: 0.55, quality: 0.78, edgeStrength: 0, stability: 0.40, modelErrorFloor: 0.025, independentEvidence: 0.50, divergenceRisk: 0.08 },
    range: [4.4, 5.1],
  },
  {
    name: '明顯負 EV',
    cev: -0.035,
    options: { weightedEV: -0.025, robustEV: -0.045, flipProbability: 0.82, quality: 0.82, edgeStrength: -0.55, stability: 0.15, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.12 },
    range: [3.2, 3.9],
  },
  {
    name: '觀察區',
    cev: 0.012,
    options: { weightedEV: 0.018, robustEV: 0.002, flipProbability: 0.40, quality: 0.82, edgeStrength: 0.18, stability: 0.52, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 },
    range: [5.2, 6.2],
  },
  {
    name: '下注候選',
    cev: 0.041,
    options: { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 },
    range: [7.2, 7.9],
  },
  {
    name: '主推',
    cev: 0.061,
    options: { weightedEV: 0.078, robustEV: 0.062, flipProbability: 0.08, quality: 0.88, edgeStrength: 0.70, stability: 0.86, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 },
    range: [8.0, 8.49],
  },
  {
    name: '最強主推',
    cev: 0.090,
    options: { weightedEV: 0.112, robustEV: 0.086, flipProbability: 0.05, quality: 0.92, edgeStrength: 0.85, stability: 0.90, modelErrorFloor: 0.025, independentEvidence: 0.78, divergenceRisk: 0.03 },
    range: [8.5, 9.4],
  },
  {
    name: '舊版 10 分爆分案例',
    cev: 0.10,
    options: { weightedEV: 0.13, robustEV: 0.1179, flipProbability: 0.06, quality: 0.88, edgeStrength: 0.80, stability: 0.88, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 },
    range: [8.3, 9.1],
  },
];

for (const row of cases) {
  const score = scoreFromCompositeEV(row.cev, row.options);
  assert.ok(score >= row.range[0] && score <= row.range[1], `${row.name} 分數 ${score.toFixed(3)} 不在 ${row.range.join('～')}`);
  assert.notEqual(score, 0, `${row.name} 不可為 0 分`);
  assert.notEqual(score, 10, `${row.name} 不可為 10 分`);
  const audit = validateScoreContract(score, row.cev, row.options);
  assert.equal(audit.ok, true, `${row.name} 驗算失敗：${audit.errors.join('；')}`);
  assert.ok(Math.abs(audit.expectedScore - score) < 1e-12);
  assert.equal(audit.breakdown.version, SCORE_CONTRACT_VERSION);
}

// 使用者 2026-08-09 截圖的黏底回歸：四個證據組不得再全部變成 3.5。
const screenshotCases = [
  { name: '全場讓分較差側', cev: -0.0758, options: { weightedEV: -0.0122, robustEV: -0.0470, flipProbability: 0.65, quality: 0.85, edgeStrength: -0.10, stability: 0.25, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 }, range: [3.5, 4.2] },
  { name: '全場讓分較佳側', cev: -0.0631, options: { weightedEV: -0.0078, robustEV: -0.0423, flipProbability: 0.60, quality: 0.85, edgeStrength: -0.07, stability: 0.30, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 }, range: [3.7, 4.4] },
  { name: '全場小分弱正訊號', cev: -0.0309, options: { weightedEV: 0.0226, robustEV: 0.0015, flipProbability: 0.42, quality: 0.85, edgeStrength: 0.15, stability: 0.52, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.05 }, range: [5.0, 5.8] },
  { name: '全場大分明顯負值', cev: -0.1179, options: { weightedEV: -0.0521, robustEV: -0.0729, flipProbability: 0.80, quality: 0.85, edgeStrength: -0.50, stability: 0.12, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.10 }, range: [2.5, 3.5] },
];
const screenshotScores = screenshotCases.map(row => {
  const score = scoreFromCompositeEV(row.cev, row.options);
  assert.ok(score >= row.range[0] && score <= row.range[1], `${row.name} 回歸分數 ${score.toFixed(3)} 不在 ${row.range.join('～')}`);
  return score;
});
assert.ok(screenshotScores[1] > screenshotScores[0], '較佳讓分證據不得與較差側同分');
assert.ok(screenshotScores[2] > screenshotScores[1], '弱正訊號大小盤應高於兩個負 EV 讓分方向');
assert.ok(screenshotScores[3] < screenshotScores[0], '明顯負 EV 應低於一般負 EV');
assert.ok(new Set(screenshotScores.map(value => value.toFixed(1))).size >= 4, `截圖回歸仍黏分：${screenshotScores.map(value => value.toFixed(1)).join(', ')}`);
assert.ok(screenshotScores.filter(value => Math.abs(value - 3.5) < 1e-9).length <= 1, '不可再次大量黏在 3.5');

// 單調性：所有正面證據同步改善時，分數不得下降。
const monotonicRows = [
  { cev: -0.02, weightedEV: -0.03, robustEV: -0.04, flipProbability: 0.75, quality: 0.72, edgeStrength: -0.45, stability: 0.20, independentEvidence: 0.35 },
  { cev: 0.00, weightedEV: -0.005, robustEV: -0.015, flipProbability: 0.55, quality: 0.76, edgeStrength: -0.10, stability: 0.40, independentEvidence: 0.45 },
  { cev: 0.02, weightedEV: 0.025, robustEV: 0.010, flipProbability: 0.35, quality: 0.80, edgeStrength: 0.20, stability: 0.58, independentEvidence: 0.55 },
  { cev: 0.045, weightedEV: 0.055, robustEV: 0.045, flipProbability: 0.15, quality: 0.85, edgeStrength: 0.55, stability: 0.78, independentEvidence: 0.65 },
  { cev: 0.075, weightedEV: 0.09, robustEV: 0.073, flipProbability: 0.08, quality: 0.90, edgeStrength: 0.78, stability: 0.88, independentEvidence: 0.75 },
].map(row => scoreFromCompositeEV(row.cev, { ...row, modelErrorFloor: 0.025, divergenceRisk: 0.05 }));
for (let index = 1; index < monotonicRows.length; index += 1) {
  assert.ok(monotonicRows[index] >= monotonicRows[index - 1] - 1e-12, `單調性失敗：${monotonicRows[index - 1]} → ${monotonicRows[index]}`);
}

// 微小擾動穩定性：正常資料的小幅變動不能讓分數跳一個完整級距。
const baseOptions = { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 };
const baseScore = scoreFromCompositeEV(0.041, baseOptions);
const perturbations = [
  [0.039, { ...baseOptions, weightedEV: 0.050, robustEV: 0.041 }],
  [0.043, { ...baseOptions, weightedEV: 0.054, robustEV: 0.045 }],
  [0.041, { ...baseOptions, quality: 0.83, stability: 0.77 }],
  [0.041, { ...baseOptions, quality: 0.87, stability: 0.83 }],
];
for (const [cev, options] of perturbations) {
  const score = scoreFromCompositeEV(cev, options);
  assert.ok(Math.abs(score - baseScore) <= 0.45, `微小擾動跳分過大：${baseScore.toFixed(3)} → ${score.toFixed(3)}`);
}

// 連續負 EV 梯度不可因下限而變成同一分數。
const negativeLadder = [-0.12, -0.09, -0.06, -0.04, -0.02, 0].map((cev, index) => scoreFromCompositeEV(cev, {
  weightedEV: cev + 0.01,
  robustEV: cev - 0.005,
  flipProbability: 0.85 - index * 0.10,
  quality: 0.82,
  edgeStrength: -0.70 + index * 0.14,
  stability: 0.12 + index * 0.10,
  modelErrorFloor: 0.025,
  independentEvidence: 0.55,
  divergenceRisk: 0.08,
}));
for (let index = 1; index < negativeLadder.length; index += 1) assert.ok(negativeLadder[index] > negativeLadder[index - 1], `負 EV 梯度未遞增：${negativeLadder}`);
assert.ok(new Set(negativeLadder.map(value => value.toFixed(1))).size >= 5, `負 EV 梯度仍黏分：${negativeLadder}`);

// 硬閘門驗算。
assert.equal(validateScoreContract(7.3, 0.01, { weightedEV: -0.001, robustEV: 0.01 }).ok, false);
assert.equal(validateScoreContract(8.6, 0.04, { weightedEV: 0.06, robustEV: 0.04, flipProbability: 0.25, quality: 0.75, modelErrorFloor: 0.025, independentEvidence: 0.40 }).ok, false);
assert.equal(validateScoreContract(10, 0.10, { weightedEV: 0.13, robustEV: 0.12, flipProbability: 0.03, quality: 0.95, modelErrorFloor: 0.025, independentEvidence: 0.80 }).ok, false);
assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.3');

console.log(JSON.stringify({
  ok: true,
  scoreContractVersion: SCORE_CONTRACT_VERSION,
  benchmarks: cases.map(row => ({ name: row.name, score: scoreFromCompositeEV(row.cev, row.options) })),
  screenshotRegression: screenshotCases.map((row, index) => ({ name: row.name, score: screenshotScores[index], breakdown: scoreEvidenceBreakdown(row.cev, row.options) })),
  negativeLadder,
  perturbationMaximum: Math.max(...perturbations.map(([cev, options]) => Math.abs(scoreFromCompositeEV(cev, options) - baseScore))),
}, null, 2));
