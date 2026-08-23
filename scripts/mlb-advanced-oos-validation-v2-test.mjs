import assert from 'node:assert/strict';
import { buildAdvancedOosValidationV2, validateAdvancedPitRowV2 } from '../lib/mlb-advanced-oos-validation-v2.js';

const rows = [];
for (let year = 2021; year <= 2025; year += 1) {
  for (let index = 0; index < 220; index += 1) {
    const actualAway = (index * 7 + year) % 9;
    const actualHome = (index * 11 + year) % 10;
    const month = String(4 + (index % 5)).padStart(2, '0');
    const day = String(1 + (index % 27)).padStart(2, '0');
    rows.push({
      observationId: `${year}-${index}`,
      gameStart: `${year}-${month}-${day}T23:00:00.000Z`,
      coefficientTrainedThrough: year - 1,
      featureObservedAts: { fielding: `${year}-${month}-${day}T18:00:00.000Z` },
      actualAway, actualHome,
      baselineAway: actualAway + 0.8,
      baselineHome: actualHome + 0.8,
      candidateAway: actualAway + 0.3,
      candidateHome: actualHome + 0.3,
    });
  }
}
const leaked = { ...rows[0], featureObservedAts: { fielding: rows[0].gameStart } };
assert.equal(validateAdvancedPitRowV2(leaked).ok, false);
const result = buildAdvancedOosValidationV2(rows);
assert.equal(result.status, 'OOS_DIAGNOSTIC_COMPLETE_REQUIRES_REVIEW');
assert.equal(result.eligibleForManualPromotion, true);
assert.equal(result.automaticActivation, false);
assert.ok(result.folds.every(fold => fold.metrics.poissonLossDelta < 0));
assert.ok(result.folds.every(fold => fold.metrics.poissonLossDeltaUpper95 < 0));
assert.ok(result.folds.every(fold => fold.metrics.calibrationErrorDelta < 0));
assert.equal(buildAdvancedOosValidationV2(rows.slice(0, 100)).status, 'OOS_SAMPLE_INSUFFICIENT');
console.log('mlb-advanced-oos-validation-v2-test: PASS');
