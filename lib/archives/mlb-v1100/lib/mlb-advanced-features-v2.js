import { isMlbAdvancedFeaturePromotedV2 } from './mlb-advanced-promotion-policy-v2.js';
import { resolveServerOwnedMlbAdvancedPolicyV110 } from './mlb-advanced-runtime-policy-v110.js';

export const MLB_ADVANCED_FEATURES_V2_VERSION = 'MLB-ADVANCED-FEATURES-PIT-2026-08-v2.2.0';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const status = value => {
  const normalized = String(value || '').toUpperCase();
  return ['CONFIRMED', 'PROJECTED', 'MISSING'].includes(normalized) ? normalized : 'MISSING';
};
const statusWeight = value => value === 'CONFIRMED' ? 1 : value === 'PROJECTED' ? 0.62 : 0;
const reliability = (sample, target, maximum = 0.92) => {
  const size = Math.max(0, finite(sample, 0));
  return clamp(size / (size + Math.max(1, target)), 0, maximum);
};
const logFactorFromRuns = (runs, baselineRuns, weight) => {
  const baseline = clamp(finite(baselineRuns, 4.4), 3.2, 5.8);
  return Math.exp(clamp(finite(runs, 0) * clamp(weight, 0, 1) / baseline, -0.12, 0.12));
};

function observedBeforeStart(block, gameStart) {
  const observedAt = Date.parse(block?.observedAt || '');
  const start = Date.parse(gameStart || '');
  return Number.isFinite(observedAt) && Number.isFinite(start) && observedAt < start;
}

function featureState(block, gameStart, family, promotionPolicy) {
  const featureStatus = status(block?.status);
  if (featureStatus === 'MISSING') return { usable: false, status: featureStatus, reason: 'MISSING' };
  if (!observedBeforeStart(block, gameStart)) return { usable: false, status: 'MISSING', reason: 'NOT_POINT_IN_TIME' };
  if (!isMlbAdvancedFeaturePromotedV2(family, promotionPolicy)) return { usable: false, status: featureStatus, reason: 'OOS_VALIDATION_NOT_PROMOTED' };
  // Validation authority belongs to the immutable server policy.  Feature
  // payloads are observations and cannot self-promote by writing PASSED; once
  // a trusted policy promotes a family, an otherwise valid PIT observation is
  // allowed even when its diagnostic payload was created before promotion.
  return {
    usable: true,
    status: featureStatus,
    reason: '',
    blendWeight: clamp(finite(promotionPolicy?.[family]?.blendWeight, 1), 0, 1),
    payloadValidationStatus: String(block?.validationStatus || 'UNSPECIFIED'),
    validationAuthority: 'SERVER_OWNED_PROMOTION_POLICY',
  };
}

function defenseAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'fielding', promotionPolicy);
  if (!state.usable) return { factor: 1, runsPrevented: 0, state };
  const innings = Math.max(0, finite(block?.innings, 0));
  const gamesEquivalent = Math.max(1, finite(block?.gamesEquivalent, innings / 9));
  const totalFrv = finite(block?.fieldingRunValue, finite(block?.frv, 0));
  const framingIncluded = block?.includesCatcherFraming === true ? finite(block?.catcherFramingRuns, 0) : 0;
  const nonFramingFrv = totalFrv - framingIncluded;
  const sampleWeight = reliability(innings, 720) * statusWeight(state.status);
  const rawRunsPrevented = nonFramingFrv / gamesEquivalent * sampleWeight;
  const runsPrevented = rawRunsPrevented * state.blendWeight;
  return {
    factor: logFactorFromRuns(-runsPrevented, baselineRuns, 1),
    runsPrevented,
    state,
    audit: { totalFrv, framingRemoved: framingIncluded, innings, gamesEquivalent, sampleWeight, rawRunsPrevented, blendWeight: state.blendWeight },
  };
}

function framingAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'catcherFraming', promotionPolicy);
  if (!state.usable) return { factor: 1, runsPrevented: 0, state };
  const pitches = Math.max(0, finite(block?.pitches, 0));
  const gamesEquivalent = Math.max(1, finite(block?.gamesEquivalent, pitches / 145));
  const framingRuns = finite(block?.framingRuns, finite(block?.runValue, 0));
  const sampleWeight = reliability(pitches, 1200) * statusWeight(state.status);
  const rawRunsPrevented = framingRuns / gamesEquivalent * sampleWeight;
  const runsPrevented = rawRunsPrevented * state.blendWeight;
  return {
    factor: logFactorFromRuns(-runsPrevented, baselineRuns, 1),
    runsPrevented,
    state,
    audit: { framingRuns, pitches, gamesEquivalent, sampleWeight, rawRunsPrevented, blendWeight: state.blendWeight },
  };
}

function umpireAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'umpireZone', promotionPolicy);
  if (!state.usable) return { factor: 1, runDelta: 0, state };
  const takenPitches = Math.max(0, finite(block?.takenPitches, finite(block?.pitches, 0)));
  const sampleWeight = reliability(takenPitches, 1800) * statusWeight(state.status);
  // This must be catcher-neutral residual run value, not raw called-strike value.
  const residualRunsPerGame = finite(block?.catcherNeutralRunsPerGame, 0);
  const rawRunDelta = residualRunsPerGame * sampleWeight;
  const runDelta = rawRunDelta * state.blendWeight;
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { takenPitches, sampleWeight, rawRunDelta, blendWeight: state.blendWeight, requiresCatcherNeutralResidual: true },
  };
}

function injuryAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'injury', promotionPolicy);
  if (!state.usable) return { factor: 1, runsLost: 0, state };
  const absentShare = clamp(finite(block?.expectedAbsentShare, 0), 0, 1);
  const lineupAvailable = block?.lineupAlreadyModelsAbsence !== false && finite(block?.lineupCoverage, 0) > 0;
  const residualDelta = finite(block?.regressedValue?.fieldingRunsPerGame, 0)
    + finite(block?.regressedValue?.baserunningRunsPerGame, 0);
  const replacementDelta = lineupAvailable
    ? residualDelta
    : finite(block?.replacementRunDeltaPerGame, null);
  if (replacementDelta == null) return { factor: 1, runsLost: 0, state: { ...state, usable: false, reason: 'NO_REPLACEMENT_RUN_DELTA' } };
  const coverage = clamp(finite(block?.lineupCoverage, 0), 0, 1);
  const weight = statusWeight(state.status) * coverage;
  const rawRunsLost = Math.max(0, replacementDelta * absentShare * weight);
  const runsLost = rawRunsLost * state.blendWeight;
  return {
    factor: logFactorFromRuns(-runsLost, baselineRuns, 1),
    runsLost,
    state,
    audit: { absentShare, replacementDelta, coverage, weight, rawRunsLost, blendWeight: state.blendWeight, lineupAvailable, battingValueExcluded: lineupAvailable },
  };
}

function pitchMatchupAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'pitchMatchup', promotionPolicy);
  if (!state.usable) return { factor: 1, runDelta: 0, state };
  const pitches = Math.max(0, finite(block?.samplePitches, 0));
  const coverage = clamp(finite(block?.lineupCoverage, 0), 0, 1);
  const expectedPitches = clamp(finite(block?.expectedPitches, 95), 20, 165);
  const centeredRunValuePer100 = finite(block?.centeredRunValuePer100, null);
  if (centeredRunValuePer100 == null) return { factor: 1, runDelta: 0, state: { ...state, usable: false, reason: 'NO_LEAGUE_CENTERED_RUN_VALUE' } };
  const sampleWeight = reliability(pitches, 1800) * coverage * statusWeight(state.status);
  const rawRunDelta = centeredRunValuePer100 * expectedPitches / 100 * sampleWeight;
  const runDelta = rawRunDelta * state.blendWeight;
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { pitches, coverage, expectedPitches, centeredRunValuePer100, sampleWeight, rawRunDelta, blendWeight: state.blendWeight },
  };
}

function directionalWindAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'directionalWind', promotionPolicy);
  if (!state.usable) return { factor: 1, runDelta: 0, state };
  const coefficient = finite(block?.validatedRunsPerMphAlignment, null);
  const fieldBearing = finite(block?.fieldBearingDegrees, null);
  const windFrom = finite(block?.windFromDegrees, null);
  const windSpeed = finite(block?.windSpeedMph, null);
  if ([coefficient, fieldBearing, windFrom, windSpeed].some(value => value == null)) {
    return { factor: 1, runDelta: 0, state: { ...state, usable: false, reason: 'WIND_ORIENTATION_NOT_VALIDATED' } };
  }
  const roofOpenProbability = clamp(finite(block?.roofOpenProbability, 1), 0, 1);
  const windTo = (windFrom + 180) % 360;
  const alignment = Math.cos((windTo - fieldBearing) * Math.PI / 180);
  const parkBaselineAlignedWindMph = finite(block?.parkBaselineAlignedWindMph, null);
  if (parkBaselineAlignedWindMph == null) {
    return { factor: 1, runDelta: 0, state: { ...state, usable: false, reason: 'WIND_NOT_CENTERED_AGAINST_PARK_BASELINE' } };
  }
  const centeredAlignedWindMph = windSpeed * alignment - parkBaselineAlignedWindMph;
  const rawRunDelta = coefficient * centeredAlignedWindMph * roofOpenProbability * statusWeight(state.status);
  const runDelta = rawRunDelta * state.blendWeight;
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { coefficient, fieldBearing, windFrom, windTo, windSpeed, alignment, parkBaselineAlignedWindMph, centeredAlignedWindMph, roofOpenProbability, rawRunDelta, blendWeight: state.blendWeight },
  };
}

function sideAdjustment({ offense = {}, defense = {}, baselineRuns, gameStart, promotionPolicy }) {
  const injury = injuryAdjustment(offense.injuryRunValue, baselineRuns, gameStart, promotionPolicy);
  const pitchMatchup = pitchMatchupAdjustment(offense.pitchTypeMatchup, baselineRuns, gameStart, promotionPolicy);
  const fielding = defenseAdjustment(defense.fielding, baselineRuns, gameStart, promotionPolicy);
  const framing = framingAdjustment(defense.catcherFraming, baselineRuns, gameStart, promotionPolicy);
  const umpire = umpireAdjustment(defense.umpireZone, baselineRuns, gameStart, promotionPolicy);
  const offenseFactor = injury.factor * pitchMatchup.factor;
  const opponentPreventionFactor = fielding.factor * framing.factor * umpire.factor;
  const rawFactor = offenseFactor * opponentPreventionFactor;
  const maxRuns = clamp(finite(promotionPolicy?.__meta?.maxAbsoluteRunDeltaPerTeam, 0.30), 0.05, 0.60);
  const factor = Math.exp(clamp(Math.log(Math.max(1e-9, rawFactor)), -maxRuns / baselineRuns, maxRuns / baselineRuns));
  return {
    factor: clamp(factor, 0.86, 1.16),
    impactBudget: { rawFactor, maxAbsoluteRunDeltaPerTeam: maxRuns, capped: Math.abs(Math.log(Math.max(1e-9, rawFactor))) > maxRuns / baselineRuns },
    components: { injury, pitchMatchup, fielding, framing, umpire },
  };
}

function familyRuntimeStatus({ family, policy, awayComponent, homeComponent, policyProvenance }) {
  const promoted = isMlbAdvancedFeaturePromotedV2(family, policy);
  const appliedToAwayRunMean = awayComponent?.state?.usable === true;
  const appliedToHomeRunMean = homeComponent?.state?.usable === true;
  return {
    family,
    promoted,
    runtimeStatus: !promoted
      ? 'DIAGNOSTIC_NEUTRAL'
      : appliedToAwayRunMean || appliedToHomeRunMean ? 'PROMOTED_ACTIVE' : 'PROMOTED_INPUT_BLOCKED',
    decision: policy?.[family]?.decision || 'DIAGNOSTIC_ONLY',
    reason: policy?.[family]?.reason || 'OOS_VALIDATION_NOT_PROMOTED',
    blendWeight: promoted ? clamp(finite(policy?.[family]?.blendWeight, 0), 0, 1) : 0,
    oosReportKey: policy?.[family]?.oosReportKey || family,
    appliedToAwayRunMean,
    appliedToHomeRunMean,
    awayInputState: awayComponent?.state || null,
    homeInputState: homeComponent?.state || null,
    validationArtifactHash: policyProvenance?.validationArtifactHash || null,
  };
}

export function buildMlbAdvancedAdjustmentV2(context = {}, { serverOwnedPromotionPolicy = null } = {}) {
  const gameStart = context?.game?.gameDate || context?.game?.gameStart || '';
  const resolvedPolicy = resolveServerOwnedMlbAdvancedPolicyV110(serverOwnedPromotionPolicy, { gameStart, contextAsOf: context?.fetchedAt || context?.dataAsOf || '' });
  const promotionPolicy = resolvedPolicy.policy;
  const baselineRuns = finite(context?.league?.runsPerTeamGame, 4.4);
  const away = sideAdjustment({
    offense: context?.away?.advanced || {},
    defense: context?.home?.advanced || {},
    baselineRuns,
    gameStart,
    promotionPolicy,
  });
  const home = sideAdjustment({
    offense: context?.home?.advanced || {},
    defense: context?.away?.advanced || {},
    baselineRuns,
    gameStart,
    promotionPolicy,
  });
  const wind = directionalWindAdjustment(context?.advancedEnvironment?.directionalWind, baselineRuns, gameStart, promotionPolicy);
  const flags = [];
  for (const [side, result] of [['away', away], ['home', home]]) {
    for (const [name, component] of Object.entries(result.components)) {
      if (!component.state.usable) flags.push(`${side.toUpperCase()}_${name.toUpperCase()}_${component.state.reason}`);
    }
  }
  if (!wind.state.usable) flags.push(`ENVIRONMENT_WIND_${wind.state.reason}`);
  const maxRuns = clamp(finite(promotionPolicy?.__meta?.maxAbsoluteRunDeltaPerTeam, 0.30), 0.05, 0.60);
  const withWindBudget = side => Math.exp(clamp(Math.log(Math.max(1e-9, side.factor * wind.factor)), -maxRuns / baselineRuns, maxRuns / baselineRuns));
  const familyStatus = {
    injury: familyRuntimeStatus({ family: 'injury', policy: promotionPolicy, awayComponent: away.components.injury, homeComponent: home.components.injury, policyProvenance: resolvedPolicy.provenance }),
    pitchMatchup: familyRuntimeStatus({ family: 'pitchMatchup', policy: promotionPolicy, awayComponent: away.components.pitchMatchup, homeComponent: home.components.pitchMatchup, policyProvenance: resolvedPolicy.provenance }),
    fielding: familyRuntimeStatus({ family: 'fielding', policy: promotionPolicy, awayComponent: away.components.fielding, homeComponent: home.components.fielding, policyProvenance: resolvedPolicy.provenance }),
    catcherFraming: familyRuntimeStatus({ family: 'catcherFraming', policy: promotionPolicy, awayComponent: away.components.framing, homeComponent: home.components.framing, policyProvenance: resolvedPolicy.provenance }),
    umpireZone: familyRuntimeStatus({ family: 'umpireZone', policy: promotionPolicy, awayComponent: away.components.umpire, homeComponent: home.components.umpire, policyProvenance: resolvedPolicy.provenance }),
    directionalWind: familyRuntimeStatus({ family: 'directionalWind', policy: promotionPolicy, awayComponent: wind, homeComponent: wind, policyProvenance: resolvedPolicy.provenance }),
  };
  const promotedFamilies = Object.values(familyStatus).filter(row => row.promoted).map(row => row.family);
  const activeFamilies = Object.values(familyStatus).filter(row => row.runtimeStatus === 'PROMOTED_ACTIVE').map(row => row.family);
  return {
    version: MLB_ADVANCED_FEATURES_V2_VERSION,
    gameStart,
    awayRunFactor: clamp(withWindBudget(away), 0.84, 1.18),
    homeRunFactor: clamp(withWindBudget(home), 0.84, 1.18),
    away,
    home,
    wind,
    promotion: {
      policyVersion: resolvedPolicy.provenance?.policyVersion || promotionPolicy?.__meta?.version || null,
      runtimePolicyVersion: resolvedPolicy.provenance?.runtimePolicyVersion || null,
      source: resolvedPolicy.provenance?.source || 'SERVER_OWNED_MODULE',
      releaseStatus: resolvedPolicy.provenance?.releaseStatus || 'DIAGNOSTIC_NEUTRAL',
      validationArtifactHash: resolvedPolicy.provenance?.validationArtifactHash || null,
      releaseApproved: resolvedPolicy.provenance?.releaseApproved === true,
      automaticActivation: false,
      payloadCannotPromote: true,
      payloadPolicyIgnored: Boolean(context?.advancedPromotionPolicy || context?.promotionPolicy || context?.serverOwnedPromotionPolicy),
      untrustedOverrideRejected: resolvedPolicy.untrustedOverrideRejected,
      policyPointInTimeRejected: resolvedPolicy.policyPointInTimeRejected,
      policyRejectionReason: resolvedPolicy.rejectionReason || null,
      rejectedValidationArtifactHash: resolvedPolicy.rejectedPolicyProvenance?.validationArtifactHash || null,
      maxAbsoluteRunDeltaPerTeam: maxRuns,
      promotedFamilies,
      activeFamilies,
      allNeutral: activeFamilies.length === 0,
      families: familyStatus,
    },
    flags,
    pointInTimeSafe: !flags.some(flag => flag.endsWith('NOT_POINT_IN_TIME')),
  };
}
