import { sha256 } from './snapshot-v9.js';

export const JOINT_SCORE_V11_VERSION = 'BASEBALL-EXACT-JOINT-SCORE-2026-08-v10.1.0';
export const SCENARIO_QUADRATURE_VERSION = 'GAUSS-HERMITE-3X3X3-v1.0.0';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function pmfSum(rows) {
  return (rows || []).reduce((sum, row) => sum + Number(row?.[1] || 0), 0);
}

export function negativeBinomialPmf(mean, dispersion, maximum = 30) {
  const mu = Math.max(0.001, finite(mean, 0.001));
  const k = clamp(finite(dispersion, 7), 1.25, 80);
  const probabilityOfSuccess = k / (k + mu);
  const failureProbability = mu / (k + mu);
  const rows = [];
  let probability = Math.pow(probabilityOfSuccess, k);
  let cumulative = 0;
  for (let runs = 0; runs <= maximum; runs += 1) {
    if (runs > 0) probability *= ((runs - 1 + k) / runs) * failureProbability;
    const value = Math.max(0, probability);
    rows.push([runs, value]);
    cumulative += value;
  }
  const tail = Math.max(0, 1 - cumulative);
  rows[rows.length - 1][1] += tail;
  const normalization = pmfSum(rows) || 1;
  return rows.map(([runs, probabilityValue]) => [runs, probabilityValue / normalization]);
}

function scheduleDispersion(team, segmentFraction = 1) {
  const mean = Math.max(0.25, finite(team?.scoring?.meanRuns, 4.4) * segmentFraction);
  const variance = Math.max(mean + 0.05, finite(team?.scoring?.varianceRuns, mean * 1.35) * segmentFraction);
  const implied = mean * mean / Math.max(0.05, variance - mean);
  return clamp(implied, segmentFraction < 0.7 ? 2.2 : 3.0, 18);
}

function sampleReliability(sampleSize, target) {
  const sample = Math.max(0, finite(sampleSize, 0));
  return clamp(sample / (sample + target), 0, 0.92);
}

function blendLogFactor(rawFactor, reliability, cap = 0.22) {
  const safeFactor = clamp(finite(rawFactor, 1), 0.55, 1.75);
  return Math.exp(clamp(Math.log(safeFactor) * reliability, -cap, cap));
}

function offenseFactor(team, league) {
  const leagueRuns = Math.max(0.5, finite(league?.runsPerTeamGame, 4.4));
  const seasonRuns = Math.max(0.5, finite(team?.hitting?.runsPerGame, leagueRuns));
  const recentRuns = Math.max(0.5, finite(team?.recentHitting?.runsPerGame, seasonRuns));
  const leagueOps = Math.max(0.4, finite(league?.ops, 0.72));
  const seasonOps = Math.max(0.4, finite(team?.hitting?.ops, leagueOps));
  const recentOps = Math.max(0.4, finite(team?.recentHitting?.ops, seasonOps));
  const seasonReliability = sampleReliability(team?.hitting?.games, 45);
  const recentReliability = sampleReliability(team?.recentHitting?.games, 18) * 0.45;
  const runFactor = blendLogFactor(seasonRuns / leagueRuns, seasonReliability, 0.18);
  const recentRunFactor = blendLogFactor(recentRuns / leagueRuns, recentReliability, 0.10);
  const opsFactor = blendLogFactor(seasonOps / leagueOps, seasonReliability * 0.45, 0.08);
  const recentOpsFactor = blendLogFactor(recentOps / leagueOps, recentReliability * 0.35, 0.06);
  return clamp(Math.pow(runFactor, 0.55) * Math.pow(recentRunFactor, 0.20) * Math.pow(opsFactor, 0.17) * Math.pow(recentOpsFactor, 0.08), 0.78, 1.25);
}

function pitchingFactor(block, league, fallbackStatus = 'PROJECTED') {
  const leagueEra = Math.max(2.5, finite(league?.era, 4.25));
  const era = Math.max(1.5, finite(block?.era, leagueEra));
  const fip = Math.max(1.5, finite(block?.fip, era));
  const whip = Math.max(0.7, finite(block?.whip, finite(league?.whip, 1.30)));
  const leagueWhip = Math.max(0.8, finite(league?.whip, 1.30));
  const sample = finite(block?.inningsPitched, 0);
  const reliability = sampleReliability(sample, 45) * (block?.status === 'CONFIRMED' ? 1 : 0.82);
  const composite = Math.pow(era / leagueEra, 0.36) * Math.pow(fip / leagueEra, 0.44) * Math.pow(whip / leagueWhip, 0.20);
  return {
    factor: clamp(blendLogFactor(composite, reliability, 0.20), 0.78, 1.28),
    reliability,
    status: block?.status || fallbackStatus,
  };
}

function bullpenFactor(team, league) {
  const season = pitchingFactor(team?.pitching, league);
  const recent = pitchingFactor(team?.recentPitching, league);
  const recentWeight = sampleReliability(team?.recentPitching?.inningsPitched, 35) * 0.42;
  const value = Math.exp(Math.log(season.factor) * (1 - recentWeight) + Math.log(recent.factor) * recentWeight);
  return clamp(value, 0.80, 1.25);
}

function injuryFactor(team) {
  if (team?.injuriesAvailable === false) return 1.008;
  const rows = Array.isArray(team?.injuries) ? team.injuries : [];
  if (!rows.length) return 1;
  const positionWeight = row => {
    const position = String(row?.position || '').toUpperCase();
    if (/^P|SP|RP/.test(position)) return 0.0015;
    if (/C|SS|CF/.test(position)) return 0.0025;
    return 0.002;
  };
  return clamp(1 + rows.reduce((sum, row) => sum + positionWeight(row), 0), 1, 1.025);
}

function statusUncertainty(status, confirmed = 0.035, projected = 0.065, missing = 0.10) {
  if (status === 'CONFIRMED') return confirmed;
  if (status === 'PROJECTED') return projected;
  return missing;
}

export function estimateRunProfileV11(context) {
  const league = context?.league || {};
  const away = context?.away || {};
  const home = context?.home || {};
  const baseline = clamp(finite(league.runsPerTeamGame, 4.4), 3.4, 5.5);
  const park = clamp(finite(context?.park?.runFactor, 1), 0.88, 1.15);
  const weather = clamp(finite(context?.weather?.meanRunFactor, context?.weather?.meanRunFactorV10 ?? 1), 0.93, 1.08);
  const environment = clamp(park * weather, 0.84, 1.20);
  const homeAdvantage = 1.018;

  const awayOffense = offenseFactor(away, league);
  const homeOffense = offenseFactor(home, league);
  const awayStarter = pitchingFactor(away?.starter, league);
  const homeStarter = pitchingFactor(home?.starter, league);
  const awayBullpen = bullpenFactor(away, league);
  const homeBullpen = bullpenFactor(home, league);
  const awayInjury = injuryFactor(away);
  const homeInjury = injuryFactor(home);

  const awayFirst5 = clamp(baseline * (5 / 9) * awayOffense * homeStarter.factor * environment * awayInjury, 1.15, 4.2);
  const homeFirst5 = clamp(baseline * (5 / 9) * homeOffense * awayStarter.factor * environment * homeInjury * homeAdvantage, 1.15, 4.35);
  const awayLate = clamp(baseline * (4 / 9) * awayOffense * homeBullpen * environment * awayInjury, 0.9, 3.5);
  const homeLate = clamp(baseline * (4 / 9) * homeOffense * awayBullpen * environment * homeInjury * homeAdvantage, 0.9, 3.6);

  const awayDataSigma = Math.sqrt(
    statusUncertainty(away?.hitting?.status, 0.025, 0.045, 0.08) ** 2
    + statusUncertainty(home?.starter?.status, 0.035, 0.065, 0.10) ** 2
    + statusUncertainty(home?.recentPitching?.status, 0.03, 0.055, 0.085) ** 2,
  );
  const homeDataSigma = Math.sqrt(
    statusUncertainty(home?.hitting?.status, 0.025, 0.045, 0.08) ** 2
    + statusUncertainty(away?.starter?.status, 0.035, 0.065, 0.10) ** 2
    + statusUncertainty(away?.recentPitching?.status, 0.03, 0.055, 0.085) ** 2,
  );
  const environmentSigma = Math.sqrt(
    statusUncertainty(context?.park?.factorStatus, 0.018, 0.035, 0.055) ** 2
    + statusUncertainty(context?.weather?.status, 0.018, 0.04, 0.065) ** 2,
  );

  return {
    baseline,
    first5: { away: awayFirst5, home: homeFirst5 },
    late: { away: awayLate, home: homeLate },
    full: { away: awayFirst5 + awayLate, home: homeFirst5 + homeLate },
    dispersion: {
      awayFirst5: scheduleDispersion(away, 5 / 9),
      homeFirst5: scheduleDispersion(home, 5 / 9),
      awayLate: scheduleDispersion(away, 4 / 9),
      homeLate: scheduleDispersion(home, 4 / 9),
    },
    uncertainty: {
      away: clamp(awayDataSigma, 0.045, 0.16),
      home: clamp(homeDataSigma, 0.045, 0.16),
      environment: clamp(environmentSigma, 0.025, 0.10),
    },
    components: {
      awayOffense, homeOffense,
      awayStarter: awayStarter.factor, homeStarter: homeStarter.factor,
      awayBullpen, homeBullpen,
      awayInjury, homeInjury,
      park, weather, environment, homeAdvantage,
    },
    statuses: context?.sourceStatuses || {},
  };
}

const QUADRATURE = Object.freeze([
  Object.freeze({ z: -Math.sqrt(3), weight: 1 / 6, level: 'LOW' }),
  Object.freeze({ z: 0, weight: 2 / 3, level: 'BASE' }),
  Object.freeze({ z: Math.sqrt(3), weight: 1 / 6, level: 'HIGH' }),
]);

function scenarioPmf(mean, sigma, shock, dispersion, maximum) {
  const adjustedMean = Math.max(0.05, mean * Math.exp(shock * sigma));
  return { mean: adjustedMean, pmf: negativeBinomialPmf(adjustedMean, dispersion, maximum) };
}

export function buildJointScoreSnapshotV11({ context, modelVersion, rulesVersion }) {
  const profile = estimateRunProfileV11(context);
  const scenarios = [];
  let index = 0;
  for (const awayNode of QUADRATURE) {
    for (const homeNode of QUADRATURE) {
      for (const environmentNode of QUADRATURE) {
        const environmentShock = environmentNode.z * profile.uncertainty.environment;
        const environmentMultiplier = Math.exp(environmentShock);
        const awayFirst5 = scenarioPmf(profile.first5.away * environmentMultiplier, profile.uncertainty.away, awayNode.z, profile.dispersion.awayFirst5, 20);
        const homeFirst5 = scenarioPmf(profile.first5.home * environmentMultiplier, profile.uncertainty.home, homeNode.z, profile.dispersion.homeFirst5, 20);
        const awayLate = scenarioPmf(profile.late.away * environmentMultiplier, profile.uncertainty.away * 0.82, awayNode.z, profile.dispersion.awayLate, 20);
        const homeLate = scenarioPmf(profile.late.home * environmentMultiplier, profile.uncertainty.home * 0.82, homeNode.z, profile.dispersion.homeLate, 20);
        scenarios.push({
          id: `GH-${++index}-${awayNode.level}-${homeNode.level}-${environmentNode.level}`,
          weight: awayNode.weight * homeNode.weight * environmentNode.weight,
          shocks: { away: awayNode.z, home: homeNode.z, environment: environmentNode.z },
          means: {
            awayFirst5: awayFirst5.mean, homeFirst5: homeFirst5.mean,
            awayLate: awayLate.mean, homeLate: homeLate.mean,
          },
          pmf: {
            awayFirst5: awayFirst5.pmf,
            homeFirst5: homeFirst5.pmf,
            awayLate: awayLate.pmf,
            homeLate: homeLate.pmf,
          },
        });
      }
    }
  }
  const scenarioWeight = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  const compact = {
    version: JOINT_SCORE_V11_VERSION,
    quadratureVersion: SCENARIO_QUADRATURE_VERSION,
    modelVersion,
    rulesVersion,
    gamePk: context?.game?.gamePk || null,
    profile,
    scenarios,
    scenarioWeight,
    exactDistribution: true,
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

function convolve(left, right, maximum = 30) {
  const output = Array.from({ length: maximum + 1 }, () => 0);
  for (const [leftRuns, leftProbability] of left || []) {
    for (const [rightRuns, rightProbability] of right || []) {
      output[Math.min(maximum, leftRuns + rightRuns)] += leftProbability * rightProbability;
    }
  }
  const sum = output.reduce((total, value) => total + value, 0) || 1;
  return output.map((probability, runs) => [runs, probability / sum]).filter(([, probability]) => probability > 1e-14);
}

export function scoreDistributionForScenario(scenario, first5 = false) {
  const away = first5 ? scenario?.pmf?.awayFirst5 : convolve(scenario?.pmf?.awayFirst5, scenario?.pmf?.awayLate, 30);
  const home = first5 ? scenario?.pmf?.homeFirst5 : convolve(scenario?.pmf?.homeFirst5, scenario?.pmf?.homeLate, 30);
  const cells = [];
  let coverage = 0;
  for (const [awayRuns, awayProbability] of away || []) {
    for (const [homeRuns, homeProbability] of home || []) {
      const probability = awayProbability * homeProbability;
      if (probability <= 1e-15) continue;
      cells.push({ awayRuns, homeRuns, probability });
      coverage += probability;
    }
  }
  if (coverage > 0 && Math.abs(coverage - 1) > 1e-13) {
    for (const cell of cells) cell.probability /= coverage;
    coverage = 1;
  }
  return { cells, coverage };
}
