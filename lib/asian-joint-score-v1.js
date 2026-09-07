import { sha256 } from './snapshot-v9.js';
import { negativeBinomialPmf } from './joint-score-v11.js';
import {
  linkedPathMomentsForScenarioV13,
  poissonPmfV13,
} from './joint-score-v13.js';

export const ASIAN_JOINT_SCORE_V1_VERSION = 'ASIAN-INDEPENDENT-STATE-AWARE-JOINT-SCORE-2026-08-v1.0.1';
export const ASIAN_RUN_PROFILE_V1_VERSION = 'ASIAN-PIT-PLAYER-COMPONENT-RUN-PROFILE-2026-08-v1.0.1';
export const ASIAN_GAME_STATE_V1_VERSION = 'ASIAN-OFFICIAL-NINTH-WALKOFF-DRAW-CAP-2026-08-v1.0.0';
export const ASIAN_QUADRATURE_V1_VERSION = 'ASIAN-GAUSS-HERMITE-3X3X3-LINKED-SEGMENTS-v1.0.0';

const ASIAN_LEAGUES = new Set(['NPB', 'KBO', 'CPBL']);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = 0) => {
  if (value == null || !['number', 'string'].includes(typeof value) || (typeof value === 'string' && value.trim() === '')) return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};

const LEAGUE_DISPERSION = Object.freeze({
  NPB: Object.freeze({ first5: 4.2, middle3: 3.6 }),
  KBO: Object.freeze({ first5: 4.8, middle3: 4.0 }),
  CPBL: Object.freeze({ first5: 4.5, middle3: 3.8 }),
});

const QUADRATURE = Object.freeze([
  Object.freeze({ z: -Math.sqrt(3), weight: 1 / 6, level: 'LOW' }),
  Object.freeze({ z: 0, weight: 2 / 3, level: 'BASE' }),
  Object.freeze({ z: Math.sqrt(3), weight: 1 / 6, level: 'HIGH' }),
]);

function leagueIdFor(context) {
  const leagueId = String(context?.leagueId || context?.game?.leagueId || '').trim().toUpperCase();
  if (!ASIAN_LEAGUES.has(leagueId)) throw new Error(`亞洲比分引擎不支援聯盟：${leagueId || 'UNKNOWN'}`);
  return leagueId;
}

function assertInputs(context) {
  const leagueId = leagueIdFor(context);
  if (context?.analysisReadiness?.distributionEngineReady !== true
    || context?.dataGateV10?.passedForShadowScore !== true
    || context?.coreModelable !== true) {
    const error = new Error(`${leagueId} PIT核心資料Gate未通過｜禁止建立比分分布`);
    error.code = 'ASIAN_DISTRIBUTION_INPUT_GATE_BLOCKED';
    error.status = 422;
    throw error;
  }
  if (context?.asianProxyAudit?.tai888UsedAsModelInput === true
    || context?.asianProxyAudit?.mlbFallbackUsed === true) {
    const error = new Error(`${leagueId} 分布輸入污染：禁止Tai888機率或MLB回退`);
    error.code = 'ASIAN_DISTRIBUTION_INPUT_CONTAMINATION';
    error.status = 422;
    throw error;
  }
  return leagueId;
}

function geometricBlend(rows) {
  const total = rows.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (!(total > 0)) return 1;
  return Math.exp(rows.reduce((sum, [value, weight]) => (
    sum + Math.log(clamp(finite(value, 1), 0.45, 2.2)) * Math.max(0, weight)
  ), 0) / total);
}

function offenseFactor(team, baseline, shrink) {
  const seasonRuns = finite(team?.seasonHitting?.runsPerGame, baseline);
  const strength = clamp(seasonRuns / Math.max(0.1, baseline), 0.72, 1.35);
  const lineup = clamp(finite(team?.lineup?.offensiveIndex, 1), 0.78, 1.28);
  const lineupWeight = team?.lineup?.official === true ? 0.52 : 0.34;
  return clamp(Math.exp(
    Math.log(strength) * clamp(shrink, 0.10, 0.85)
      + Math.log(lineup) * lineupWeight,
  ), 0.78, 1.27);
}

function pitchingFactor(block, fallback = 1) {
  const factor = finite(block?.qualityFactor, NaN);
  if (Number.isFinite(factor) && factor > 0) return clamp(factor, 0.72, 1.38);
  const era = finite(block?.era ?? block?.season?.era, NaN);
  const referenceEra = finite(block?.referenceEra, NaN);
  if (Number.isFinite(era) && Number.isFinite(referenceEra) && referenceEra > 0) {
    return clamp(era / referenceEra, 0.72, 1.38);
  }
  return fallback;
}

function segmentPitching(starterFactor, bullpenFactor, expectedInnings) {
  const innings = clamp(finite(expectedInnings, 5), 2.5, 7.2);
  const first5StarterShare = clamp(innings / 5, 0.45, 1);
  const middleStarterShare = clamp((innings - 5) / 3, 0, 0.72);
  return {
    expectedInnings: innings,
    first5StarterShare,
    middleStarterShare,
    first5: geometricBlend([[starterFactor, first5StarterShare], [bullpenFactor, 1 - first5StarterShare]]),
    middle3: geometricBlend([[starterFactor, middleStarterShare], [bullpenFactor, 1 - middleStarterShare]]),
    ninth: bullpenFactor,
  };
}

function uncertaintyFor(team) {
  const starterSample = finite(team?.starter?.season?.battersFaced
    ?? team?.starter?.season?.plateAppearances
    ?? team?.starter?.season?.inningsPitched * 4.25, 0);
  const lineupProjected = team?.lineup?.official !== true;
  const bullpenSample = finite(team?.bullpen?.sampleInnings ?? team?.bullpen?.inningsObserved, 0);
  return clamp(
    0.105
      - Math.min(0.035, starterSample / 12_000)
      - Math.min(0.018, bullpenSample / 700)
      + (lineupProjected ? 0.018 : 0),
    0.055,
    0.135,
  );
}

function estimateAsianRunProfileForContext(context) {
  const leagueId = assertInputs(context);
  const modelConfig = context?.modelConfig || {};
  const baseline = clamp(
    finite(context?.league?.runsPerTeamGame, 4.2),
    finite(modelConfig?.baselineBounds?.full?.min, 3),
    finite(modelConfig?.baselineBounds?.full?.max, 6),
  );
  const away = context?.away || {};
  const home = context?.home || {};
  const awayOffense = offenseFactor(away, baseline, finite(modelConfig?.shrink?.full, 0.65));
  const homeOffense = offenseFactor(home, baseline, finite(modelConfig?.shrink?.full, 0.65));
  const awayStarter = pitchingFactor(away?.starter);
  const homeStarter = pitchingFactor(home?.starter);
  const awayBullpen = pitchingFactor(away?.bullpen);
  const homeBullpen = pitchingFactor(home?.bullpen);
  const awayPitching = segmentPitching(awayStarter, awayBullpen, away?.starter?.expectedInnings);
  const homePitching = segmentPitching(homeStarter, homeBullpen, home?.starter?.expectedInnings);
  const park = clamp(finite(context?.park?.runFactor, 1), 0.78, 1.25);
  const weather = clamp(finite(context?.weather?.meanRunFactor, 1), 0.93, 1.08);
  const homeCoefficient = clamp(finite(modelConfig?.homeCoefficient?.full, 1.02), 0.98, 1.06);
  const segmentMean = (innings, offense, pitching, coefficient = 1) => (
    baseline * (innings / 9) * offense * pitching * park * weather * coefficient
  );
  const fullClamp = modelConfig?.scoreClamps?.full || { min: 1.8, max: 8 };
  const f5Clamp = modelConfig?.scoreClamps?.first5 || { min: 0.6, max: 5 };
  const first5 = {
    away: clamp(segmentMean(5, awayOffense, homePitching.first5), f5Clamp.min, f5Clamp.max),
    home: clamp(segmentMean(5, homeOffense, awayPitching.first5, homeCoefficient), f5Clamp.min, f5Clamp.max),
  };
  const middle3 = {
    away: clamp(segmentMean(3, awayOffense, homePitching.middle3), 0.45, fullClamp.max * 0.48),
    home: clamp(segmentMean(3, homeOffense, awayPitching.middle3, homeCoefficient), 0.45, fullClamp.max * 0.48),
  };
  const ninth = {
    away: clamp(segmentMean(1, awayOffense, homePitching.ninth), 0.12, 1.35),
    home: clamp(segmentMean(1, homeOffense, awayPitching.ninth, homeCoefficient), 0.12, 1.40),
  };
  const dispersion = LEAGUE_DISPERSION[leagueId];
  return {
    leagueId,
    baseline,
    first5,
    middle3,
    ninth,
    late: { away: middle3.away + ninth.away, home: middle3.home + ninth.home },
    scheduledFull: { away: first5.away + middle3.away + ninth.away, home: first5.home + middle3.home + ninth.home },
    full: { away: first5.away + middle3.away + ninth.away, home: first5.home + middle3.home + ninth.home },
    dispersion: {
      awayFirst5: dispersion.first5,
      homeFirst5: dispersion.first5,
      awayMiddle3: dispersion.middle3,
      homeMiddle3: dispersion.middle3,
    },
    uncertainty: {
      away: uncertaintyFor(away),
      home: uncertaintyFor(home),
      environment: clamp(0.045 + (context?.park?.sampleGames < 16 ? 0.015 : 0), 0.04, 0.08),
    },
    components: {
      leagueId,
      awayOffense,
      homeOffense,
      awayStarter,
      homeStarter,
      awayBullpen,
      homeBullpen,
      awayPitching,
      homePitching,
      park,
      weather,
      homeAdvantage: homeCoefficient,
      tai888ProbabilityInputUsed: false,
      mlbParameterFallbackUsed: false,
    },
    statuses: context?.sourceStatuses || {},
    version: ASIAN_RUN_PROFILE_V1_VERSION,
  };
}

function starterAlternatives(starter = {}) {
  const candidates = Array.isArray(starter.candidates) ? starter.candidates : [];
  const projected = starter.confirmed !== true || String(starter.assignmentStatus || '').includes('PROJECTED');
  const positive = candidates.filter(row => finite(row?.probability, 0) > 0);
  // Do not drop a candidate with missing ability and redistribute its mass.
  // That would silently make the remaining pitchers look more certain.
  const usable = projected && positive.length > 0 && positive.every(row => (
    finite(row.qualityFactor, 0) > 0 && finite(row.expectedInnings, 0) > 0
  ));
  if (!usable) return [{ weight: 1, starter, candidateId: null }];
  const total = positive.reduce((sum, row) => sum + Number(row.probability), 0);
  return positive.map((row, index) => ({
    weight: Number(row.probability) / total,
    candidateId: row.officialPlayerId || row.id || `candidate-${index + 1}`,
    starter: {
      ...starter,
      ...row,
      // Season evidence must belong to this candidate, not the primary name.
      season: row.season || { inningsPitched: finite(row.inningsPitched, null), battersFaced: finite(row.battersFaced, null) },
      candidates: [],
    },
  }));
}

function asianDataUsage(context, mixture) {
  const rows = [];
  const add = (key, usedInMean, usedInUncertainty, reason) => rows.push({ key, usedInMean, usedInUncertainty, reason });
  for (const side of ['away', 'home']) {
    const team = context?.[side] || {};
    const candidateAvailable = mixture.some(row => row[`${side}StarterId`] != null);
    const aggregateCandidateUsed = team.starter?.projectionMode === 'OFFICIAL_PRIOR_START_ROTATION_MIXTURE';
    add(`${side}.starter`, true, true, 'QUALITY_AND_EXPECTED_INNINGS_HANDOFF;SAMPLE_SIZE_UNCERTAINTY');
    add(`${side}.starter.candidates`, aggregateCandidateUsed, false, aggregateCandidateUsed
      ? 'WEIGHTED_MEAN_QUALITY_AND_INNINGS_ONLY;CANDIDATE_DISTRIBUTION_MIXTURE_PENDING_VALIDATION'
      : candidateAvailable ? 'DIAGNOSTIC_ONLY;CANDIDATE_DISTRIBUTION_MIXTURE_PENDING_VALIDATION'
        : 'DIAGNOSTIC_ONLY_NO_COMPLETE_CANDIDATE_ABILITIES_OR_CONFIRMED_ASSIGNMENT');
    add(`${side}.starter.projectionConfidence`, false, false, 'DIAGNOSTIC_ONLY;CANDIDATE_PROBABILITIES_WEIGHT_EXISTING_ABILITY_AVERAGES');
    add(`${side}.lineup.offensiveIndex`, finite(team?.lineup?.offensiveIndex, null) != null, team?.lineup?.official !== true, 'LINEUP_INDEX_AND_EXISTING_PROJECTED_LINEUP_SIGMA;SEE_METRIC_COVERAGE');
    add(`${side}.bullpen.qualityFactor`, finite(team?.bullpen?.qualityFactor, null) != null, false, team?.bullpen?.pureRelief === true ? 'PURE_RELIEF_QUALITY_IN_SEGMENT_HANDOFF' : 'NEUTRAL_RELIEF_PRIOR;NOT_OBSERVED_QUALITY');
    add(`${side}.bullpen.sampleInnings`, false, true, 'EXISTING_SAMPLE_SIZE_UNCERTAINTY');
    for (const key of ['bullpen.fatigueIndex', 'bullpen.highLeverageAvailability', 'vsLeft', 'vsRight', 'injuries']) {
      add(`${side}.${key}`, false, false, 'DIAGNOSTIC_ONLY_NO_CALIBRATED_RUN_EFFECT');
    }
  }
  add('park.runFactor', true, true, 'RUN_FACTOR_AND_EXISTING_SMALL_PARK_SAMPLE_UNCERTAINTY');
  add('weather.meanRunFactor', true, false, 'MEAN_FACTOR_ONLY;NO_WEATHER_SPECIFIC_UNCERTAINTY_MODEL');
  add('rules.doubleheader', false, false, 'DIAGNOSTIC_ONLY_NO_CALIBRATED_WORKLOAD_EFFECT');
  add('rules.foreignPlayerConstraint', false, false, 'DIAGNOSTIC_ONLY_NO_FOREIGN_SUBSTITUTION_TRANSITION_MODEL');
  return rows;
}

export function estimateAsianRunProfileV1(context) {
  const base = estimateAsianRunProfileForContext(context);
  const awayOptions = starterAlternatives(context?.away?.starter);
  const homeOptions = starterAlternatives(context?.home?.starter);
  const candidateUsed = awayOptions.some(row => row.candidateId != null) || homeOptions.some(row => row.candidateId != null);
  const mixture = [];
  for (const away of awayOptions) {
    for (const home of homeOptions) {
      const profile = candidateUsed ? estimateAsianRunProfileForContext({
        ...context,
        away: { ...context.away, starter: away.starter },
        home: { ...context.home, starter: home.starter },
      }) : base;
      mixture.push({
        weight: away.weight * home.weight,
        awayStarterId: away.candidateId,
        homeStarterId: home.candidateId,
        first5: profile.first5, middle3: profile.middle3, ninth: profile.ninth,
        uncertainty: profile.uncertainty, dispersion: profile.dispersion,
      });
    }
  }
  const weighted = key => Object.fromEntries(['away', 'home'].map(side => [side,
    mixture.reduce((sum, row) => sum + row.weight * row[key][side], 0),
  ]));
  const first5 = weighted('first5');
  const middle3 = weighted('middle3');
  const ninth = weighted('ninth');
  const betweenCandidateVariance = Object.fromEntries(['first5', 'middle3', 'ninth'].map(key => [key,
    Object.fromEntries(['away', 'home'].map(side => [side,
      mixture.reduce((sum, row) => sum + row.weight * (row[key][side] - weighted(key)[side]) ** 2, 0),
    ])),
  ]));
  return {
    ...base,
    starterMixtureDiagnostic: {
      status: 'PENDING_HISTORICAL_VALIDATION',
      usedInProductionDistribution: false,
      candidateUsed,
      componentCount: mixture.length,
      method: candidateUsed ? 'DISCRETE_CANDIDATE_PROFILE_COMPARISON' : 'SINGLE_STARTER_PROFILE',
      uncertaintyExpanded: false,
      candidateSpreadPresent: Object.values(betweenCandidateVariance).some(row => row.away > 0 || row.home > 0),
      betweenCandidateVariance,
      proposedMeans: { first5, middle3, ninth },
      components: mixture,
      reason: 'PRODUCTION_RETAINS_EXISTING_WEIGHTED_MEAN;WHOLE_DISTRIBUTION_MIXTURE_REQUIRES_VALIDATION_AND_MODEL_CHANGE_APPROVAL',
    },
    dataUsage: asianDataUsage(context, mixture),
  };
}

function scenarioPmf(mean, sigma, shock, dispersion, maximum) {
  const adjustedMean = Math.max(0.05, mean * Math.exp(shock * sigma - 0.5 * sigma * sigma));
  return { mean: adjustedMean, pmf: negativeBinomialPmf(adjustedMean, dispersion, maximum) };
}

export function buildAsianJointScoreSnapshotV1({ context, modelVersion, rulesVersion }) {
  const leagueId = assertInputs(context);
  const profile = estimateAsianRunProfileV1(context);
  const rules = context?.gameStateModel || {};
  const regulationInnings = finite(rules.regulationInnings, 9);
  const extraInningsLimit = finite(rules.extraInningsLimit, 12);
  const extraInnings = Math.max(0, Math.trunc(extraInningsLimit - regulationInnings));
  if (regulationInnings !== 9 || extraInnings < 0 || rules.automaticRunner === true) {
    throw new Error(`${leagueId} 未發布的局數／突破僵局規則，禁止建立分布`);
  }
  const scenarios = [];
  let index = 0;
  for (const awayNode of QUADRATURE) {
    for (const homeNode of QUADRATURE) {
      for (const environmentNode of QUADRATURE) {
        const environmentMultiplier = Math.exp(
          environmentNode.z * profile.uncertainty.environment
            - 0.5 * profile.uncertainty.environment ** 2,
        );
        const awayFirst5 = scenarioPmf(profile.first5.away * environmentMultiplier, profile.uncertainty.away, awayNode.z, profile.dispersion.awayFirst5, 20);
        const homeFirst5 = scenarioPmf(profile.first5.home * environmentMultiplier, profile.uncertainty.home, homeNode.z, profile.dispersion.homeFirst5, 20);
        const awayMiddle3 = scenarioPmf(profile.middle3.away * environmentMultiplier, profile.uncertainty.away * 0.82, awayNode.z, profile.dispersion.awayMiddle3, 16);
        const homeMiddle3 = scenarioPmf(profile.middle3.home * environmentMultiplier, profile.uncertainty.home * 0.82, homeNode.z, profile.dispersion.homeMiddle3, 16);
        const awayNinthMean = Math.max(0.05, profile.ninth.away * environmentMultiplier * Math.exp(awayNode.z * profile.uncertainty.away * 0.60 - 0.5 * (profile.uncertainty.away * 0.60) ** 2));
        const homeNinthMean = Math.max(0.05, profile.ninth.home * environmentMultiplier * Math.exp(homeNode.z * profile.uncertainty.home * 0.60 - 0.5 * (profile.uncertainty.home * 0.60) ** 2));
        scenarios.push({
          id: `ASIAN-GH-${leagueId}-${++index}-${awayNode.level}-${homeNode.level}-${environmentNode.level}`,
          weight: awayNode.weight * homeNode.weight * environmentNode.weight,
          shocks: { away: awayNode.z, home: homeNode.z, environment: environmentNode.z },
          means: {
            awayFirst5: awayFirst5.mean,
            homeFirst5: homeFirst5.mean,
            awayMiddle3: awayMiddle3.mean,
            homeMiddle3: homeMiddle3.mean,
            awayNinth: awayNinthMean,
            homeNinth: homeNinthMean,
            awayLate: awayMiddle3.mean + awayNinthMean,
            homeLate: homeMiddle3.mean + homeNinthMean,
          },
          pmf: {
            awayFirst5: awayFirst5.pmf,
            homeFirst5: homeFirst5.pmf,
            awayMiddle3: awayMiddle3.pmf,
            homeMiddle3: homeMiddle3.pmf,
            awayNinth: poissonPmfV13(awayNinthMean, 8),
            homeNinth: poissonPmfV13(homeNinthMean, 8),
          },
          gameState: {
            version: ASIAN_GAME_STATE_V1_VERSION,
            regulationInnings,
            extraInnings,
            extraInningsLimit,
            allowDraw: rules.allowDraw === true,
            automaticRunner: false,
          },
        });
      }
    }
  }
  const centralScenario = scenarios.find(row => row.shocks.away === 0 && row.shocks.home === 0 && row.shocks.environment === 0) || scenarios[0];
  const compact = {
    version: ASIAN_JOINT_SCORE_V1_VERSION,
    leagueId,
    gameStateVersion: ASIAN_GAME_STATE_V1_VERSION,
    starterBullpenHandoffVersion: 'ASIAN-EXPECTED-INNINGS-PURE-RELIEF-HANDOFF-v1.0.0',
    quadratureVersion: ASIAN_QUADRATURE_V1_VERSION,
    runProfileVersion: profile.version,
    jointPathVersion: 'ASIAN-F5-TO-6-8-TO-OFFICIAL-9TH-TO-DRAW-CAP-v1.0.0',
    modelVersion,
    rulesVersion,
    gamePk: context?.game?.gamePk || null,
    profile,
    scenarios,
    scenarioWeight: scenarios.reduce((sum, scenario) => sum + scenario.weight, 0),
    exactDistribution: true,
    linkedSegmentPath: true,
    linkedPathAudit: linkedPathMomentsForScenarioV13(centralScenario),
    stateAwareBottomNinth: true,
    stateAwareWalkoff: true,
    officialExtraInningsLimit: extraInningsLimit,
    drawAtLimit: rules.allowDraw === true,
    simulationsPerScenario: 0,
    targetMarketCalibrationApplied: false,
    tai888ProbabilityInputUsed: false,
    mlbParameterFallbackUsed: false,
    legacyDistributionUsed: false,
  };
  const distributionHash = sha256(compact);
  return {
    ...compact,
    distributionId: `${context?.game?.gamePk || 'game'}:${leagueId}:${distributionHash.slice(0, 20)}`,
    distributionHash,
  };
}
