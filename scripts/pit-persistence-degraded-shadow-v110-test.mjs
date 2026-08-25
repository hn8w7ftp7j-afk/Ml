import assert from 'node:assert/strict';
import { enforceUnconfirmedPitShadowSafety } from '../lib/pit-persistence-safety-v110.js';

const original = {
  ok: true,
  betEligible: false,
  analysis: {
    results: [{
      pick: '大8平',
      weightedEV: 0.04,
      robustEV: 0.01,
      shadowDiagnosticScore: 7.8,
      rankingQualified: true,
      executable: true,
      betEligible: true,
      evCalibration: { actualReaderEligible: true },
    }],
  },
};
const pitPersistence = { status: 'FAILED', confirmed: false, required: true, reason: 'WRITE_FAILED' };
const degraded = enforceUnconfirmedPitShadowSafety(original, pitPersistence);

assert.equal(degraded.ok, true, 'PIT失敗仍須回傳唯讀影子分析');
assert.equal(degraded.pitDegraded, true);
assert.equal(degraded.analysis.results[0].shadowDiagnosticScore, 7.8, '診斷分不得被改寫');
assert.equal(degraded.analysis.results[0].weightedEV, 0.04, 'W不得被改寫');
assert.equal(degraded.analysis.results[0].robustEV, 0.01, 'R不得被改寫');
assert.equal(degraded.analysis.results[0].rankingQualified, false, 'PIT未確認不得列入排名');
assert.equal(degraded.analysis.results[0].betEligible, false, 'PIT未確認不得下注');
assert.equal(degraded.analysis.results[0].evCalibration.actualReaderEligible, true, 'PIT故障不得冒充Reader過期或改寫Reader驗證狀態');
assert.equal(degraded.analysis.results[0].pitPersistenceEligible, false, 'PIT資格必須獨立停用');
assert.match(degraded.analysis.results[0].pitPersistenceReason, /^PIT_UNCONFIRMED:/);
assert.equal(original.analysis.results[0].rankingQualified, true, '不得污染快取中的原始分析，DB恢復後才能重新取得排名資格');

console.log('PIT quota degradation preserves diagnostics while disabling ranking and betting PASS');
