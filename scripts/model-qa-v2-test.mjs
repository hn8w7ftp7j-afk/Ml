import assert from 'node:assert/strict';
import { auditModelDirection, auditModelGame } from '../lib/model-qa-v2.js';

const normal = auditModelDirection({
  weightedEV: 0.06, robustEV: 0.035, modelProbability: 0.55, marketAnchorProbability: 0.51,
  distributionCoverage: 1, evCalibration: { rawScenarioSpread: 0.025 }, numericalQA: { passed: true }, pairAudit: { passed: true },
});
assert.equal(normal.status, 'PASS');

const wide = auditModelDirection({
  weightedEV: 0.08, robustEV: -0.04, modelProbability: 0.62, marketAnchorProbability: 0.50,
  distributionCoverage: 1, evCalibration: { rawScenarioSpread: 0.12 }, numericalQA: { passed: true }, pairAudit: { passed: true },
});
assert.equal(wide.status, 'WARN');
assert.ok(wide.issues.some(item => item.code === 'SCENARIO_SPREAD_WIDE'));
assert.ok(wide.issues.some(item => item.code === 'MODEL_MARKET_DIVERGENCE'));
assert.equal(wide.mutatesEV, false);
assert.equal(wide.mutatesScore, false);
assert.equal(wide.mutatesRanking, false);

const extreme = auditModelDirection({ weightedEV: 0.18, robustEV: 0.14, distributionCoverage: 1, numericalQA: { passed: true }, pairAudit: { passed: true } });
assert.equal(extreme.status, 'WARN');
assert.ok(extreme.issues.some(item => item.code === 'EV_EXTREME'));

const broken = auditModelDirection({ weightedEV: 0.03, robustEV: 0.04, distributionCoverage: 0.97, numericalQA: { passed: false }, pairAudit: { passed: false, failures: ['mirror'] } });
assert.equal(broken.status, 'ERROR');
assert.ok(broken.errors.length >= 4);

const game = auditModelGame([
  { market: '全場大小', pick: '大9平', weightedEV: 0.06, robustEV: 0.03, distributionCoverage: 1, numericalQA: { passed: true }, pairAudit: { passed: true } },
  { market: '全場大小', pick: '小9平', weightedEV: -0.08, robustEV: -0.12, distributionCoverage: 1, evCalibration: { rawScenarioSpread: 0.04 }, numericalQA: { passed: true }, pairAudit: { passed: true } },
]);
assert.equal(game.directions.length, 2);
assert.equal(game.diagnosticOnly, true);

console.log('model-qa-v2-test: PASS');
