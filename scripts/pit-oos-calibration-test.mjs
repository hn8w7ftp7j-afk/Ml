import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyOosCalibration, buildOosCalibration, PIT_SCHEMA_VERSION, validatePitObservation } from '../lib/pit-oos-calibration-v106.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = [];
for (let year = 2021; year <= 2026; year += 1) {
  for (let index = 0; index < 240; index += 1) {
    const month = String(3 + (index % 7)).padStart(2, '0');
    const day = String(1 + (index % 27)).padStart(2, '0');
    const raw = -0.12 + (index % 49) * 0.005;
    // Deliberately overconfident model: long-run realizable return is only 25% of raw EV.
    const signal = raw * 0.25;
    const noise = (((index * 37 + year * 11) % 101) / 100 - 0.5) * 0.7;
    const start = `${year}-${month}-${day}T23:00:00.000Z`;
    rows.push({
      schemaVersion: PIT_SCHEMA_VERSION, observationId: `${year}-${index}`, league: 'MLB', gameId: `${year}${index}`,
      gameStart: start, snapshotAsOf: `${year}-${month}-${day}T20:00:00.000Z`, modelAsOf: `${year}-${month}-${day}T19:59:00.000Z`,
      settledAt: `${year}-${month}-${day}T23:59:00.000Z`, marketFamily: index % 2 ? 'FULL_TOTAL' : 'F5_TOTAL', contractType: 'TAI888_TOTAL',
      rawWeightedEv: raw, realizedNetReturn: Math.max(-1, Math.min(0.95, signal + noise)), water: 0.94,
      sourcePayloadHash: digest(`source-${year}-${index}`), modelInputHash: digest(`model-${year}-${index}`),
      featureObservedAts: { lineup: `${year}-${month}-${day}T19:30:00.000Z` },
    });
  }
}

const leaked = { ...rows[0], observationId: 'leaked', featureObservedAts: { lineup: rows[0].settledAt } };
for (const invalid of [null, undefined, '', '   ', false, true, {}, [], [0], NaN, Infinity]) {
  for (const field of ['rawWeightedEv', 'realizedNetReturn']) {
    assert.equal(validatePitObservation({ ...rows[0], [field]: invalid }).ok, false, `${field} must reject missing and nonnumeric values`);
  }
}
for (const zero of [0, '0']) assert.equal(validatePitObservation({ ...rows[0], rawWeightedEv: zero, realizedNetReturn: zero }).ok, true, 'genuine zero remains valid');
const leakedCheck = validatePitObservation(leaked);
assert.equal(leakedCheck.ok, false);
assert.ok(leakedCheck.errors.includes('FEATURE_FROM_FUTURE:lineup'));

const result = buildOosCalibration(rows, { minimumTrainRows: 200, minimumValidationRows: 100 });
assert.equal(result.ok, true);
assert.deepEqual(result.artifact.folds.map(fold => fold.validationSeason), [2022, 2023, 2024, 2025, 2026]);
assert.ok(result.artifact.folds.every(fold => fold.trainedThrough < fold.trainingCutoff));
assert.equal(result.artifact.trainedThrough, rows.map(row => row.settledAt).sort().at(-1));
assert.ok(result.artifact.diagnostics.timeBlocks >= 20);
assert.ok(result.artifact.diagnostics.blockCoverage >= 0.85);

const high = applyOosCalibration(result.artifact, 0.20);
const low = applyOosCalibration(result.artifact, -0.10);
assert.equal(high.ok, true);
assert.ok(high.calibratedW < 0.10, 'historical OOS evidence should shrink an overconfident +20% raw EV');
assert.ok(high.calibratedW >= low.calibratedW, 'isotonic calibration must remain monotonic');
assert.ok(high.robustR <= high.calibratedW, 'robust R must not exceed calibrated W');
for (const invalid of [null, '', ' ', false, true, {}, []]) assert.equal(applyOosCalibration(result.artifact, invalid).ok, false);

const tampered = { ...result.artifact, robustAdjustment: 0.5 };
assert.equal(applyOosCalibration(tampered, 0.2).ok, false, 'artifact tampering must fail closed');
const legacyCore = { ...Object.fromEntries(Object.entries(result.artifact).filter(([key]) => key !== 'artifactHash')), calibrationVersion: 'pit-oos-isotonic-block-bootstrap-v1' };
const legacyArtifact = { ...legacyCore, artifactHash: digest(JSON.stringify(legacyCore)) };
assert.equal(applyOosCalibration(legacyArtifact, 0.2).ok, false, 'a valid hash cannot promote an artifact created before result-availability cutoff validation');
assert.equal(buildOosCalibration(rows.slice(0, 100)).status, 'OOS_SAMPLE_INSUFFICIENT');

const chronologicalRows = rows.map(row => ({ ...row }));
chronologicalRows[0].settledAt = '2023-01-01T00:00:00.000Z';
chronologicalRows[1].settledAt = '2021-12-31T20:00:00.000Z';
chronologicalRows[2].settledAt = '2021-12-31T18:00:00.000Z';
chronologicalRows[240] = {
  ...chronologicalRows[240], modelAsOf: '2021-12-31T18:00:00.000Z',
  snapshotAsOf: '2021-12-31T18:01:00.000Z', featureObservedAts: { lineup: '2021-12-31T17:00:00.000Z' },
};
chronologicalRows[241].settledAt = '2024-09-01T00:00:00.000Z';
const chronological = buildOosCalibration(chronologicalRows, { minimumTrainRows: 200, minimumValidationRows: 100 });
assert.equal(chronological.ok, true);
const firstFold = chronological.artifact.folds.find(fold => fold.validationSeason === 2022);
assert.equal(firstFold.trainRows, 237, 'exclude late, after-model, and exactly-at-cutoff settlements');
assert.equal(firstFold.trainingCutoff, chronologicalRows[240].modelAsOf);
assert.ok(chronological.predictions.filter(row => row.validationSeason === 2022).every(row => row.robustR === null), 'first OOS season cannot reuse future residuals');
const changedFuture = buildOosCalibration(chronologicalRows.map((row, index) => index === 0 || index === 241 ? { ...row, realizedNetReturn: 0.9 } : row), { minimumTrainRows: 200, minimumValidationRows: 100 });
for (const original of chronological.predictions.filter(row => row.validationSeason <= 2023)) {
  const changed = changedFuture.predictions.find(row => row.observationId === original.observationId);
  assert.equal(changed.calibratedW, original.calibratedW, 'future result changes cannot affect earlier annual OOS W');
  assert.equal(changed.robustR, original.robustR, 'future result changes cannot affect earlier annual OOS R');
}
assert.equal(chronological.artifact.folds.find(fold => fold.validationSeason === 2023).trainRows, 478, 'result at the boundary is unavailable until a later fold');
console.log('pit-oos-calibration-test: PASS');
