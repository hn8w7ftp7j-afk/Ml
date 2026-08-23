import assert from 'node:assert/strict';
import { buildAdvancedPromotionPolicyV109 } from '../lib/mlb-advanced-promotion-gate-v109.js';
import { sha256 } from '../lib/snapshot-v9.js';

const pass = () => ({ folds: [2022, 2023, 2024, 2025].map(validationSeason => ({
  validationSeason,
  sufficient: true,
  metrics: { poissonLossDeltaUpper95: -0.001, rmseDelta: -0.01, calibrationErrorDelta: -0.001 },
})) });
const artifact = {
  featureFamilyOos: {
    fielding: pass(), injury: pass(), pitchMatchup: pass(), catcherUmpireZone: pass(), windOrientation: pass(),
  },
  featurePromotionInputs: {
    fielding: { learnedBlendWeight: 0.25, absoluteRunDeltaP99: 0.12 },
    injury: { learnedBlendWeight: 0.20, absoluteRunDeltaP99: 0.10, officialImmutableIl: false },
    pitchMatchup: { learnedBlendWeight: 0.30, absoluteRunDeltaP99: 0.13 },
    catcherFraming: { learnedBlendWeight: 0.25, absoluteRunDeltaP99: 0.08 },
    umpireZone: { learnedBlendWeight: 0.20, absoluteRunDeltaP99: 0.06, abs2026SeparatelyValidated: false },
    directionalWind: { learnedBlendWeight: 0.30, absoluteRunDeltaP99: 0.09 },
  },
};
const unapproved = buildAdvancedPromotionPolicyV109(artifact);
assert.equal(unapproved.fielding.promoted, false);
const policy = buildAdvancedPromotionPolicyV109(artifact, { approved: true, artifactHash: sha256(artifact) });
assert.equal(policy.fielding.promoted, true);
assert.equal(policy.pitchMatchup.promoted, true);
assert.equal(policy.directionalWind.promoted, true);
assert.equal(policy.injury.promoted, false, 'injury proxy cannot be promoted without immutable official IL');
assert.equal(policy.umpireZone.promoted, false, '2026 ABS umpire effect requires a separate regime validation');
assert.ok(policy.__meta.maxAbsoluteRunDeltaPerTeam <= 0.30);

console.log('Independent advanced promotion gate v10.9 PASS');
