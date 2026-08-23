import { MLB_ADVANCED_PROMOTION_POLICY_V2, isMlbAdvancedFeaturePromotedV2 } from './mlb-advanced-promotion-policy-v2.js';

export const MLB_ADVANCED_FEATURES_V2_VERSION = 'MLB-ADVANCED-FEATURES-PIT-2026-08-v2.1.0';

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
  if (block?.validationStatus !== 'PASSED') return { usable: false, status: featureStatus, reason: 'HISTORICAL_VALIDATION_PENDING' };
  return { usable: true, status: featureStatus, reason: '' };
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
  const runsPrevented = nonFramingFrv / gamesEquivalent * sampleWeight;
  return {
    factor: logFactorFromRuns(-runsPrevented, baselineRuns, 1),
    runsPrevented,
    state,
    audit: { totalFrv, framingRemoved: framingIncluded, innings, gamesEquivalent, sampleWeight },
  };
}

function framingAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'catcherFraming', promotionPolicy);
  if (!state.usable) return { factor: 1, runsPrevented: 0, state };
  const pitches = Math.max(0, finite(block?.pitches, 0));
  const gamesEquivalent = Math.max(1, finite(block?.gamesEquivalent, pitches / 145));
  const framingRuns = finite(block?.framingRuns, finite(block?.runValue, 0));
  const sampleWeight = reliability(pitches, 1200) * statusWeight(state.status);
  const runsPrevented = framingRuns / gamesEquivalent * sampleWeight;
  return {
    factor: logFactorFromRuns(-runsPrevented, baselineRuns, 1),
    runsPrevented,
    state,
    audit: { framingRuns, pitches, gamesEquivalent, sampleWeight },
  };
}

function umpireAdjustment(block, baselineRuns, gameStart, promotionPolicy) {
  const state = featureState(block, gameStart, 'umpireZone', promotionPolicy);
  if (!state.usable) return { factor: 1, runDelta: 0, state };
  const takenPitches = Math.max(0, finite(block?.takenPitches, finite(block?.pitches, 0)));
  const sampleWeight = reliability(takenPitches, 1800) * statusWeight(state.status);
  // This must be catcher-neutral residual run value, not raw called-strike value.
  const residualRunsPerGame = finite(block?.catcherNeutralRunsPerGame, 0);
  const runDelta = residualRunsPerGame * sampleWeight;
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { takenPitches, sampleWeight, requiresCatcherNeutralResidual: true },
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
  const runsLost = Math.max(0, replacementDelta * absentShare * weight);
  return {
    factor: logFactorFromRuns(-runsLost, baselineRuns, 1),
    runsLost,
    state,
    audit: { absentShare, replacementDelta, coverage, weight, lineupAvailable, battingValueExcluded: lineupAvailable },
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
  const runDelta = centeredRunValuePer100 * expectedPitches / 100 * sampleWeight;
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { pitches, coverage, expectedPitches, centeredRunValuePer100, sampleWeight },
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
  const runDelta = coefficient * centeredAlignedWindMph * roofOpenProbability * statusWeight(state.status);
  return {
    factor: logFactorFromRuns(runDelta, baselineRuns, 1),
    runDelta,
    state,
    audit: { coefficient, fieldBearing, windFrom, windTo, windSpeed, alignment, parkBaselineAlignedWindMph, centeredAlignedWindMph, roofOpenProbability },
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
  return {
    factor: clamp(offenseFactor * opponentPreventionFactor, 0.86, 1.16),
    components: { injury, pitchMatchup, fielding, framing, umpire },
  };
}

export function buildMlbAdvancedAdjustmentV2(context = {}, { promotionPolicy = MLB_ADVANCED_PROMOTION_POLICY_V2 } = {}) {
  const gameStart = context?.game?.gameDate || context?.game?.gameStart || '';
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
  return {
    version: MLB_ADVANCED_FEATURES_V2_VERSION,
    gameStart,
    awayRunFactor: clamp(away.factor * wind.factor, 0.84, 1.18),
    homeRunFactor: clamp(home.factor * wind.factor, 0.84, 1.18),
    away,
    home,
    wind,
    flags,
    pointInTimeSafe: !flags.some(flag => flag.endsWith('NOT_POINT_IN_TIME')),
  };
}
