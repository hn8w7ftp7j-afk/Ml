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
const leakedCheck = validatePitObservation(leaked);
assert.equal(leakedCheck.ok, false);
assert.ok(leakedCheck.errors.includes('FEATURE_FROM_FUTURE:lineup'));

const result = buildOosCalibration(rows, { minimumTrainRows: 200, minimumValidationRows: 100 });
assert.equal(result.ok, true);
assert.deepEqual(result.artifact.folds.map(fold => fold.validationSeason), [2022, 2023, 2024, 2025, 2026]);
assert.ok(result.artifact.folds.every(fold => fold.trainedThrough < fold.validationSeason));
assert.ok(result.artifact.diagnostics.timeBlocks >= 20);
assert.ok(result.artifact.diagnostics.blockCoverage >= 0.85);

const high = applyOosCalibration(result.artifact, 0.20);
const low = applyOosCalibration(result.artifact, -0.10);
assert.equal(high.ok, true);
assert.ok(high.calibratedW < 0.10, 'historical OOS evidence should shrink an overconfident +20% raw EV');
assert.ok(high.calibratedW >= low.calibratedW, 'isotonic calibration must remain monotonic');
assert.ok(high.robustR <= high.calibratedW, 'robust R must not exceed calibrated W');

const tampered = { ...result.artifact, robustAdjustment: 0.5 };
assert.equal(applyOosCalibration(tampered, 0.2).ok, false, 'artifact tampering must fail closed');
assert.equal(buildOosCalibration(rows.slice(0, 100)).status, 'OOS_SAMPLE_INSUFFICIENT');
console.log('pit-oos-calibration-test: PASS');
