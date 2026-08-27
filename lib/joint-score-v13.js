import { sha256 } from './snapshot-v9.js';
import { negativeBinomialPmf } from './joint-score-v11.js';
import { estimateRunProfileV103, MLB_RUN_MODEL_V103_VERSION } from './mlb-run-model-v103.js';
import { buildMlbAdvancedAdjustmentV2 } from './mlb-advanced-features-v2.js';

export const JOINT_SCORE_V13_VERSION = 'BASEBALL-STATE-AWARE-LINKED-SEGMENT-SCORE-2026-08-v11.0.0';
export const MLB_STATE_RUN_MODEL_V13_VERSION = 'MLB-CORRELATED-STATE-FEATURE-RUN-PROFILE-2026-08-v11.0.0';
export const SCENARIO_QUADRATURE_V13_VERSION = 'GAUSS-HERMITE-3X3X3-LINKED-SEGMENTS-v2.0.0';
export const GAME_STATE_V13_VERSION = 'MLB-BOTTOM-NINTH-WALKOFF-EXTRAS-2026-08-v1.0.0';
export const STARTER_BULLPEN_HANDOFF_V13_VERSION = 'MLB-EXPECTED-INNINGS-HANDOFF-2026-08-v1.0.0';
export { negativeBinomialPmf };

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = 0) => {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const distributionCache = new WeakMap();
const linkedMomentCache = new WeakMap();
// State-aware termination makes full-game totals slightly more non-linear than
// the scheduled-nine-inning approximation. Keep the existing 5% stability
// contract by applying a small, explicit shrink to scenario shocks rather than
// weakening the qualification threshold.
const STATE_AWARE_SCENARIO_SIGMA_SCALE = 0.92;

function sampleReliability(sampleSize, target) {
  const sample = Math.max(0, finite(sampleSize, 0));
  return clamp(sample / (sample + target), 0, 0.92);
}

function blendLogFactor(rawFactor, reliability, cap = 0.22) {
  const safeFactor = clamp(finite(rawFactor, 1), 0.55, 1.75);
  return Math.exp(clamp(Math.log(safeFactor) * reliability, -cap, cap));
}

function geometricBlend(rows) {
  const total = rows.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  if (total <= 0) return 1;
  return Math.exp(rows.reduce((sum, [value, weight]) => sum + Math.log(clamp(finite(value, 1), 0.45, 2.2)) * Math.max(0, weight), 0) / total);
}

function lineupFactor(team) {
  const index = finite(team?.lineup?.offensiveIndex, 1);
  const reliability = team?.lineup?.official ? 0.50 : team?.lineup?.projected ? 0.28 : 0;
  return clamp(blendLogFactor(index, reliability, 0.055), 0.945, 1.057);
}

function platoonFactor(team, opposingStarter) {
  const hand = String(opposingStarter?.throws || '').toUpperCase();
  const split = hand === 'L' ? team?.vsLeft : hand === 'R' ? team?.vsRight : null;
  if (!split?.available) return 1;
  const teamOps = Math.max(0.5, finite(team?.hitting?.ops, 0.72));
  const reliability = sampleReliability(split?.plateAppearances, 500) * 0.45;
  return clamp(blendLogFactor(finite(split?.ops, teamOps) / teamOps, reliability, 0.045), 0.956, 1.046);
}

function bullpenFactor(team) {
  const bullpen = team?.bullpen || {};
  if (bullpen?.pureRelief === true && Number.isFinite(Number(bullpen?.qualityFactor)) && bullpen?.status !== 'MISSING') {
    const reliability = bullpen.status === 'CONFIRMED' ? 0.60 : 0.35;
    return clamp(blendLogFactor(bullpen.qualityFactor, reliability, 0.085), 0.918, 1.089);
  }
  return 1;
}

function statusUncertainty(status, confirmed = 0.035, projected = 0.065, missing = 0.10) {
  if (status === 'CONFIRMED') return confirmed;
  if (status === 'PROJECTED') return projected;
  return missing;
}

function segmentPitching(starterFactor, bullpen, expectedInnings) {
  const expected = clamp(finite(expectedInnings, 5.2), 1, 7.2);
  const first5StarterShare = clamp(expected / 5, 0.20, 1);
  const middleStarterShare = clamp((expected - 5) / 3, 0, 0.74);
  return {
    first5StarterShare,
    middleStarterShare,
    first5: geometricBlend([[starterFactor, first5StarterShare], [bullpen, 1 - first5StarterShare]]),
    middle3: geometricBlend([[starterFactor, middleStarterShare], [bullpen, 1 - middleStarterShare]]),
    ninth: bullpen,
  };
}

export function estimateRunProfileV13(context, { serverOwnedPromotionPolicy = null } = {}) {
  const base = estimateRunProfileV103(context);
  const advanced = buildMlbAdvancedAdjustmentV2(context, { serverOwnedPromotionPolicy });
  const away = context?.away || {};
  const home = context?.home || {};
  const baseline = base.baseline;
  const environment = finite(base?.components?.environment, 1);
  const homeAdvantage = finite(base?.components?.homeAdvantage, 1.018);
  const awayBaseOffense = finite(base?.components?.awayOffense, 1);
  const homeBaseOffense = finite(base?.components?.homeOffense, 1);
  const awayLineup = lineupFactor(away);
  const homeLineup = lineupFactor(home);
  const awayPlatoon = platoonFactor(away, home?.starter);
  const homePlatoon = platoonFactor(home, away?.starter);
  const awayNeutralOffense = clamp(awayBaseOffense * awayLineup * awayPlatoon, 0.80, 1.22);
  const homeNeutralOffense = clamp(homeBaseOffense * homeLineup * homePlatoon, 0.80, 1.22);
  const awayStarter = finite(base?.components?.awayStarter, 1);
  const homeStarter = finite(base?.components?.homeStarter, 1);
  const awayBullpen = bullpenFactor(away);
  const homeBullpen = bullpenFactor(home);
  const awayExpectedInnings = clamp(finite(away?.starter?.expectedInnings, base?.components?.awayStarterExpectedInnings ?? 5.2), 1, 7.2);
  const homeExpectedInnings = clamp(finite(home?.starter?.expectedInnings, base?.components?.homeStarterExpectedInnings ?? 5.2), 1, 7.2);
  const awayPitching = segmentPitching(awayStarter, awayBullpen, awayExpectedInnings);
  const homePitching = segmentPitching(homeStarter, homeBullpen, homeExpectedInnings);
  const maxAdvancedRuns = clamp(finite(advanced?.promotion?.maxAbsoluteRunDeltaPerTeam, 0.30), 0.05, 0.30);
  const unitScheduledMean = (pitching, coefficient = 1) => baseline * environment * coefficient * (
    (5 / 9) * pitching.first5 + (3 / 9) * pitching.middle3 + (1 / 9) * pitching.ninth
  );
  const awayUnitScheduledMean = unitScheduledMean(homePitching);
  const homeUnitScheduledMean = unitScheduledMean(awayPitching, homeAdvantage);
  const budgetedOffense = (neutralOffense, advancedFactor, unitMean) => {
    const requested = clamp(neutralOffense * advancedFactor, 0.80, 1.22);
    const maximumOffenseMove = maxAdvancedRuns / Math.max(0.25, unitMean);
    return clamp(requested, neutralOffense - maximumOffenseMove, neutralOffense + maximumOffenseMove);
  };
  const awayOffense = budgetedOffense(awayNeutralOffense, advanced.awayRunFactor, awayUnitScheduledMean);
  const homeOffense = budgetedOffense(homeNeutralOffense, advanced.homeRunFactor, homeUnitScheduledMean);
  const advancedRunBudget = {
    maxAbsoluteRunDeltaPerTeam: maxAdvancedRuns,
    awayRequestedFactor: advanced.awayRunFactor,
    homeRequestedFactor: advanced.homeRunFactor,
    awayActualScheduledRunDelta: awayUnitScheduledMean * (awayOffense - awayNeutralOffense),
    homeActualScheduledRunDelta: homeUnitScheduledMean * (homeOffense - homeNeutralOffense),
    awayCapped: Math.abs(awayOffense - clamp(awayNeutralOffense * advanced.awayRunFactor, 0.80, 1.22)) > 1e-12,
    homeCapped: Math.abs(homeOffense - clamp(homeNeutralOffense * advanced.homeRunFactor, 0.80, 1.22)) > 1e-12,
  };
  const segmentMean = (innings, offense, pitching, coefficient = 1) => baseline * (innings / 9) * offense * pitching * environment * coefficient;
  const first5 = {
    away: clamp(segmentMean(5, awayOffense, homePitching.first5), 1, 4.15),
    home: clamp(segmentMean(5, homeOffense, awayPitching.first5, homeAdvantage), 1, 4.25),
  };
  const middle3 = {
    away: clamp(segmentMean(3, awayOffense, homePitching.middle3), 0.55, 2.70),
    home: clamp(segmentMean(3, homeOffense, awayPitching.middle3, homeAdvantage), 0.55, 2.75),
  };
  const ninth = {
    away: clamp(segmentMean(1, awayOffense, homePitching.ninth), 0.15, 1.20),
    home: clamp(segmentMean(1, homeOffense, awayPitching.ninth, homeAdvantage), 0.15, 1.25),
  };
  const awaySplit = home?.starter?.throws === 'L' ? away?.vsLeft : away?.vsRight;
  const homeSplit = away?.starter?.throws === 'L' ? home?.vsLeft : home?.vsRight;
  const awayFeatureResidual = Math.sqrt(
    statusUncertainty(home?.starter?.throwsStatus, 0.002, 0.007, 0.012) ** 2
    + statusUncertainty(awaySplit?.status, 0.003, 0.008, 0.014) ** 2
    + statusUncertainty(home?.bullpen?.status, 0.003, 0.008, 0.014) ** 2,
  ) * 0.20;
  const homeFeatureResidual = Math.sqrt(
    statusUncertainty(away?.starter?.throwsStatus, 0.002, 0.007, 0.012) ** 2
    + statusUncertainty(homeSplit?.status, 0.003, 0.008, 0.014) ** 2
    + statusUncertainty(away?.bullpen?.status, 0.003, 0.008, 0.014) ** 2,
  ) * 0.20;

  return {
    baseline,
    first5,
    middle3,
    ninth,
    late: { away: middle3.away + ninth.away, home: middle3.home + ninth.home },
    scheduledFull: { away: first5.away + middle3.away + ninth.away, home: first5.home + middle3.home + ninth.home },
    full: { away: first5.away + middle3.away + ninth.away, home: first5.home + middle3.home + ninth.home },
    dispersion: { awayFirst5: base.dispersion.awayFirst5, homeFirst5: base.dispersion.homeFirst5, awayMiddle3: base.dispersion.awayLate, homeMiddle3: base.dispersion.homeLate },
    uncertainty: {
      away: base.uncertainty.away,
      home: base.uncertainty.home,
      environment: base.uncertainty.environment,
    },
    components: {
      ...base.components,
      baseRunProfileVersion: MLB_RUN_MODEL_V103_VERSION,
      awayBaseOffense, homeBaseOffense,
      awayLineup, homeLineup,
      awayPlatoon, homePlatoon,
      advanced,
      advancedPromotion: advanced.promotion,
      awayNeutralOffense, homeNeutralOffense,
      advancedRunBudget,
      awayOffense, homeOffense,
      awayStarter, homeStarter,
      awayBullpen, homeBullpen,
      awayStarterExpectedInnings: awayExpectedInnings,
      homeStarterExpectedInnings: homeExpectedInnings,
      awayPitching, homePitching,
      bullpenProxy: away?.bullpen?.pureRelief === true && home?.bullpen?.pureRelief === true ? 'RELIEF_ONLY_PIT_ROSTERS' : 'TEAM_PITCHING_AUDIT_ONLY_NEUTRAL',
      environment, homeAdvantage,
    },
    version: MLB_STATE_RUN_MODEL_V13_VERSION,
    statuses: context?.sourceStatuses || {},
    diagnostics: { ...base.diagnostics, stateFeatureResidual: { away: awayFeatureResidual, home: homeFeatureResidual } },
  };
}

const QUADRATURE = Object.freeze([
  Object.freeze({ z: -Math.sqrt(3), weight: 1 / 6, level: 'LOW' }),
  Object.freeze({ z: 0, weight: 2 / 3, level: 'BASE' }),
  Object.freeze({ z: Math.sqrt(3), weight: 1 / 6, level: 'HIGH' }),
]);

function scenarioPmf(mean, sigma, shock, dispersion, maximum) {
  const adjustedMean = Math.max(0.05, mean * Math.exp(shock * sigma - 0.5 * sigma * sigma));
  return { mean: adjustedMean, pmf: negativeBinomialPmf(adjustedMean, dispersion, maximum) };
}

export function poissonPmfV13(mean, maximum = 8) {
  const mu = Math.max(0.01, finite(mean, 0.01));
  const rows = [];
  let probability = Math.exp(-mu);
  let total = 0;
  for (let runs = 0; runs <= maximum; runs += 1) {
    if (runs > 0) probability *= mu / runs;
    rows.push([runs, probability]);
    total += probability;
  }
  rows[rows.length - 1][1] += Math.max(0, 1 - total);
  const normalization = rows.reduce((sum, row) => sum + row[1], 0) || 1;
  return rows.map(([runs, value]) => [runs, value / normalization]);
}

function convolve(left, right, maximum = 30) {
  const output = Array.from({ length: maximum + 1 }, () => 0);
  for (const [leftRuns, leftProbability] of left || []) {
    for (const [rightRuns, rightProbability] of right || []) {
      output[Math.min(maximum, leftRuns + rightRuns)] += leftProbability * rightProbability;
    }
  }
  const total = output.reduce((sum, value) => sum + value, 0) || 1;
  return output.map((probability, runs) => [runs, probability / total]).filter(([, probability]) => probability > 1e-15);
}

function addScore(map, awayRuns, homeRuns, probability) {
  if (probability <= 1e-18) return;
  const key = `${Math.min(40, awayRuns)}:${Math.min(40, homeRuns)}`;
  map.set(key, (map.get(key) || 0) + probability);
}

export function applyBottomNinthStateV13({ awayRuns, homeRuns, sampledHomeRuns }) {
  if (homeRuns > awayRuns) return { awayRuns, homeRuns, bottomPlayed: false, walkoff: false, tied: false };
  const needed = awayRuns - homeRuns + 1;
  if (sampledHomeRuns >= needed) {
    return { awayRuns, homeRuns: homeRuns + needed, bottomPlayed: true, walkoff: true, tied: false };
  }
  const resolvedHome = homeRuns + sampledHomeRuns;
  return { awayRuns, homeRuns: resolvedHome, bottomPlayed: true, walkoff: false, tied: resolvedHome === awayRuns };
}

export function extraInningsKernelV13(
  scenario,
  maximumInnings = Number.isInteger(Number(scenario?.gameState?.extraInnings))
    ? Number(scenario.gameState.extraInnings)
    : 12,
) {
  const allowDrawAtLimit = scenario?.gameState?.allowDraw === true;
  const awayMean = Math.max(0.30, finite(scenario?.means?.awayNinth, finite(scenario?.means?.awayLate, 1.9) / 4) * 1.30);
  const homeMean = Math.max(0.30, finite(scenario?.means?.homeNinth, finite(scenario?.means?.homeLate, 1.9) / 4) * 1.30);
  const awayPmf = poissonPmfV13(awayMean, 8);
  const homePmf = poissonPmfV13(homeMean, 8);
  let live = new Map([['0:0', 1]]);
  const terminal = new Map();
  let walkoffProbability = 0;
  for (let inning = 0; inning < maximumInnings; inning += 1) {
    const nextLive = new Map();
    for (const [key, stateProbability] of live) {
      const [awayAccumulated, homeAccumulated] = key.split(':').map(Number);
      for (const [awayRuns, awayProbability] of awayPmf) {
        for (const [sampledHomeRuns, homeProbability] of homePmf) {
          const probability = stateProbability * awayProbability * homeProbability;
          if (probability <= 1e-18) continue;
          if (sampledHomeRuns > awayRuns) {
            addScore(terminal, awayAccumulated + awayRuns, homeAccumulated + awayRuns + 1, probability);
            walkoffProbability += probability;
          } else if (sampledHomeRuns < awayRuns) {
            addScore(terminal, awayAccumulated + awayRuns, homeAccumulated + sampledHomeRuns, probability);
          } else {
            addScore(nextLive, awayAccumulated + awayRuns, homeAccumulated + sampledHomeRuns, probability);
          }
        }
      }
    }
    live = nextLive;
    if ([...live.values()].reduce((sum, value) => sum + value, 0) < 1e-12) break;
  }
  if (allowDrawAtLimit) {
    for (const [key, probability] of live) {
      const [away, home] = key.split(':').map(Number);
      addScore(terminal, away, home, probability);
    }
  } else {
    // MLB has no regular-season draw.  Preserve the pre-existing unbounded
    // terminal approximation after the finite audit window.  Asian engines
    // set allowDraw and retain the tied state at their official inning cap.
    let awayTerminalRate = 0;
    let homeTerminalRate = 0;
    for (const [awayRuns, awayProbability] of awayPmf) {
      for (const [homeRuns, homeProbability] of homePmf) {
        const probability = awayProbability * homeProbability;
        if (awayRuns > homeRuns) awayTerminalRate += probability;
        if (homeRuns > awayRuns) homeTerminalRate += probability;
      }
    }
    const terminalRate = awayTerminalRate + homeTerminalRate || 1;
    for (const [key, probability] of live) {
      const [away, home] = key.split(':').map(Number);
      addScore(terminal, away + 1, home, probability * awayTerminalRate / terminalRate);
      addScore(terminal, away, home + 1, probability * homeTerminalRate / terminalRate);
    }
  }
  const rows = [...terminal.entries()].map(([key, probability]) => {
    const [awayRuns, homeRuns] = key.split(':').map(Number);
    return { awayRuns, homeRuns, probability };
  });
  const total = rows.reduce((sum, row) => sum + row.probability, 0) || 1;
  return {
    cells: rows.map(row => ({ ...row, probability: row.probability / total })),
    coverage: 1,
    walkoffProbability: clamp(walkoffProbability, 0, 1),
    maximumInnings,
    allowDrawAtLimit,
  };
}

function first5Distribution(scenario) {
  const cells = [];
  let coverage = 0;
  for (const [awayRuns, awayProbability] of scenario?.pmf?.awayFirst5 || []) {
    for (const [homeRuns, homeProbability] of scenario?.pmf?.homeFirst5 || []) {
      const probability = awayProbability * homeProbability;
      if (probability <= 1e-18) continue;
      cells.push({ awayRuns, homeRuns, probability });
      coverage += probability;
    }
  }
  if (coverage > 0 && Math.abs(coverage - 1) > 1e-14) for (const cell of cells) cell.probability /= coverage;
  return { cells, coverage: coverage > 0 ? 1 : 0 };
}

function fullDistribution(scenario) {
  const awayAfter8 = convolve(scenario?.pmf?.awayFirst5, scenario?.pmf?.awayMiddle3, 32);
  const homeAfter8 = convolve(scenario?.pmf?.homeFirst5, scenario?.pmf?.homeMiddle3, 32);
  const awayNinth = scenario?.pmf?.awayNinth || poissonPmfV13(scenario?.means?.awayNinth, 8);
  const homeNinth = scenario?.pmf?.homeNinth || poissonPmfV13(scenario?.means?.homeNinth, 8);
  const extras = extraInningsKernelV13(scenario);
  const output = new Map();
  let skippedBottomProbability = 0;
  let regulationWalkoffProbability = 0;
  let extraInningsProbability = 0;
  for (const [awayEightRuns, awayEightProbability] of awayAfter8) {
    for (const [homeEightRuns, homeEightProbability] of homeAfter8) {
      const throughEightProbability = awayEightProbability * homeEightProbability;
      for (const [topNinthRuns, topNinthProbability] of awayNinth) {
        const stateProbability = throughEightProbability * topNinthProbability;
        const awayRegulation = awayEightRuns + topNinthRuns;
        if (homeEightRuns > awayRegulation) {
          addScore(output, awayRegulation, homeEightRuns, stateProbability);
          skippedBottomProbability += stateProbability;
          continue;
        }
        for (const [sampledHomeRuns, bottomProbability] of homeNinth) {
          const probability = stateProbability * bottomProbability;
          const resolved = applyBottomNinthStateV13({ awayRuns: awayRegulation, homeRuns: homeEightRuns, sampledHomeRuns });
          if (resolved.walkoff) {
            addScore(output, resolved.awayRuns, resolved.homeRuns, probability);
            regulationWalkoffProbability += probability;
          } else if (resolved.tied) {
            extraInningsProbability += probability;
            for (const extra of extras.cells) {
              addScore(output, resolved.awayRuns + extra.awayRuns, resolved.homeRuns + extra.homeRuns, probability * extra.probability);
            }
          } else {
            addScore(output, resolved.awayRuns, resolved.homeRuns, probability);
          }
        }
      }
    }
  }
  const cells = [...output.entries()].map(([key, probability]) => {
    const [awayRuns, homeRuns] = key.split(':').map(Number);
    return { awayRuns, homeRuns, probability };
  });
  const coverage = cells.reduce((sum, cell) => sum + cell.probability, 0) || 1;
  for (const cell of cells) cell.probability /= coverage;
  return {
    cells,
    coverage: 1,
    gameStateAudit: {
      version: scenario?.gameState?.version || GAME_STATE_V13_VERSION,
      bottomNinthSkippedProbability: skippedBottomProbability / coverage,
      regulationWalkoffProbability: regulationWalkoffProbability / coverage,
      extraInningsProbability: extraInningsProbability / coverage,
      extraInningsWalkoffConditionalProbability: extras.walkoffProbability,
      noUnverifiedWalkoffExtraMargin: true,
    },
  };
}

function finishingMomentsFromAfterEight(scenario, awayEightRuns, homeEightRuns) {
  const awayNinth = scenario?.pmf?.awayNinth || poissonPmfV13(scenario?.means?.awayNinth, 8);
  const homeNinth = scenario?.pmf?.homeNinth || poissonPmfV13(scenario?.means?.homeNinth, 8);
  const extras = extraInningsKernelV13(scenario);
  let probabilitySum = 0;
  let totalMean = 0;
  let totalSecond = 0;
  let differentialMean = 0;
  let differentialSecond = 0;
  const record = (awayRuns, homeRuns, probability) => {
    const total = awayRuns + homeRuns;
    const differential = awayRuns - homeRuns;
    probabilitySum += probability;
    totalMean += probability * total;
    totalSecond += probability * total * total;
    differentialMean += probability * differential;
    differentialSecond += probability * differential * differential;
  };
  for (const [topNinthRuns, topNinthProbability] of awayNinth) {
    const awayRegulation = awayEightRuns + topNinthRuns;
    if (homeEightRuns > awayRegulation) {
      record(awayRegulation, homeEightRuns, topNinthProbability);
      continue;
    }
    for (const [sampledHomeRuns, bottomProbability] of homeNinth) {
      const probability = topNinthProbability * bottomProbability;
      const resolved = applyBottomNinthStateV13({ awayRuns: awayRegulation, homeRuns: homeEightRuns, sampledHomeRuns });
      if (resolved.tied) {
        for (const extra of extras.cells) {
          record(resolved.awayRuns + extra.awayRuns, resolved.homeRuns + extra.homeRuns, probability * extra.probability);
        }
      } else {
        record(resolved.awayRuns, resolved.homeRuns, probability);
      }
    }
  }
  const divisor = probabilitySum || 1;
  return {
    totalMean: totalMean / divisor,
    totalSecond: totalSecond / divisor,
    differentialMean: differentialMean / divisor,
    differentialSecond: differentialSecond / divisor,
  };
}

export function linkedPathMomentsForScenarioV13(scenario) {
  const cached = linkedMomentCache.get(scenario);
  if (cached) return cached;
  const finishing = new Map();
  const moment = {
    probability: 0,
    f5Total: 0,
    f5TotalSecond: 0,
    fullTotal: 0,
    fullTotalSecond: 0,
    totalCross: 0,
    f5Differential: 0,
    f5DifferentialSecond: 0,
    fullDifferential: 0,
    fullDifferentialSecond: 0,
    differentialCross: 0,
  };
  for (const [awayFirst5, awayFirst5Probability] of scenario?.pmf?.awayFirst5 || []) {
    for (const [homeFirst5, homeFirst5Probability] of scenario?.pmf?.homeFirst5 || []) {
      const f5Probability = awayFirst5Probability * homeFirst5Probability;
      const f5Total = awayFirst5 + homeFirst5;
      const f5Differential = awayFirst5 - homeFirst5;
      for (const [awayMiddle3, awayMiddleProbability] of scenario?.pmf?.awayMiddle3 || []) {
        for (const [homeMiddle3, homeMiddleProbability] of scenario?.pmf?.homeMiddle3 || []) {
          const probability = f5Probability * awayMiddleProbability * homeMiddleProbability;
          if (probability <= 1e-18) continue;
          const awayEight = awayFirst5 + awayMiddle3;
          const homeEight = homeFirst5 + homeMiddle3;
          const key = `${awayEight}:${homeEight}`;
          if (!finishing.has(key)) finishing.set(key, finishingMomentsFromAfterEight(scenario, awayEight, homeEight));
          const full = finishing.get(key);
          moment.probability += probability;
          moment.f5Total += probability * f5Total;
          moment.f5TotalSecond += probability * f5Total * f5Total;
          moment.fullTotal += probability * full.totalMean;
          moment.fullTotalSecond += probability * full.totalSecond;
          moment.totalCross += probability * f5Total * full.totalMean;
          moment.f5Differential += probability * f5Differential;
          moment.f5DifferentialSecond += probability * f5Differential * f5Differential;
          moment.fullDifferential += probability * full.differentialMean;
          moment.fullDifferentialSecond += probability * full.differentialSecond;
          moment.differentialCross += probability * f5Differential * full.differentialMean;
        }
      }
    }
  }
  const divisor = moment.probability || 1;
  const f5TotalMean = moment.f5Total / divisor;
  const fullTotalMean = moment.fullTotal / divisor;
  const f5DifferentialMean = moment.f5Differential / divisor;
  const fullDifferentialMean = moment.fullDifferential / divisor;
  const totalVarianceF5 = Math.max(0, moment.f5TotalSecond / divisor - f5TotalMean ** 2);
  const totalVarianceFull = Math.max(0, moment.fullTotalSecond / divisor - fullTotalMean ** 2);
  const differentialVarianceF5 = Math.max(0, moment.f5DifferentialSecond / divisor - f5DifferentialMean ** 2);
  const differentialVarianceFull = Math.max(0, moment.fullDifferentialSecond / divisor - fullDifferentialMean ** 2);
  const totalDenominator = Math.sqrt(totalVarianceF5 * totalVarianceFull);
  const differentialDenominator = Math.sqrt(differentialVarianceF5 * differentialVarianceFull);
  const value = {
    version: 'F5_FULL_LINKED_PATH_MOMENTS-v1.0.0',
    coverage: moment.probability,
    f5FullTotalCorrelation: totalDenominator > 0 ? clamp((moment.totalCross / divisor - f5TotalMean * fullTotalMean) / totalDenominator, -1, 1) : 0,
    f5FullRunDifferentialCorrelation: differentialDenominator > 0 ? clamp((moment.differentialCross / divisor - f5DifferentialMean * fullDifferentialMean) / differentialDenominator, -1, 1) : 0,
    means: { f5Total: f5TotalMean, fullTotal: fullTotalMean, f5Differential: f5DifferentialMean, fullDifferential: fullDifferentialMean },
  };
  linkedMomentCache.set(scenario, value);
  return value;
}

function distributionsForScenario(scenario) {
  const cached = distributionCache.get(scenario);
  if (cached) return cached;
  const value = { first5: first5Distribution(scenario), full: fullDistribution(scenario) };
  distributionCache.set(scenario, value);
  return value;
}

export function scoreDistributionForScenario(scenario, first5 = false) {
  const value = distributionsForScenario(scenario);
  return first5 ? value.first5 : value.full;
}

export function gameStateAuditForScenarioV13(scenario) {
  return distributionsForScenario(scenario).full.gameStateAudit;
}

export function buildJointScoreSnapshotV13({ context, modelVersion, rulesVersion, serverOwnedPromotionPolicy = null }) {
  const profile = estimateRunProfileV13(context, { serverOwnedPromotionPolicy });
  const awayScenarioSigma = profile.uncertainty.away * STATE_AWARE_SCENARIO_SIGMA_SCALE;
  const homeScenarioSigma = profile.uncertainty.home * STATE_AWARE_SCENARIO_SIGMA_SCALE;
  const environmentScenarioSigma = profile.uncertainty.environment * STATE_AWARE_SCENARIO_SIGMA_SCALE;
  const scenarios = [];
  let index = 0;
  for (const awayNode of QUADRATURE) {
    for (const homeNode of QUADRATURE) {
      for (const environmentNode of QUADRATURE) {
        const environmentSigma = environmentScenarioSigma;
        const environmentMultiplier = Math.exp(environmentNode.z * environmentSigma - 0.5 * environmentSigma * environmentSigma);
        const awayFirst5 = scenarioPmf(profile.first5.away * environmentMultiplier, awayScenarioSigma, awayNode.z, profile.dispersion.awayFirst5, 20);
        const homeFirst5 = scenarioPmf(profile.first5.home * environmentMultiplier, homeScenarioSigma, homeNode.z, profile.dispersion.homeFirst5, 20);
        const awayMiddle3 = scenarioPmf(profile.middle3.away * environmentMultiplier, awayScenarioSigma * 0.84, awayNode.z, profile.dispersion.awayMiddle3, 16);
        const homeMiddle3 = scenarioPmf(profile.middle3.home * environmentMultiplier, homeScenarioSigma * 0.84, homeNode.z, profile.dispersion.homeMiddle3, 16);
        const awayNinthMean = Math.max(0.05, profile.ninth.away * environmentMultiplier * Math.exp(awayNode.z * awayScenarioSigma * 0.62 - 0.5 * (awayScenarioSigma * 0.62) ** 2));
        const homeNinthMean = Math.max(0.05, profile.ninth.home * environmentMultiplier * Math.exp(homeNode.z * homeScenarioSigma * 0.62 - 0.5 * (homeScenarioSigma * 0.62) ** 2));
        scenarios.push({
          id: `GH13-${++index}-${awayNode.level}-${homeNode.level}-${environmentNode.level}`,
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
        });
      }
    }
  }
  const scenarioWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  const centralScenario = scenarios.find(scenario => scenario.shocks.away === 0 && scenario.shocks.home === 0 && scenario.shocks.environment === 0) || scenarios[0];
  const linkedPathAudit = linkedPathMomentsForScenarioV13(centralScenario);
  const compact = {
    version: JOINT_SCORE_V13_VERSION,
    gameStateVersion: GAME_STATE_V13_VERSION,
    starterBullpenHandoffVersion: STARTER_BULLPEN_HANDOFF_V13_VERSION,
    quadratureVersion: SCENARIO_QUADRATURE_V13_VERSION,
    runProfileVersion: profile.version,
    jointPathVersion: 'F5_TO_6_8_TO_STATE_AWARE_9TH_TO_EXTRAS-v1.0.0',
    modelVersion,
    rulesVersion,
    gamePk: context?.game?.gamePk || null,
    profile,
    scenarios,
    scenarioWeight,
    exactDistribution: true,
    linkedSegmentPath: true,
    linkedPathAudit,
    scenarioSigmaScale: STATE_AWARE_SCENARIO_SIGMA_SCALE,
    stateAwareBottomNinth: true,
    stateAwareWalkoff: true,
    simulationsPerScenario: 0,
    targetMarketCalibrationApplied: false,
    legacyDistributionUsed: false,
  };
  const distributionHash = sha256(compact);
  return {
    ...compact,
    distributionId: `${context?.game?.gamePk || 'game'}:${distributionHash.slice(0, 20)}`,
    distributionHash,
  };
}
