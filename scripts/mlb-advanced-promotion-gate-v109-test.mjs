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
assert.equal(policy.catcherFraming.promoted, false, 'joint catcher/umpire diagnostics cannot promote catcher framing without an independent OOS report');
assert.equal(policy.catcherFraming.reason, 'INDEPENDENT_OOS_REPORT_REQUIRED');
assert.ok(policy.__meta.maxAbsoluteRunDeltaPerTeam <= 0.30);

const absFlagWithoutRegimeEvidence = structuredClone(artifact);
absFlagWithoutRegimeEvidence.featureFamilyOos.umpireZone = pass();
absFlagWithoutRegimeEvidence.featurePromotionInputs.umpireZone.abs2026SeparatelyValidated = true;
const absFlagOnlyPolicy = buildAdvancedPromotionPolicyV109(absFlagWithoutRegimeEvidence, { approved: true, artifactHash: sha256(absFlagWithoutRegimeEvidence) });
assert.equal(absFlagOnlyPolicy.umpireZone.promoted, false, 'a boolean ABS flag without a separate PIT-safe regime artifact is insufficient');
assert.equal(absFlagOnlyPolicy.umpireZone.reason, 'ABS_2026_SEPARATE_VALIDATION_REQUIRED');

const independentlyValidated = structuredClone(artifact);
independentlyValidated.featureFamilyOos.catcherFraming = pass();
independentlyValidated.featureFamilyOos.umpireZone = pass();
independentlyValidated.featurePromotionInputs.injury.officialImmutableIl = true;
independentlyValidated.featurePromotionInputs.umpireZone.abs2026SeparatelyValidated = true;
independentlyValidated.regimeValidation = {
  umpireZone2026AbsChallenge: { status: 'PASSED', pitSafe: true, sampleSufficient: true, regime: 'MLB_2026_ABS_CHALLENGE' },
};
const independentPolicy = buildAdvancedPromotionPolicyV109(independentlyValidated, { approved: true, artifactHash: sha256(independentlyValidated) });
assert.equal(independentPolicy.catcherFraming.promoted, true);
assert.equal(independentPolicy.umpireZone.promoted, true);
assert.equal(independentPolicy.injury.promoted, true);

const invalidCoefficient = structuredClone(independentlyValidated);
invalidCoefficient.featurePromotionInputs.fielding.learnedBlendWeight = 0;
const invalidCoefficientPolicy = buildAdvancedPromotionPolicyV109(invalidCoefficient, { approved: true, artifactHash: sha256(invalidCoefficient) });
assert.equal(invalidCoefficientPolicy.fielding.promoted, false, 'zero/invalid learned coefficients must not be clamped upward into activation');

const incompleteMetrics = structuredClone(independentlyValidated);
delete incompleteMetrics.featureFamilyOos.pitchMatchup.folds[0].metrics.rmseDelta;
const incompleteMetricsPolicy = buildAdvancedPromotionPolicyV109(incompleteMetrics, { approved: true, artifactHash: sha256(incompleteMetrics) });
assert.equal(incompleteMetricsPolicy.pitchMatchup.promoted, false, 'missing fold metrics must fail closed');

console.log('Independent advanced promotion gate v10.9 PASS');
