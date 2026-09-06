import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  PIT_PREDICTION_SCHEMA_V109,
  applyContinuousCalibrationV109,
  buildContinuousOosCalibrationV109,
  validatePitObservationV109,
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
for (const missing of [null, undefined, '', '   ', false, true, {}, [], [0], NaN, Infinity]) {
  for (const field of ['rawWeightedEv', 'rawRobustEv']) {
    assert.equal(validatePitPredictionV109({ ...row(1, '01', 0.95), [field]: missing }).ok, false, `${field} must reject ${String(missing)}`);
  }
  assert.equal(validatePitObservationV109({ ...row(1, '01', 0.95), realizedNetReturn: missing }).ok, false, 'missing result must not become a push');
}
for (const zero of [0, '0']) {
  const checked = validatePitObservationV109({ ...row(1, '01', 0.95), rawWeightedEv: zero, rawRobustEv: zero, realizedNetReturn: zero });
  assert.equal(checked.ok, true, 'genuine zero EV and pushes remain valid');
  assert.equal(checked.value.realizedNetReturn, 0);
}
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
for (const invalid of [null, '', ' ', false, true, {}, []]) assert.equal(applyContinuousCalibrationV109(result.artifact, { rawWeightedEv: invalid }).ok, false);
const tampered = { ...result.artifact, robustAdjustment: 99 };
assert.equal(applyContinuousCalibrationV109(tampered, rows.at(-1)).ok, false);
const legacyCore = { ...Object.fromEntries(Object.entries(result.artifact).filter(([key]) => key !== 'artifactHash')), calibrationVersion: 'baseball-continuous-hierarchical-isotonic-v2' };
const legacyArtifact = { ...legacyCore, artifactHash: h(JSON.stringify(legacyCore)) };
assert.equal(applyContinuousCalibrationV109(legacyArtifact, rows.at(-1)).ok, false, 'old cutoff logic artifacts stay invalid even with a matching content hash');

const early = buildContinuousOosCalibrationV109(rows.slice(0, 100), { minimumTrainRows: 160, minimumValidationRows: 80 });
assert.equal(early.status, 'FORWARD_SAMPLE_INSUFFICIENT');

const baseline = { ...row(1, '01', 0.2), rawWeightedEv: 0.01 };
const lateJanuary = {
  ...row(2, '01', -0.9), observationId: 'late-january', rawWeightedEv: 0.01,
  gameStart: '2026-01-31T23:00:00.000Z', settledAt: '2026-03-01T05:00:00.000Z',
};
const afterModel = {
  ...row(3, '01', -0.8), observationId: 'settled-after-model', rawWeightedEv: 0.01,
  gameStart: '2026-01-30T23:00:00.000Z', settledAt: '2026-01-31T20:00:00.000Z',
};
const february = {
  ...row(0, '02', 0.1), rawWeightedEv: 0.01,
  modelAsOf: '2026-01-31T18:01:00.000Z', lineAsOf: '2026-01-31T18:00:00.000Z',
  decisionAsOf: '2026-01-31T18:02:00.000Z', featureObservedAts: { lineup: '2026-01-31T17:00:00.000Z' },
};
const lateFebruary = { ...row(1, '02', -0.7), observationId: 'late-february', rawWeightedEv: 0.01, settledAt: '2026-05-01T05:00:00.000Z' };
const chronologicalRows = [baseline, lateJanuary, afterModel, february, lateFebruary, { ...row(0, '03', 0.3), rawWeightedEv: 0.01 }, { ...row(0, '04', 0.4), rawWeightedEv: 0.01 }];
const chronologicalOptions = { minimumTrainRows: 1, minimumValidationRows: 1, minimumRowsPerFold: 1 };
const chronological = buildContinuousOosCalibrationV109(chronologicalRows, chronologicalOptions);
assert.equal(chronological.ok, true);
const februaryFold = chronological.artifact.folds.find(fold => fold.validationMonth === '2026-02');
assert.equal(februaryFold.trainRows, 1, 'exclude results arriving after model time, even before the calendar fold boundary');
assert.equal(februaryFold.trainingCutoff, february.modelAsOf);
assert.equal(februaryFold.trainedThrough, baseline.settledAt, 'trainedThrough records result availability, not a game date');
assert.equal(chronological.predictions.find(item => item.observationId === february.observationId).robustR, null, 'first OOS fold has no earlier residual evidence');
const changedFuture = buildContinuousOosCalibrationV109(chronologicalRows.map(item => ['late-january', 'late-february'].includes(item.observationId) ? { ...item, realizedNetReturn: 0.9 } : item), chronologicalOptions);
for (const original of chronological.predictions.filter(item => item.validationMonth <= '2026-03')) {
  const changed = changedFuture.predictions.find(item => item.observationId === original.observationId);
  assert.equal(changed.calibratedW, original.calibratedW, 'future settlements cannot change historical OOS W');
  assert.equal(changed.robustR, original.robustR, 'future settlements cannot change historical OOS R');
}
assert.notEqual(changedFuture.predictions.find(item => item.validationMonth === '2026-04').calibratedW, chronological.predictions.find(item => item.validationMonth === '2026-04').calibratedW, 'late January result enters a later fold once available');
assert.equal(chronological.artifact.trainedThrough, lateFebruary.settledAt);
assert.ok(chronological.artifact.folds.every(fold => fold.trainedThrough < fold.trainingCutoff));
const equalCutoff = buildContinuousOosCalibrationV109([...chronologicalRows, { ...afterModel, observationId: 'exact-cutoff', settledAt: february.modelAsOf }], chronologicalOptions);
assert.equal(equalCutoff.artifact.folds.find(fold => fold.validationMonth === '2026-02').trainRows, 1, 'training data must be known strictly before the cutoff');

console.log('Continuous cross-season PIT calibration v10.9 PASS');
