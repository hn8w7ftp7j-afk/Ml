import { sha256 } from './snapshot-v9.js';

export const MLB_ADVANCED_PROMOTION_GATE_V109_VERSION = 'MLB-ADVANCED-INDEPENDENT-PROMOTION-GATE-2026-08-v10.9.0';

const families = ['fielding', 'injury', 'pitchMatchup', 'catcherFraming', 'umpireZone', 'directionalWind'];
const sourceKeys = {
  fielding: 'fielding',
  injury: 'injury',
  pitchMatchup: 'pitchMatchup',
  catcherFraming: 'catcherUmpireZone',
  umpireZone: 'catcherUmpireZone',
  directionalWind: 'windOrientation',
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = value => value == null || (typeof value === 'string' && !value.trim()) ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function foldsPass(report) {
  const folds = Array.isArray(report?.folds) ? report.folds : [];
  return folds.length >= 4 && folds.every(fold => fold?.sufficient === true
    && finite(fold?.metrics?.poissonLossDeltaUpper95) < 0
    && finite(fold?.metrics?.rmseDelta) <= 0
    && finite(fold?.metrics?.calibrationErrorDelta) <= 0);
}

export function buildAdvancedPromotionPolicyV109(validationArtifact = {}, approval = {}) {
  const artifactHash = sha256(validationArtifact);
  const releaseApproved = approval?.approved === true && approval?.artifactHash === artifactHash;
  const decisions = {};
  let maximumImpact = 0;
  for (const family of families) {
    const report = validationArtifact?.featureFamilyOos?.[sourceKeys[family]];
    const allFoldsPass = foldsPass(report);
    const hasLearnedBlend = finite(validationArtifact?.featurePromotionInputs?.[family]?.learnedBlendWeight) != null;
    const hasImpactDistribution = finite(validationArtifact?.featurePromotionInputs?.[family]?.absoluteRunDeltaP99) != null;
    const proxyBlocked = family === 'injury' && validationArtifact?.featurePromotionInputs?.injury?.officialImmutableIl !== true;
    const absBlocked = family === 'umpireZone' && validationArtifact?.featurePromotionInputs?.umpireZone?.abs2026SeparatelyValidated !== true;
    const promoted = releaseApproved && allFoldsPass && hasLearnedBlend && hasImpactDistribution && !proxyBlocked && !absBlocked;
    const blendWeight = promoted ? clamp(finite(validationArtifact.featurePromotionInputs[family].learnedBlendWeight), 0.05, 1) : 0;
    const impact = promoted ? clamp(finite(validationArtifact.featurePromotionInputs[family].absoluteRunDeltaP99), 0.05, 0.30) : 0;
    maximumImpact += impact;
    decisions[family] = Object.freeze({
      promoted,
      blendWeight,
      decision: promoted ? 'PROMOTED_AFTER_LOCKED_REVIEW' : proxyBlocked ? 'DIAGNOSTIC_PROXY_ONLY' : absBlocked ? 'ABS_2026_SEPARATE_VALIDATION_REQUIRED' : 'DIAGNOSTIC_ONLY',
      reason: promoted ? 'ALL_FOLDS_AND_IMPACT_GATES_PASSED' : !releaseApproved ? 'RELEASE_ARTIFACT_NOT_APPROVED' : !allFoldsPass ? 'OOS_FOLD_CRITERIA_NOT_MET' : !hasLearnedBlend || !hasImpactDistribution ? 'PROMOTION_COEFFICIENT_OR_IMPACT_BUDGET_MISSING' : proxyBlocked ? 'OFFICIAL_IMMUTABLE_IL_REQUIRED' : 'ABS_2026_SEPARATE_VALIDATION_REQUIRED',
    });
  }
  return Object.freeze({
    __meta: Object.freeze({
      version: MLB_ADVANCED_PROMOTION_GATE_V109_VERSION,
      validationArtifactHash: artifactHash,
      releaseApproved,
      automaticActivation: false,
      maxAbsoluteRunDeltaPerTeam: clamp(maximumImpact || 0.30, 0.05, 0.30),
    }),
    ...decisions,
  });
}
