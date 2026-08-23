import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PIT_PREDICTION_SCHEMA_V109,
  applyContinuousCalibrationV109,
  buildContinuousOosCalibrationV109,
  validatePitPredictionV109,
} from '../lib/pit-continuous-calibration-v109.js';

const h = value => crypto.createHash('sha256').update(value).digest('hex');
const row = (index, month, realizedNetReturn) => ({
  schemaVersion: PIT_PREDICTION_SCHEMA_V109,
  observationId: `o-${month}-${index}`,
  league: 'MLB',
  gameId: `g-${month}-${Math.floor(index / 2)}`,
  gameStart: `2026-${month}-${String(index % 20 + 1).padStart(2, '0')}T23:00:00.000Z`,
  lineAsOf: `2026-${month}-${String(index % 20 + 1).padStart(2, '0')}T18:00:00.000Z`,
  modelAsOf: `2026-${month}-${String(index % 20 + 1).padStart(2, '0')}T18:01:00.000Z`,
  decisionAsOf: `2026-${month}-${String(index % 20 + 1).padStart(2, '0')}T18:02:00.000Z`,
  settledAt: `2026-${month}-${String(index % 20 + 2).padStart(2, '0')}T05:00:00.000Z`,
  marketFamily: index % 2 ? 'FULL_TOTAL' : 'FULL_SIDE',
  contractType: index % 2 ? 'TOTAL_OVER' : 'SIDE_RECEIVING',
  rawWeightedEv: 0.01 + (index % 10) / 1000,
  rawRobustEv: 0.005,
  realizedNetReturn,
  water: 0.95,
  sourcePayloadHash: h(`s-${month}-${index}`),
  modelInputHash: h(`m-${month}-${index}`),
  featureObservedAts: { lineup: `2026-${month}-${String(index % 20 + 1).padStart(2, '0')}T17:00:00.000Z` },
  modelVersion: 'test-model',
  settlementRuleVersion: 'test-settlement',
});

assert.equal(validatePitPredictionV109(row(1, '01', 0.95)).ok, true);
const future = row(1, '01', 0.95);
future.featureObservedAts.lineup = future.gameStart;
assert.match(validatePitPredictionV109(future).errors.join('|'), /FEATURE_FROM_FUTURE/);

const rows = [];
for (const month of ['01', '02', '03', '04', '05', '06']) {
  for (let index = 0; index < 80; index += 1) rows.push(row(index, month, index % 4 === 0 ? -0.985 : 0.965));
}
const result = buildContinuousOosCalibrationV109(rows, { minimumTrainRows: 160, minimumValidationRows: 80, minimumUniqueGames: 80, minimumPositiveCandidates: 20 });
assert.equal(result.ok, true);
assert.ok(result.artifact.sampleSize === rows.length);
assert.ok(result.artifact.observedMonths === 6);
assert.ok(result.artifact.folds.length >= 3);
const applied = applyContinuousCalibrationV109(result.artifact, rows.at(-1));
assert.equal(applied.ok, true);
assert.ok(Number.isFinite(applied.calibratedW));
const tampered = { ...result.artifact, robustAdjustment: 99 };
assert.equal(applyContinuousCalibrationV109(tampered, rows.at(-1)).ok, false);

const early = buildContinuousOosCalibrationV109(rows.slice(0, 100), { minimumTrainRows: 160, minimumValidationRows: 80 });
assert.equal(early.status, 'FORWARD_SAMPLE_INSUFFICIENT');

console.log('Continuous cross-season PIT calibration v10.9 PASS');
