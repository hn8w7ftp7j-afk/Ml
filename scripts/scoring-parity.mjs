import assert from 'node:assert/strict';
import {
  SCORE_CONTRACT_VERSION,
  scoreFromCompositeEV,
  validateScoreContract,
} from '../lib/markets.js';

const cases = [
  {
    name: '中性／無優勢',
    cev: 0,
    options: { weightedEV: -0.002, robustEV: -0.015, flipProbability: 0.55, quality: 0.78, edgeStrength: 0, stability: 0.40, modelErrorFloor: 0.025, independentEvidence: 0.50, divergenceRisk: 0.08 },
    range: [3.5, 5.2],
  },
  {
    name: '明顯負 EV',
    cev: -0.035,
    options: { weightedEV: -0.025, robustEV: -0.045, flipProbability: 0.82, quality: 0.82, edgeStrength: -0.55, stability: 0.15, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.12 },
    range: [3.5, 4.5],
  },
  {
    name: '觀察區',
    cev: 0.012,
    options: { weightedEV: 0.018, robustEV: 0.002, flipProbability: 0.40, quality: 0.82, edgeStrength: 0.18, stability: 0.52, modelErrorFloor: 0.025, independentEvidence: 0.55, divergenceRisk: 0.08 },
    range: [4.5, 6.6],
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
    range: [8.2, 9.39],
  },
];

for (const row of cases) {
  const score = scoreFromCompositeEV(row.cev, row.options);
  assert.ok(score >= row.range[0] && score <= row.range[1], `${row.name} 分數 ${score.toFixed(3)} 不在 ${row.range.join('～')}`);
  assert.notEqual(score, 0, `${row.name} 不可為 0 分`);
  assert.notEqual(score, 10, `${row.name} 不可為 10 分`);
  const audit = validateScoreContract(score, row.cev, row.options);
  assert.equal(audit.ok, true, `${row.name} 驗算失敗：${audit.errors.join('；')}`);
}

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

// 硬閘門驗算。
assert.equal(validateScoreContract(7.3, 0.01, { weightedEV: -0.001, robustEV: 0.01 }).ok, false);
assert.equal(validateScoreContract(8.6, 0.04, { weightedEV: 0.06, robustEV: 0.04, flipProbability: 0.25, quality: 0.75, modelErrorFloor: 0.025, independentEvidence: 0.40 }).ok, false);
assert.equal(validateScoreContract(10, 0.10, { weightedEV: 0.13, robustEV: 0.12, flipProbability: 0.03, quality: 0.95, modelErrorFloor: 0.025, independentEvidence: 0.80 }).ok, false);
assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.2');

console.log(JSON.stringify({
  ok: true,
  scoreContractVersion: SCORE_CONTRACT_VERSION,
  benchmarks: cases.map(row => ({ name: row.name, score: scoreFromCompositeEV(row.cev, row.options) })),
  perturbationMaximum: Math.max(...perturbations.map(([cev, options]) => Math.abs(scoreFromCompositeEV(cev, options) - baseScore))),
}, null, 2));
