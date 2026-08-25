import { sha256 } from './snapshot-v9.js';

export const MLB_ADVANCED_PROMOTION_GATE_V109_VERSION = 'MLB-ADVANCED-INDEPENDENT-PROMOTION-GATE-2026-08-v11.0.0';

const families = ['fielding', 'injury', 'pitchMatchup', 'catcherFraming', 'umpireZone', 'directionalWind'];
const sourceKeys = {
  fielding: 'fielding',
  injury: 'injury',
  pitchMatchup: 'pitchMatchup',
  // Catcher framing and the umpire residual have different owners and error
  // regimes.  A joint exploratory report may be useful diagnostically, but it
  // must never promote both production coefficients at once.
  catcherFraming: 'catcherFraming',
  umpireZone: 'umpireZone',
  directionalWind: 'windOrientation',
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = value => value == null || (typeof value === 'string' && !value.trim()) ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function foldsPass(report) {
  const folds = Array.isArray(report?.folds) ? report.folds : [];
  const distinctSeasons = new Set(folds.map(fold => Number(fold?.validationSeason)).filter(Number.isFinite));
  return folds.length >= 4 && distinctSeasons.size >= 4 && folds.every(fold => {
    const poissonUpper = finite(fold?.metrics?.poissonLossDeltaUpper95);
    const rmseDelta = finite(fold?.metrics?.rmseDelta);
    const calibrationDelta = finite(fold?.metrics?.calibrationErrorDelta);
    return fold?.sufficient === true
      && poissonUpper != null && poissonUpper < 0
      && rmseDelta != null && rmseDelta <= 0
      && calibrationDelta != null && calibrationDelta <= 0;
  });
}

function abs2026RegimePass(validationArtifact) {
  const row = validationArtifact?.regimeValidation?.umpireZone2026AbsChallenge;
  return row?.status === 'PASSED'
    && row?.pitSafe === true
    && row?.sampleSufficient === true
    && row?.regime === 'MLB_2026_ABS_CHALLENGE';
}

export function buildAdvancedPromotionPolicyV109(validationArtifact = {}, approval = {}) {
  const artifactHash = sha256(validationArtifact);
  const releaseApproved = approval?.approved === true && approval?.artifactHash === artifactHash;
  const decisions = {};
  let maximumImpact = 0;
  for (const family of families) {
    const report = validationArtifact?.featureFamilyOos?.[sourceKeys[family]];
    const allFoldsPass = foldsPass(report);
    const learnedBlendWeight = finite(validationArtifact?.featurePromotionInputs?.[family]?.learnedBlendWeight);
    const absoluteRunDeltaP99 = finite(validationArtifact?.featurePromotionInputs?.[family]?.absoluteRunDeltaP99);
    const hasLearnedBlend = learnedBlendWeight != null && learnedBlendWeight > 0 && learnedBlendWeight <= 1;
    const hasImpactDistribution = absoluteRunDeltaP99 != null && absoluteRunDeltaP99 > 0 && absoluteRunDeltaP99 <= 0.30;
    const proxyBlocked = family === 'injury' && validationArtifact?.featurePromotionInputs?.injury?.officialImmutableIl !== true;
    const independentReportMissing = !report && (family === 'catcherFraming' || family === 'umpireZone');
    const absBlocked = family === 'umpireZone' && (
      validationArtifact?.featurePromotionInputs?.umpireZone?.abs2026SeparatelyValidated !== true
      || !abs2026RegimePass(validationArtifact)
    );
    const promoted = releaseApproved && allFoldsPass && hasLearnedBlend && hasImpactDistribution && !proxyBlocked && !absBlocked;
    const blendWeight = promoted ? clamp(learnedBlendWeight, 0.05, 1) : 0;
    const impact = promoted ? clamp(absoluteRunDeltaP99, 0.05, 0.30) : 0;
    maximumImpact += impact;
    decisions[family] = Object.freeze({
      promoted,
      blendWeight,
      oosReportKey: sourceKeys[family],
      decision: promoted ? 'PROMOTED_AFTER_LOCKED_REVIEW' : independentReportMissing ? 'INDEPENDENT_OOS_REPORT_REQUIRED' : proxyBlocked ? 'DIAGNOSTIC_PROXY_ONLY' : absBlocked ? 'ABS_2026_SEPARATE_VALIDATION_REQUIRED' : 'DIAGNOSTIC_ONLY',
      reason: promoted
        ? 'ALL_FOLDS_AND_IMPACT_GATES_PASSED'
        : !releaseApproved ? 'RELEASE_ARTIFACT_NOT_APPROVED'
          : independentReportMissing ? 'INDEPENDENT_OOS_REPORT_REQUIRED'
            : !allFoldsPass ? 'OOS_FOLD_CRITERIA_NOT_MET'
              : !hasLearnedBlend || !hasImpactDistribution ? 'PROMOTION_COEFFICIENT_OR_IMPACT_BUDGET_MISSING'
                : proxyBlocked ? 'OFFICIAL_IMMUTABLE_IL_REQUIRED'
                  : 'ABS_2026_SEPARATE_VALIDATION_REQUIRED',
    });
  }
  return Object.freeze({
    __meta: Object.freeze({
      version: MLB_ADVANCED_PROMOTION_GATE_V109_VERSION,
      validationArtifactHash: artifactHash,
      releaseApproved,
      policyAuthority: 'SERVER_RELEASE_MANIFEST',
      automaticActivation: false,
      maxAbsoluteRunDeltaPerTeam: clamp(maximumImpact || 0.30, 0.05, 0.30),
    }),
    ...decisions,
  });
}
