import assert from 'node:assert/strict';
import fs from 'node:fs';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(page, /應評 \{expectedDirectionCount\} 方向/);
assert.match(page, /已評 \{scoredDirectionCount\}\/\{expectedDirectionCount\}/);
assert.match(page, /排名資格：/);
assert.match(page, /const expectedDirectionCount = 8/);
assert.match(page, /scoredDirectionCount = actualRows\.filter\(row => modelEvValue\(row\) != null\)\.length/);
assert.match(page, /資料／QA狀態：\{qaLabel\}/);
assert.match(page, /signedPct\(modelEV\)/);
assert.match(page, /sort\(\(left, right\) => Number\(right\.weightedEV \?\? -Infinity\) - Number\(left\.weightedEV \?\? -Infinity\)/);

const baseRow = {
  market: '全場大小', pick: '小9+10', water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT', waterEstimated: false,
  executable: true, modelProbability: 0.5099,
  marketVerification: { verified: false }, rawMarketProbabilityGap: 0,
  evCalibration: { qualified: true, actualReaderEligible: true, scenarioStable: true },
};
const analysis = finalizeDeterministicAnalysis({
  game: { leagueId: 'MLB' },
  analysis: {
    leagueId: 'MLB',
    alignmentAudit: { targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY' },
    dataGateV10: { passedForShadowScore: true },
    results: [
    { ...baseRow, weightedEV: 0.0039, robustEV: -0.1406 },
    { ...baseRow, pick: '大9+10', modelProbability: 0.4901, weightedEV: -0.031, robustEV: -0.178 },
    ],
  },
  settings: { candidateThreshold: 7.2 },
});

for (const row of analysis.results) {
  assert.equal(Number.isFinite(row.weightedEV), true, 'QA或分數Gate不得刪除已計算的模型EV（W）');
  assert.equal(Number.isFinite(row.robustEV), true, 'QA或分數Gate不得刪除已計算的穩健EV（R）');
  assert.equal(row.rankingQualified, false, '負Robust EV或負Raw EV不得進排名');
  assert.equal(typeof row.rankingQualificationReason, 'string');
  assert.ok(row.rankingQualificationReason.length > 0, '未進排名必須附原因');
}

console.log('complete score presentation v10.2 test passed');
