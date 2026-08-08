import {
  MARKET_ORDER,
  calculateProfit,
  hasActualWater,
  normalizeWater,
  outcomeFractionForScore,
  parseTaiwanLine,
  resultTag,
  scoreFromCompositeEV,
} from './markets.js';

export const MODEL_VERSION = 'GPT完整聯合情境模型-2026-08-v6';
export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v6';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const safe = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const logit = value => {
  const p = clamp(safe(value, 0.5), 0.001, 0.999);
  return Math.log(p / (1 - p));
};
const logistic = value => 1 / (1 + Math.exp(-value));

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(random) {
  const first = Math.max(random(), 1e-12);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function poissonSample(lambda, random) {
  const rate = clamp(safe(lambda, 0), 0, 9);
  if (rate <= 0) return 0;
  const limit = Math.exp(-rate);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= Math.max(random(), 1e-12);
  } while (product > limit && count < 35);
  return count - 1;
}

function blend(first, second, secondWeight = 0.3, fallback = 1) {
  const left = safe(first, fallback);
  const right = safe(second, left);
  return left * (1 - secondWeight) + right * secondWeight;
}

function sampleWeight(sample, target, minimum = 0.05, maximum = 0.30) {
  return clamp(safe(sample, 0) / target, minimum, maximum);
}

function ratio(value, baseline, minimum = 0.75, maximum = 1.30) {
  return clamp(safe(value, baseline) / baseline, minimum, maximum);
}

function geometricBlend(components) {
  let totalWeight = 0;
  let totalLog = 0;
  for (const [value, weight] of components) {
    if (!Number.isFinite(Number(value)) || weight <= 0) continue;
    totalWeight += weight;
    totalLog += Math.log(clamp(Number(value), 0.15, 6)) * weight;
  }
  return totalWeight > 0 ? clamp(Math.exp(totalLog / totalWeight), 0.55, 1.75) : 1;
}

function offenseProfile(team, opposingStarter) {
  const season = team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const recentWeight = sampleWeight(recent.gamesPlayed, 45, 0.08, 0.28);
  const runs = blend(season.runsPerGame, recent.runsPerGame, recentWeight, 4.35);
  const ops = blend(season.ops, recent.ops, recentWeight * 0.9, 0.72);
  const iso = blend(season.iso, recent.iso, recentWeight * 0.75, 0.15);
  const kRate = blend(season.kRate, recent.kRate, recentWeight * 0.65, 0.225);
  const bbRate = blend(season.bbRate, recent.bbRate, recentWeight * 0.65, 0.085);
  const split = opposingStarter?.throws === 'L' ? team?.vsLeft : team?.vsRight;
  const splitWeight = split?.available ? 0.13 : 0;
  const lineupIndex = clamp(safe(team?.lineup?.offensiveIndex, 1), 0.86, 1.14);
  const runningIndex = clamp(safe(team?.baserunning?.runIndex, 1), 0.96, 1.04);
  const injuryPenalty = Math.min(0.045, safe(team?.injuryImpact, 0));

  const factor = geometricBlend([
    [ratio(runs, 4.35, 0.76, 1.27), 0.32],
    [ratio(ops, 0.72, 0.80, 1.23), 0.27],
    [ratio(iso, 0.15, 0.80, 1.23), 0.09],
    [Math.exp(-(kRate - 0.225) * 0.9), 0.07],
    [Math.exp((bbRate - 0.085) * 0.8), 0.06],
    [ratio(split?.ops, 0.72, 0.84, 1.18), splitWeight],
    [lineupIndex, 0.15],
    [runningIndex, 0.04],
  ]) * (1 - injuryPenalty);

  const lineupStatus = team?.lineup?.official ? '已確認' : team?.lineup?.projected ? '預估' : '未知';
  const lineupUncertainty = team?.lineup?.official ? 0.035 : team?.lineup?.projected ? 0.075 : 0.12;
  const splitUncertainty = split?.available ? 0.025 : 0.055;
  const recentUncertainty = recent.gamesPlayed >= 8 ? 0.025 : 0.055;

  return {
    factor: clamp(factor, 0.76, 1.27),
    uncertainty: Math.sqrt(lineupUncertainty ** 2 + splitUncertainty ** 2 + recentUncertainty ** 2),
    status: lineupStatus,
    inputs: { runs, ops, iso, kRate, bbRate, splitOps: split?.available ? split.ops : null, lineupIndex, runningIndex, injuryPenalty },
  };
}

function starterProfile(starter) {
  if (!starter?.available) {
    return { factor: 1, expectedInnings: 4.8, uncertainty: 0.17, status: '未知', inputs: {} };
  }
  const season = starter.season || {};
  const recent = starter.recent || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.06, 0.28);
  const era = blend(season.era, recent.era, recentWeight, 4.2);
  const fip = blend(season.fip, recent.fip, recentWeight * 0.8, era);
  const whip = blend(season.whip, recent.whip, recentWeight, 1.3);
  const kMinusBB = blend(season.kMinusBB, recent.kMinusBB, recentWeight * 0.8, 0.14);
  const hrPer9 = blend(season.hrPer9, recent.hrPer9, recentWeight * 0.7, 1.15);
  const pitchQuality = clamp(safe(starter?.pitchQuality?.runFactor, 1), 0.88, 1.12);

  const factor = geometricBlend([
    [ratio(era, 4.2, 0.70, 1.42), 0.29],
    [ratio(fip, 4.2, 0.72, 1.38), 0.25],
    [ratio(whip, 1.3, 0.76, 1.32), 0.19],
    [Math.exp(-(kMinusBB - 0.14) * 1.9), 0.16],
    [ratio(hrPer9, 1.15, 0.72, 1.42), 0.07],
    [pitchQuality, 0.04],
  ]);

  const gamesStarted = Math.max(1, safe(season.gamesStarted, safe(recent.gamesStarted, 1)));
  const seasonLength = safe(season.inningsPitched, 0) / gamesStarted;
  const recentStarts = Math.max(1, safe(recent.gamesStarted, 0));
  const recentLength = recentStarts > 0 ? safe(recent.inningsPitched, 0) / recentStarts : seasonLength;
  const expectedInnings = clamp(safe(starter.expectedInnings, blend(seasonLength, recentLength, 0.35, 5.2)), 3.2, 7.2);
  const sample = safe(season.inningsPitched, 0);
  const sampleUncertainty = sample >= 100 ? 0.045 : sample >= 50 ? 0.065 : sample >= 20 ? 0.09 : 0.13;
  const arsenalUncertainty = starter?.pitchQuality?.available ? 0.025 : 0.055;
  const confirmationUncertainty = starter?.confirmed === false ? 0.055 : 0.015;

  return {
    factor: clamp(factor, 0.70, 1.40),
    expectedInnings,
    uncertainty: Math.sqrt(sampleUncertainty ** 2 + arsenalUncertainty ** 2 + confirmationUncertainty ** 2),
    status: starter?.confirmed === false ? '預估' : '已確認',
    inputs: { era, fip, whip, kMinusBB, hrPer9, pitchQuality, expectedInnings },
  };
}

function bullpenProfile(team) {
  const season = team?.seasonPitching || {};
  const recent = team?.recentPitching || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.08, 0.24);
  const era = blend(season.era, recent.era, recentWeight, 4.2);
  const whip = blend(season.whip, recent.whip, recentWeight, 1.3);
  const fatigue = clamp(safe(team?.bullpen?.fatigueIndex, 0.2), 0, 1);
  const leverageAvailability = clamp(safe(team?.bullpen?.highLeverageAvailability, 0.75), 0, 1);
  const factor = geometricBlend([
    [ratio(era, 4.2, 0.78, 1.30), 0.46],
    [ratio(whip, 1.3, 0.82, 1.24), 0.25],
    [1 + fatigue * 0.17, 0.19],
    [1 + (1 - leverageAvailability) * 0.13, 0.10],
  ]);
  const usageKnown = Boolean(team?.bullpen?.usageAvailable);
  return {
    factor: clamp(factor, 0.77, 1.34),
    uncertainty: usageKnown ? 0.055 + fatigue * 0.035 : 0.105,
    status: usageKnown ? '已確認' : '預估',
    inputs: { era, whip, fatigue, leverageAvailability },
  };
}

function defenseProfile(team) {
  const fielding = team?.defense || {};
  if (!fielding.available) return { factor: 1, uncertainty: 0.035, status: '未知' };
  const fieldingPercentage = safe(fielding.fieldingPercentage, 0.985);
  const errorsPerGame = safe(fielding.errorsPerGame, 0.55);
  const factor = clamp(1 - (fieldingPercentage - 0.985) * 3.5 + (errorsPerGame - 0.55) * 0.018, 0.96, 1.04);
  return { factor, uncertainty: 0.018, status: '已確認' };
}

function restProfile(team) {
  const rest = team?.rest || {};
  const days = safe(rest.days, 1);
  const travelKm = safe(rest.travelKm, 0);
  const extra = rest.previousExtraInnings ? 1 : 0;
  const dayNight = rest.dayNightTransition ? 1 : 0;
  const factor = clamp(1 + (days >= 2 ? 0.008 : 0) - (days <= 0 ? 0.018 : 0) - Math.min(travelKm / 120000, 0.02) - extra * 0.008 - dayNight * 0.005, 0.955, 1.025);
  return { factor, uncertainty: rest.available === false ? 0.025 : 0.012, status: rest.available === false ? '預估' : '已確認' };
}

function environmentProfile(context) {
  const park = clamp(safe(context?.park?.runFactor, 1), 0.86, 1.20);
  const weather = context?.weather || {};
  const temperature = safe(weather.temperature, 21);
  const roof = context?.park?.roof || 'unknown';
  const closedProbability = clamp(safe(weather.roofClosedProbability, roof === 'dome' ? 1 : roof === 'open' ? 0 : 0.35), 0, 1);
  const openTemperatureFactor = clamp(1 + (temperature - 21) * 0.0024, 0.94, 1.06);
  const temperatureFactor = closedProbability * 1 + (1 - closedProbability) * openTemperatureFactor;
  const factor = clamp(park * temperatureFactor, 0.86, 1.20);
  const windSpeed = safe(weather.windSpeed, 0);
  const precipitation = safe(weather.precipitationProbability, 0);
  const weatherKnown = Boolean(weather.available);
  const roofUncertainty = roof === 'retractable' && !weather.roofConfirmed ? 0.045 : roof === 'unknown' ? 0.04 : 0.015;
  const windUncertainty = Math.min(0.065, windSpeed / 450);
  const rainUncertainty = Math.min(0.04, precipitation / 2500);
  return {
    factor,
    uncertainty: weatherKnown ? Math.sqrt(0.02 ** 2 + roofUncertainty ** 2 + windUncertainty ** 2 + rainUncertainty ** 2) : 0.11,
    status: weatherKnown ? (weather.roofConfirmed || roof === 'open' || roof === 'dome' ? '已確認' : '預估') : '未知',
    inputs: { park, temperature, windSpeed, precipitation, closedProbability },
  };
}

function gameContextProfile(context) {
  const awayStarter = starterProfile(context?.away?.starter);
  const homeStarter = starterProfile(context?.home?.starter);
  const awayOffense = offenseProfile(context?.away, context?.home?.starter);
  const homeOffense = offenseProfile(context?.home, context?.away?.starter);
  const awayBullpen = bullpenProfile(context?.away);
  const homeBullpen = bullpenProfile(context?.home);
  const awayDefense = defenseProfile(context?.away);
  const homeDefense = defenseProfile(context?.home);
  const awayRest = restProfile(context?.away);
  const homeRest = restProfile(context?.home);
  const environment = environmentProfile(context);
  const umpireKnown = Boolean(context?.umpire?.name || (typeof context?.umpire === 'string' && context.umpire));
  const catcherKnown = Boolean(context?.away?.lineup?.catcher && context?.home?.lineup?.catcher);
  const umpireCatcherUncertainty = Math.sqrt((umpireKnown ? 0.018 : 0.035) ** 2 + (catcherKnown ? 0.015 : 0.03) ** 2);

  const baseline = clamp(safe(context?.league?.runsPerTeamGame, 4.35), 3.9, 4.8);
  const awayStarterShareFull = clamp(homeStarter.expectedInnings / 9, 0.35, 0.80);
  const homeStarterShareFull = clamp(awayStarter.expectedInnings / 9, 0.35, 0.80);
  const awayStarterShareF5 = clamp(homeStarter.expectedInnings / 5, 0.55, 1);
  const homeStarterShareF5 = clamp(awayStarter.expectedInnings / 5, 0.55, 1);

  const awayPitchFull = geometricBlend([[homeStarter.factor, awayStarterShareFull], [homeBullpen.factor, 1 - awayStarterShareFull]]);
  const homePitchFull = geometricBlend([[awayStarter.factor, homeStarterShareFull], [awayBullpen.factor, 1 - homeStarterShareFull]]);
  const awayPitchF5 = geometricBlend([[homeStarter.factor, awayStarterShareF5], [homeBullpen.factor, 1 - awayStarterShareF5]]);
  const homePitchF5 = geometricBlend([[awayStarter.factor, homeStarterShareF5], [awayBullpen.factor, 1 - homeStarterShareF5]]);

  const homeAdvantageFull = 1.025;
  const homeAdvantageF5 = 1.012;
  const shrink = 0.78;
  const awayRawFull = baseline * awayOffense.factor * awayPitchFull * homeDefense.factor * awayRest.factor * environment.factor;
  const homeRawFull = baseline * homeOffense.factor * homePitchFull * awayDefense.factor * homeRest.factor * environment.factor * homeAdvantageFull;
  const awayRawF5 = baseline * (5 / 9) * awayOffense.factor * awayPitchF5 * homeDefense.factor * awayRest.factor * environment.factor;
  const homeRawF5 = baseline * (5 / 9) * homeOffense.factor * homePitchF5 * awayDefense.factor * homeRest.factor * environment.factor * homeAdvantageF5;

  const full = {
    away: clamp(baseline + (awayRawFull - baseline) * shrink, 2.25, 7.15),
    home: clamp(baseline + (homeRawFull - baseline) * shrink, 2.25, 7.15),
  };
  const first5Baseline = baseline * (5 / 9);
  const first5 = {
    away: clamp(first5Baseline + (awayRawF5 - first5Baseline) * shrink, 0.75, 4.45),
    home: clamp(first5Baseline + (homeRawF5 - first5Baseline) * shrink, 0.75, 4.45),
  };

  const awayEarlyUncertainty = Math.sqrt(awayOffense.uncertainty ** 2 + homeStarter.uncertainty ** 2 + environment.uncertainty ** 2 + umpireCatcherUncertainty ** 2);
  const homeEarlyUncertainty = Math.sqrt(homeOffense.uncertainty ** 2 + awayStarter.uncertainty ** 2 + environment.uncertainty ** 2 + umpireCatcherUncertainty ** 2);
  const awayLateUncertainty = Math.sqrt(awayOffense.uncertainty ** 2 + homeBullpen.uncertainty ** 2 + environment.uncertainty ** 2 + 0.035 ** 2);
  const homeLateUncertainty = Math.sqrt(homeOffense.uncertainty ** 2 + awayBullpen.uncertainty ** 2 + environment.uncertainty ** 2 + 0.035 ** 2);

  const statuses = {
    awayStarter: awayStarter.status,
    homeStarter: homeStarter.status,
    awayLineup: awayOffense.status,
    homeLineup: homeOffense.status,
    awayBullpen: awayBullpen.status,
    homeBullpen: homeBullpen.status,
    weatherRoof: environment.status,
    umpire: umpireKnown ? '已確認' : '未知',
    catcher: catcherKnown ? '已確認' : (context?.away?.lineup?.projected || context?.home?.lineup?.projected ? '預估' : '未知'),
  };
  const statusValues = Object.values(statuses);
  const confirmed = statusValues.filter(value => value === '已確認').length;
  const estimated = statusValues.filter(value => value === '預估').length;
  const quality = clamp(0.50 + ((confirmed + estimated * 0.65) / statusValues.length) * 0.45, 0.50, 0.96);

  return {
    full,
    first5,
    earlyUncertainty: { away: clamp(awayEarlyUncertainty, 0.07, 0.25), home: clamp(homeEarlyUncertainty, 0.07, 0.25) },
    lateUncertainty: { away: clamp(awayLateUncertainty, 0.07, 0.25), home: clamp(homeLateUncertainty, 0.07, 0.25) },
    sharedEnvironmentUncertainty: clamp(environment.uncertainty, 0.025, 0.14),
    statuses,
    quality,
    components: {
      awayOffense, homeOffense, awayStarter, homeStarter, awayBullpen, homeBullpen,
      awayDefense, homeDefense, awayRest, homeRest, environment,
    },
  };
}

export function estimateRuns(context, first5 = false) {
  const profile = gameContextProfile(context);
  return first5 ? profile.first5 : profile.full;
}

function scenarioGrid(profile) {
  const levels = [
    { z: -1, weight: 0.20 },
    { z: 0, weight: 0.60 },
    { z: 1, weight: 0.20 },
  ];
  const scenarios = [];
  let index = 0;
  for (const awayShock of levels) {
    for (const homeShock of levels) {
      for (const environmentShock of levels) {
        const environmentMultiplier = Math.exp(environmentShock.z * profile.sharedEnvironmentUncertainty);
        const awayEarly = profile.first5.away * Math.exp(awayShock.z * profile.earlyUncertainty.away) * environmentMultiplier;
        const homeEarly = profile.first5.home * Math.exp(homeShock.z * profile.earlyUncertainty.home) * environmentMultiplier;
        const awayLateBase = Math.max(0.25, profile.full.away - profile.first5.away);
        const homeLateBase = Math.max(0.25, profile.full.home - profile.first5.home);
        const awayLate = awayLateBase * Math.exp(awayShock.z * profile.lateUncertainty.away) * environmentMultiplier;
        const homeLate = homeLateBase * Math.exp(homeShock.z * profile.lateUncertainty.home) * environmentMultiplier;
        scenarios.push({
          id: `S${String(index + 1).padStart(2, '0')}`,
          weight: awayShock.weight * homeShock.weight * environmentShock.weight,
          shocks: { away: awayShock.z, home: homeShock.z, environment: environmentShock.z },
          means: {
            first5: { away: clamp(awayEarly, 0.55, 5), home: clamp(homeEarly, 0.55, 5) },
            late: { away: clamp(awayLate, 0.20, 4.8), home: clamp(homeLate, 0.20, 4.8) },
          },
        });
        index += 1;
      }
    }
  }
  return scenarios;
}

function addJointScore(map, awayFirst5, homeFirst5, awayRuns, homeRuns, amount = 1) {
  const key = `${Math.min(20, awayFirst5)}:${Math.min(20, homeFirst5)}:${Math.min(25, awayRuns)}:${Math.min(25, homeRuns)}`;
  map.set(key, (map.get(key) || 0) + amount);
}

function mapToJointCells(map, divisor = 1) {
  const cells = [];
  let sum = 0;
  for (const [key, value] of map.entries()) {
    const [awayFirst5, homeFirst5, awayRuns, homeRuns] = key.split(':').map(Number);
    const probability = value / divisor;
    sum += probability;
    cells.push({ awayFirst5, homeFirst5, awayRuns, homeRuns, probability });
  }
  if (sum <= 0) return [];
  return cells.map(cell => ({ ...cell, probability: cell.probability / sum }));
}

function simulateScenario(scenario, simulations, seed) {
  const random = seededRandom(seed);
  const joint = new Map();
  const awayEarlyRate = scenario.means.first5.away / 5;
  const homeEarlyRate = scenario.means.first5.home / 5;
  const awayLateRate = scenario.means.late.away / 4;
  const homeLateRate = scenario.means.late.home / 4;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const sharedGameFactor = Math.exp(normalSample(random) * 0.095 - 0.5 * 0.095 ** 2);
    const awayGameFactor = Math.exp(normalSample(random) * 0.075 - 0.5 * 0.075 ** 2);
    const homeGameFactor = Math.exp(normalSample(random) * 0.075 - 0.5 * 0.075 ** 2);
    let awayRuns = 0;
    let homeRuns = 0;

    for (let inning = 1; inning <= 5; inning += 1) {
      awayRuns += poissonSample(awayEarlyRate * sharedGameFactor * awayGameFactor, random);
      homeRuns += poissonSample(homeEarlyRate * sharedGameFactor * homeGameFactor, random);
    }
    const awayFirst5 = awayRuns;
    const homeFirst5 = homeRuns;

    for (let inning = 6; inning <= 8; inning += 1) {
      awayRuns += poissonSample(awayLateRate * sharedGameFactor * awayGameFactor, random);
      homeRuns += poissonSample(homeLateRate * sharedGameFactor * homeGameFactor, random);
    }

    awayRuns += poissonSample(awayLateRate * sharedGameFactor * awayGameFactor, random);
    if (homeRuns <= awayRuns) {
      const bottomRuns = poissonSample(homeLateRate * sharedGameFactor * homeGameFactor, random);
      const needed = awayRuns - homeRuns + 1;
      if (bottomRuns >= needed) {
        homeRuns += needed + (bottomRuns > needed && random() < 0.18 ? bottomRuns - needed : 0);
      } else {
        homeRuns += bottomRuns;
      }
    }

    let extraInning = 0;
    while (awayRuns === homeRuns && extraInning < 12) {
      extraInning += 1;
      awayRuns += poissonSample((awayLateRate * 1.32 + 0.16) * sharedGameFactor * awayGameFactor, random);
      const homeRunsThisInning = poissonSample((homeLateRate * 1.32 + 0.16) * sharedGameFactor * homeGameFactor, random);
      const needed = awayRuns - homeRuns + 1;
      if (homeRunsThisInning >= needed) homeRuns += needed;
      else homeRuns += homeRunsThisInning;
    }
    if (awayRuns === homeRuns) {
      if (random() < 0.48) awayRuns += 1;
      else homeRuns += 1;
    }

    addJointScore(joint, awayFirst5, homeFirst5, awayRuns, homeRuns);
  }

  return mapToJointCells(joint, simulations);
}

function combinedJoint(scenarios) {
  const map = new Map();
  for (const scenario of scenarios) {
    for (const cell of scenario.joint) {
      addJointScore(map, cell.awayFirst5, cell.homeFirst5, cell.awayRuns, cell.homeRuns, cell.probability * scenario.weight);
    }
  }
  return mapToJointCells(map, 1);
}

function distributionForMarket(jointCells, market) {
  const first5 = market.includes('上半');
  return jointCells.map(cell => ({
    awayRuns: first5 ? cell.awayFirst5 : cell.awayRuns,
    homeRuns: first5 ? cell.homeFirst5 : cell.homeRuns,
    probability: cell.probability,
  }));
}

function summarizeDistribution({ cells, pick, water, context, rebateRate }) {
  const result = {
    fullWin: 0,
    partialWin: 0,
    push: 0,
    partialLoss: 0,
    fullLoss: 0,
    equivalentWin: 0,
    equivalentLoss: 0,
    coverage: 0,
    ev: 0,
    exactLineProbability: 0,
  };
  const parsed = parseTaiwanLine(pick);

  for (const cell of cells) {
    const probability = safe(cell.probability, 0);
    const fraction = outcomeFractionForScore(parsed, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
    if (fraction == null) continue;
    result.coverage += probability;
    if (fraction >= 0.999) result.fullWin += probability;
    else if (fraction > 0) result.partialWin += probability;
    else if (fraction <= -0.999) result.fullLoss += probability;
    else if (fraction < 0) result.partialLoss += probability;
    else result.push += probability;
    result.equivalentWin += probability * Math.max(0, fraction);
    result.equivalentLoss += probability * Math.max(0, -fraction);
    result.ev += probability * calculateProfit({ stake: 1, water, fraction, rebateRate }).profit;

    if (parsed.legs.length === 1) {
      if (parsed.isTotal && cell.awayRuns + cell.homeRuns === parsed.legs[0]) result.exactLineProbability += probability;
      if (!parsed.isTotal) {
        const selected = outcomeFractionForScore({ ...parsed, modifier: '平' }, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
        if (selected === 0) result.exactLineProbability += probability;
      }
    }
  }

  const resolved = result.equivalentWin + result.equivalentLoss;
  result.modelProbability = resolved > 1e-12 ? result.equivalentWin / resolved : 0.5;
  result.fairWater = result.equivalentWin > 1e-12
    ? clamp(((1 - rebateRate) * result.equivalentLoss / result.equivalentWin) - rebateRate, 0.5, 1.5)
    : 1.5;
  return result;
}

function normalizedWeights(rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map(row => ({ ...row, weight: total > 0 ? row.weight / total : 0 }));
}

function robustWeightSets(scenarios) {
  const make = (id, description, multiplier) => ({
    id,
    description,
    rows: normalizedWeights(scenarios.map(scenario => ({
      id: scenario.id,
      weight: scenario.weight * Math.max(0.08, multiplier(scenario)),
    }))),
  });
  return [
    make('central', '中央聯合情境', () => 1),
    make('away-favourable', '客隊整體偏好', scenario => Math.exp(0.65 * (scenario.shocks.away - scenario.shocks.home))),
    make('home-favourable', '主隊整體偏好', scenario => Math.exp(0.65 * (scenario.shocks.home - scenario.shocks.away))),
    make('run-high', '高得分壓力', scenario => Math.exp(0.75 * scenario.shocks.environment)),
    make('run-low', '低得分壓力', scenario => Math.exp(-0.75 * scenario.shocks.environment)),
    make('away-stress', '客隊打線／投手壓力', scenario => Math.exp(-0.75 * scenario.shocks.away)),
    make('home-stress', '主隊打線／投手壓力', scenario => Math.exp(-0.75 * scenario.shocks.home)),
  ];
}

function robustFromScenarioEVs(scenarioEVs, weightSets) {
  const byId = new Map(scenarioEVs.map(row => [row.id, row.value]));
  const variants = weightSets.map(set => ({
    id: set.id,
    description: set.description,
    value: set.rows.reduce((sum, row) => sum + row.weight * safe(byId.get(row.id), 0), 0),
  })).sort((left, right) => left.value - right.value);
  return { robustEV: variants[0]?.value ?? 0, worstVariant: variants[0] || null, variants };
}

function weightedQuantile(values, quantile) {
  const sorted = values.filter(row => Number.isFinite(row.value) && row.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return 0;
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight / total;
    if (cumulative >= quantile) return row.value;
  }
  return sorted.at(-1).value;
}

function devigAnchor(rows, row) {
  const actual = rows.filter(item => hasActualWater(item.water) && !item.waterEstimated);
  if (actual.length !== 2) return null;
  const implied = actual.map(item => 1 / (1 + Number(item.water)));
  const total = implied[0] + implied[1];
  if (total <= 0) return null;
  const index = actual.indexOf(row);
  return index >= 0 ? implied[index] / total : null;
}

function normalizedTeam(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function sameContractDirection(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick);
  const right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.isTotal !== right.isTotal) return false;
  if (left.isTotal) return (left.isOver && right.isOver) || (left.isUnder && right.isUnder);
  return normalizedTeam(left.team) === normalizedTeam(right.team);
}

function previousMarketRow(previousMarkets, row) {
  const candidates = (Array.isArray(previousMarkets) ? previousMarkets : [])
    .filter(previous => previous?.market === row.market && sameContractDirection(previous.pick, row.pick));
  return candidates.at(-1) || null;
}

function scenarioSensitivity(scenarioEVs, scenarios) {
  const valueById = new Map(scenarioEVs.map(row => [row.id, row.value]));
  const dimensions = [
    ['away', '客隊能力／名單'],
    ['home', '主隊能力／名單'],
    ['environment', '球場／天氣／屋頂'],
  ].map(([key, label]) => {
    const levels = [-1, 0, 1].map(level => {
      const rows = scenarios.filter(scenario => scenario.shocks[key] === level);
      const total = rows.reduce((sum, scenario) => sum + scenario.weight, 0);
      const value = total > 0
        ? rows.reduce((sum, scenario) => sum + scenario.weight * safe(valueById.get(scenario.id), 0), 0) / total
        : 0;
      return { level, value };
    });
    const values = levels.map(row => row.value);
    return { key, label, range: Math.max(...values) - Math.min(...values), levels };
  }).sort((left, right) => right.range - left.range);
  return {
    primary: dimensions[0]?.label || '',
    primaryRange: dimensions[0]?.range || 0,
    dimensions,
  };
}

function movementComparison({ previous, row, distribution, context, rebateRate, weightedEV }) {
  if (!previous) return { available: false, reason: '無可比較舊盤' };
  const lineChanged = String(previous.pick || '') !== String(row.pick || '');
  const previousHasWater = hasActualWater(previous.water);
  const currentHasWater = hasActualWater(row.water);
  const previousParsed = parseTaiwanLine(previous.pick);
  const currentParsed = parseTaiwanLine(row.pick);
  const previousLine = previousParsed.legs?.length ? previousParsed.legs.reduce((sum, value) => sum + value, 0) / previousParsed.legs.length : null;
  const currentLine = currentParsed.legs?.length ? currentParsed.legs.reduce((sum, value) => sum + value, 0) / currentParsed.legs.length : null;
  const crossedKeyNumbers = [];
  if (Number.isFinite(previousLine) && Number.isFinite(currentLine) && Math.abs(previousLine - currentLine) > 1e-9) {
    const keys = currentParsed.isTotal ? [6, 7, 8, 9, 10, 11, 12] : [0, 1, 2, 3, 4];
    const minimum = Math.min(previousLine, currentLine);
    const maximum = Math.max(previousLine, currentLine);
    for (const key of keys) if (key > minimum && key <= maximum) crossedKeyNumbers.push(key);
  }

  if (!previousHasWater) {
    return { available: true, previousPick: previous.pick, previousWater: null, lineChanged, crossedKeyNumbers, reason: '舊盤水位未提供，只比較盤口文字' };
  }
  const previousWater = normalizeWater(previous.water);
  const previousSummary = summarizeDistribution({ cells: distribution, pick: previous.pick, water: previousWater, context, rebateRate });
  const deltaEV = weightedEV - previousSummary.ev;
  return {
    available: true,
    previousPick: previous.pick,
    previousWater,
    lineChanged,
    waterChanged: currentHasWater && Math.abs(Number(row.water) - previousWater) > 1e-9,
    crossedKeyNumbers,
    previousWeightedEV: previousSummary.ev,
    deltaEV,
    verdict: deltaEV > 0.005 ? '目前價格比舊盤更有利' : deltaEV < -0.005 ? '目前價格比舊盤更差' : '與舊盤價值接近',
    method: '以目前資料與同一比分分布重算舊盤及新盤；盤口不同時只拆解價值變化，不宣稱正式 CLV',
  };
}

function scoreBand(score) {
  if (score == null) return '不評分';
  if (score >= 8.5) return '8.5+';
  if (score >= 8.0) return '8.0–8.4';
  if (score >= 7.5) return '7.5–7.9';
  if (score >= 7.2) return '7.2–7.4';
  if (score >= 6.7) return '6.7–7.1';
  return '≤6.6';
}

function unitSuggestion({ score, robustEV, flipProbability, quality, eligible }) {
  if (!eligible) return 0;
  let units = score >= 8.5 ? 1.25 : score >= 8.0 ? 1.0 : score >= 7.5 ? 0.75 : 0.5;
  if (robustEV < 0.01 || flipProbability > 0.25 || quality < 0.72) units = Math.min(units, 0.5);
  if (flipProbability < 0.08 && quality > 0.88 && robustEV > 0.055) units += 0.25;
  return clamp(Math.round(units * 4) / 4, 0.25, 1.5);
}

function buildRisks({ profile, flipProbability, robustEV, marketName, row }) {
  const risks = [];
  if (profile.statuses.awayLineup !== '已確認' || profile.statuses.homeLineup !== '已確認') risks.push('正式打線／輪休仍可能改變情境權重');
  if (profile.statuses.awayBullpen !== '已確認' || profile.statuses.homeBullpen !== '已確認') risks.push('牛棚逐投手可用性仍有估計誤差');
  if (profile.statuses.weatherRoof !== '已確認') risks.push('天氣／屋頂情境尚未完全確認');
  if (profile.statuses.umpire !== '已確認') risks.push('主審採中性分布');
  if (flipProbability > 0.20) risks.push(`EV 翻負機率約 ${(flipProbability * 100).toFixed(0)}%`);
  if (robustEV <= 0) risks.push('最不利合理情境已翻為非正 EV');
  if (marketName.includes('上半')) risks.push('前五局對先發臨場狀態與提前退場較敏感');
  if (row.waterEstimated) risks.push('水位為暫估，不可列入正式下注池');
  return risks.slice(0, 5);
}

function resultIntegrity({ summary, rows, marketAnchorProbability, scenarioEVs }) {
  const coverageInvalid = summary.coverage < 0.999;
  const scenarioInvalid = scenarioEVs.some(row => !Number.isFinite(row.value));
  const halfLineHasPush = parseTaiwanLine(rows[0]?.pick).legs?.every(line => Math.abs(line % 1) > 1e-9) && summary.push > 0.002;
  const extremeMismatch = marketAnchorProbability != null
    && marketAnchorProbability > 0.33 && marketAnchorProbability < 0.67
    && (summary.modelProbability < 0.025 || summary.modelProbability > 0.975);
  const warning = coverageInvalid || scenarioInvalid || halfLineHasPush || extremeMismatch;
  const message = coverageInvalid
    ? '比分分布覆蓋不足'
    : scenarioInvalid
      ? '情境 EV 計算異常'
      : halfLineHasPush
        ? '半分盤出現不應存在的走水機率'
        : extremeMismatch
          ? '模型與市場基準差距異常，封鎖正式下注'
          : '';
  return { warning, message };
}

function contractProfitOnJoint(result, cell, context, rebateRate) {
  const first5 = String(result.market || '').includes('上半');
  const awayRuns = first5 ? cell.awayFirst5 : cell.awayRuns;
  const homeRuns = first5 ? cell.homeFirst5 : cell.homeRuns;
  const fraction = outcomeFractionForScore(result.pick, awayRuns, homeRuns, context.game.away, context.game.home);
  if (fraction == null) return 0;
  return calculateProfit({ stake: 1, water: result.water, fraction, rebateRate }).profit;
}

function contractCorrelation(left, right, jointCells, context, rebateRate) {
  if (!jointCells?.length || !hasActualWater(left?.water) || !hasActualWater(right?.water)) return 0;
  let leftMean = 0;
  let rightMean = 0;
  const values = jointCells.map(cell => {
    const leftValue = contractProfitOnJoint(left, cell, context, rebateRate);
    const rightValue = contractProfitOnJoint(right, cell, context, rebateRate);
    leftMean += cell.probability * leftValue;
    rightMean += cell.probability * rightValue;
    return { probability: cell.probability, leftValue, rightValue };
  });
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const row of values) {
    const leftDelta = row.leftValue - leftMean;
    const rightDelta = row.rightValue - rightMean;
    covariance += row.probability * leftDelta * rightDelta;
    leftVariance += row.probability * leftDelta ** 2;
    rightVariance += row.probability * rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 1e-12 ? clamp(covariance / denominator, -1, 1) : 0;
}

function buildPortfolio(results, jointCells, context, rebateRate) {
  const eligible = results.filter(result => result.betEligible).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.conservativeEV - left.conservativeEV;
  });
  const portfolio = [];
  let totalUnits = 0;
  for (const result of eligible) {
    const primary = portfolio[0]?.result || null;
    const correlation = primary ? contractCorrelation(primary, result, jointCells, context, rebateRate) : 0;
    const role = !primary ? '主選' : correlation > 0.65 ? '備選' : '次選';
    let units = result.unitSuggestion;
    if (role === '備選') units = Math.min(units, 0.25);
    else if (role === '次選' && correlation > 0.35) units = Math.min(units, 0.5);
    units = Math.min(units, Math.max(0, 2.0 - totalUnits));
    if (units <= 0) continue;
    totalUnits += units;
    portfolio.push({ result, role, recommendedUnit: units, correlationToPrimary: correlation });
  }
  return portfolio.map(row => ({
    market: row.result.market,
    pick: row.result.pick,
    score: row.result.score,
    role: row.role,
    recommendedUnit: row.recommendedUnit,
    correlationToPrimary: row.correlationToPrimary,
  }));
}

export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {
  if (context?.coreModelable === false) throw new Error('資料不足｜不評分');
  const rebateRate = clamp(safe(settings.rebateRate, 0.015), 0, 0.1);
  const candidateThreshold = clamp(safe(settings.candidateThreshold, 7.2), 1, 9.4);
  const strongestThreshold = clamp(safe(settings.strongestThreshold, 8.5), 1, 9.4);
  const simulationsPerScenario = clamp(Math.round(safe(settings.simulationsPerScenario, 1800)), 500, 4000);
  const profile = gameContextProfile(context);
  const scenarioBase = scenarioGrid(profile);
  const seedBase = hashString(`${MODEL_VERSION}|${context?.game?.gamePk}|${context?.game?.away}|${context?.game?.home}`);
  const scenarios = scenarioBase.map((scenario, index) => ({
    ...scenario,
    joint: simulateScenario(scenario, simulationsPerScenario, seedBase ^ hashString(scenario.id) ^ Math.imul(index + 1, 2654435761)),
  }));
  const combinedJointCells = combinedJoint(scenarios);
  const robustSets = robustWeightSets(scenarios);
  const distributionId = `${context?.game?.gamePk || 'game'}-${MODEL_VERSION}-${seedBase.toString(16)}`;
  const snapshotId = `${distributionId}-${Date.now()}`;
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const rows = (Array.isArray(markets) ? markets : [])
      .filter(row => row?.market === marketName && String(row?.pick || '').trim())
      .slice(0, 2);
    if (!rows.length) continue;
    const combinedDistribution = distributionForMarket(combinedJointCells, marketName);

    for (const row of rows) {
      const hasWater = hasActualWater(row.water);
      const waterEstimated = Boolean(row.waterEstimated);
      const marketAnchorProbability = devigAnchor(rows, row);
      const previous = previousMarketRow(previousMarkets, row);

      if (!hasWater) {
        results.push({
          ...row,
          water: null,
          waterMissing: true,
          waterEstimated: false,
          score: null,
          tag: '水位未提供｜不評分',
          betEligible: false,
          modelProbability: null,
          rawModelProbability: null,
          marketAnchorProbability,
          weightedEV: null,
          robustEV: null,
          conservativeEV: null,
          ev: null,
          rawEV: null,
          evFlipProbability: null,
          distributionCoverage: 1,
          movement: { available: false, reason: '目前水位未提供' },
          distributionId,
          snapshotId,
          sourceStatuses: profile.statuses,
        });
        continue;
      }

      const water = normalizeWater(row.water);
      const weightedSummary = summarizeDistribution({ cells: combinedDistribution, pick: row.pick, water, context, rebateRate });
      const scenarioEVs = scenarios.map(scenario => ({
        id: scenario.id,
        weight: scenario.weight,
        value: summarizeDistribution({
          cells: distributionForMarket(scenario.joint, marketName),
          pick: row.pick,
          water,
          context,
          rebateRate,
        }).ev,
      }));
      const weightedEV = scenarioEVs.reduce((sum, scenario) => sum + scenario.weight * scenario.value, 0);
      const robust = robustFromScenarioEVs(scenarioEVs, robustSets);
      const quantileEV = weightedQuantile(scenarioEVs, 0.20);
      const conservativeEV = Math.min(quantileEV, robust.robustEV);
      const evFlipProbability = scenarioEVs.filter(scenario => scenario.value <= 0).reduce((sum, scenario) => sum + scenario.weight, 0);
      const sensitivity = scenarioSensitivity(scenarioEVs, scenarios);
      const integrity = resultIntegrity({ summary: weightedSummary, rows, marketAnchorProbability, scenarioEVs });
      const stability = clamp(1 - evFlipProbability - Math.min(0.35, sensitivity.primaryRange * 1.8), 0, 1);
      const edgeStrength = marketAnchorProbability == null
        ? clamp(logit(weightedSummary.modelProbability) / 3.5, -1, 1)
        : clamp((logit(weightedSummary.modelProbability) - logit(marketAnchorProbability)) / 1.25, -1, 1);
      const score = scoreFromCompositeEV(conservativeEV, {
        weightedEV,
        robustEV: robust.robustEV,
        flipProbability: evFlipProbability,
        quality: profile.quality,
        edgeStrength,
        stability,
        integrityWarning: integrity.warning,
        waterEstimated,
      });
      const eligibleByEV = weightedEV > 0 && robust.robustEV > 0;
      const betEligible = !waterEstimated && !integrity.warning && eligibleByEV && score >= candidateThreshold;
      const units = unitSuggestion({ score, robustEV: robust.robustEV, flipProbability: evFlipProbability, quality: profile.quality, eligible: betEligible });
      const movement = movementComparison({ previous, row, distribution: combinedDistribution, context, rebateRate, weightedEV });
      const risks = buildRisks({ profile, flipProbability: evFlipProbability, robustEV: robust.robustEV, marketName, row });

      results.push({
        ...row,
        water,
        waterMissing: false,
        waterEstimated,
        modelProbability: weightedSummary.modelProbability,
        rawModelProbability: weightedSummary.modelProbability,
        marketAnchorProbability,
        fairWater: weightedSummary.fairWater,
        fullWinProbability: weightedSummary.fullWin,
        partialWinProbability: weightedSummary.partialWin,
        pushProbability: weightedSummary.push,
        partialLossProbability: weightedSummary.partialLoss,
        fullLossProbability: weightedSummary.fullLoss,
        exactLineProbability: weightedSummary.exactLineProbability,
        distributionCoverage: weightedSummary.coverage,
        weightedEV,
        robustEV: robust.robustEV,
        conservativeEV,
        rawEV: weightedEV,
        ev: weightedEV,
        evFlipProbability,
        worstVariant: robust.worstVariant?.description || '',
        robustVariants: robust.variants,
        scenarioSensitivity: sensitivity,
        integrityWarning: integrity.warning,
        integrityMessage: integrity.message,
        confidence: profile.quality,
        score,
        scoreBand: scoreBand(score),
        tag: integrity.warning ? '模型異常｜不下注' : waterEstimated ? '暫估水位｜觀察' : resultTag(score, candidateThreshold, strongestThreshold),
        betEligible,
        unitSuggestion: units,
        primaryRisks: risks,
        movement,
        distributionId,
        snapshotId,
        sourceStatuses: profile.statuses,
      });
    }

    const pair = results.filter(result => result.market === marketName && result.modelProbability != null);
    if (pair.length === 2) {
      const complementError = Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1);
      if (complementError > 0.012) {
        for (const result of pair) {
          result.integrityWarning = true;
          result.integrityMessage = '同市場兩方向機率未互補';
          result.score = Math.min(result.score, 6.6);
          result.tag = '模型異常｜不下注';
          result.betEligible = false;
          result.unitSuggestion = 0;
        }
      }
      const eligiblePair = pair.filter(result => result.betEligible);
      if (eligiblePair.length > 1) {
        const keep = [...eligiblePair].sort((left, right) => right.conservativeEV - left.conservativeEV || right.score - left.score)[0];
        for (const result of eligiblePair) {
          if (result === keep) continue;
          result.betEligible = false;
          result.unitSuggestion = 0;
          result.tag = '同市場次選｜不重複下注';
        }
      }
    }
  }

  const portfolio = buildPortfolio(results, combinedJointCells, context, rebateRate);
  for (const result of results) {
    const portfolioRow = portfolio.find(row => row.market === result.market && row.pick === result.pick);
    result.portfolioRole = portfolioRow?.role || '';
    result.portfolioUnit = portfolioRow?.recommendedUnit || 0;
    result.correlationToPrimary = portfolioRow?.correlationToPrimary ?? null;
  }

  return {
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    snapshotId,
    distributionId,
    createdAt: new Date().toISOString(),
    analysisStatus: Object.values(profile.statuses).every(value => value === '已確認') ? '完整資料版' : '聯合情境版',
    dataQuality: profile.quality,
    expectedRuns: { full: profile.full, first5: profile.first5 },
    modelInputs: profile.components,
    sourceStatuses: profile.statuses,
    scenarioSummary: {
      count: scenarios.length,
      robustVariantCount: robustSets.length,
      simulationsPerScenario,
      totalSimulations: scenarios.length * simulationsPerScenario,
      conservativeQuantile: 0.20,
      sharedDistribution: true,
      jointPortfolioDistribution: true,
      jointCellCount: combinedJointCells.length,
    },
    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],
    warnings: Array.isArray(context?.warnings) ? context.warnings : [],
    portfolio,
    results,
  };
}
