import {
  MARKET_ORDER,
  calculateProfit,
  outcomeFractionForScore,
  parseTaiwanLine,
  resultTag,
  scoreFromEV,
  normalizeWater,
} from './markets.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const safe = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function poisson(lambda, max = 20) {
  const l = clamp(safe(lambda, 4.35), 0.35, 11);
  const probabilities = new Array(max + 1).fill(0);
  probabilities[0] = Math.exp(-l);
  for (let i = 1; i <= max; i += 1) probabilities[i] = probabilities[i - 1] * l / i;
  const sum = probabilities.reduce((a, b) => a + b, 0);
  probabilities[max] += Math.max(0, 1 - sum);
  return probabilities;
}

function blend(a, b, weightB = 0.3) {
  return safe(a, b) * (1 - weightB) + safe(b, a) * weightB;
}

function offenseFactor(team) {
  const season = team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const runs = blend(season.runsPerGame, recent.runsPerGame, recent.gamesPlayed >= 5 ? 0.32 : 0.14);
  const ops = blend(season.ops, recent.ops, recent.gamesPlayed >= 5 ? 0.28 : 0.1);
  return clamp(0.58 * (runs / 4.35) + 0.42 * (ops / 0.72), 0.82, 1.18);
}

function starterFactor(starter) {
  if (!starter?.available) return 1;
  const season = starter.season || {};
  const recent = starter.recent || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 8 ? 0.3 : 0.1);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 8 ? 0.25 : 0.08);
  const kbb = blend(season.kMinusBB, recent.kMinusBB, recent.inningsPitched >= 8 ? 0.22 : 0.06);
  return clamp(0.55 * (era / 4.2) + 0.33 * (whip / 1.3) + 0.12 * (1 - (kbb - 0.14)), 0.78, 1.3);
}

function bullpenFactor(team) {
  const season = team?.seasonPitching || {};
  const recent = team?.recentPitching || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 15 ? 0.28 : 0.1);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 15 ? 0.24 : 0.08);
  const fatigue = clamp(safe(team?.bullpen?.fatigueIndex, 0), 0, 1);
  return clamp(0.62 * (era / 4.2) + 0.38 * (whip / 1.3) + fatigue * 0.08, 0.86, 1.18);
}

function platoonFactor(team, opposingStarter) {
  const hand = opposingStarter?.throws;
  if (!hand) return 1;
  const split = hand === 'L' ? team?.vsLeft : team?.vsRight;
  if (!split?.available) return 1;
  return clamp(safe(split.ops, 0.72) / 0.72, 0.92, 1.08);
}

function lineupFactor(team) {
  const lineup = team?.lineup || {};
  const injuries = Array.isArray(team?.injuries) ? team.injuries.length : 0;
  const lineupPenalty = lineup.official ? clamp(safe(lineup.missingCoreCount, 0), 0, 5) * 0.018 : 0;
  const injuryPenalty = Math.min(injuries, 5) * 0.003;
  return clamp(1 - lineupPenalty - injuryPenalty, 0.93, 1.02);
}

function restFactor(team) {
  const rest = safe(team?.rest?.days, 1);
  const travelKm = safe(team?.rest?.travelKm, 0);
  const extra = team?.rest?.previousExtraInnings ? 1 : 0;
  return clamp(1 + (rest >= 2 ? 0.008 : 0) - (rest <= 0 ? 0.018 : 0) - Math.min(travelKm / 14000, 0.018) - extra * 0.01, 0.96, 1.025);
}

function environmentFactor(context) {
  const park = clamp(safe(context?.park?.runFactor, 1), 0.9, 1.14);
  const weather = context?.weather || {};
  const temperature = safe(weather.temperature, 20);
  const wind = safe(weather.windSpeed, 0);
  const roofClosed = ['closed', 'dome'].includes(context?.park?.roof);
  const weatherAdjustment = roofClosed ? 1 : clamp(1 + (temperature - 20) * 0.0018 + Math.min(wind, 30) * 0.0009, 0.96, 1.05);
  return clamp(park * weatherAdjustment, 0.9, 1.12);
}

export function estimateRuns(context, first5 = false) {
  const away = context.away;
  const home = context.home;
  const environment = environmentFactor(context);
  const awayPitch = first5 ? starterFactor(home.starter) : starterFactor(home.starter) * 0.64 + bullpenFactor(home) * 0.36;
  const homePitch = first5 ? starterFactor(away.starter) : starterFactor(away.starter) * 0.64 + bullpenFactor(away) * 0.36;
  const inningsScale = first5 ? 0.56 : 1;
  const baseline = 4.35 * inningsScale;
  const homeAdvantage = first5 ? 1.012 : 1.025;
  const rawAway = baseline * offenseFactor(away) * awayPitch * platoonFactor(away, home.starter) * lineupFactor(away) * restFactor(away) * environment;
  const rawHome = baseline * offenseFactor(home) * homePitch * platoonFactor(home, away.starter) * lineupFactor(home) * restFactor(home) * environment * homeAdvantage;
  const shrink = first5 ? 0.54 : 0.6;
  const awayRuns = baseline + (rawAway - baseline) * shrink;
  const homeRuns = baseline + (rawHome - baseline) * shrink;
  return {
    away: clamp(awayRuns, first5 ? 0.75 : 2.3, first5 ? 4.3 : 7.1),
    home: clamp(homeRuns, first5 ? 0.75 : 2.3, first5 ? 4.3 : 7.1),
  };
}

function contractDistribution({ pick, water, context, expectedRuns, rebateRate }) {
  const awayProbabilities = poisson(expectedRuns.away, 20);
  const homeProbabilities = poisson(expectedRuns.home, 20);
  const outcomes = { fullWin: 0, partialWin: 0, push: 0, partialLoss: 0, fullLoss: 0, equivalentWin: 0, equivalentLoss: 0, ev: 0 };
  for (let awayRuns = 0; awayRuns < awayProbabilities.length; awayRuns += 1) {
    for (let homeRuns = 0; homeRuns < homeProbabilities.length; homeRuns += 1) {
      const probability = awayProbabilities[awayRuns] * homeProbabilities[homeRuns];
      const fraction = outcomeFractionForScore(pick, awayRuns, homeRuns, context.game.away, context.game.home);
      if (fraction == null) continue;
      if (fraction >= 0.999) outcomes.fullWin += probability;
      else if (fraction > 0) outcomes.partialWin += probability;
      else if (fraction <= -0.999) outcomes.fullLoss += probability;
      else if (fraction < 0) outcomes.partialLoss += probability;
      else outcomes.push += probability;
      outcomes.equivalentWin += probability * Math.max(0, fraction);
      outcomes.equivalentLoss += probability * Math.max(0, -fraction);
      outcomes.ev += probability * calculateProfit({ stake: 1, water, fraction, rebateRate }).profit;
    }
  }
  return outcomes;
}

function dataQuality(context) {
  const checks = [
    context.away?.seasonHitting?.available,
    context.home?.seasonHitting?.available,
    context.away?.seasonPitching?.available,
    context.home?.seasonPitching?.available,
    context.away?.starter?.available,
    context.home?.starter?.available,
    context.weather?.available,
    context.game?.awayProbable && context.game?.homeProbable,
  ];
  const base = checks.filter(Boolean).length / checks.length;
  const lineupBonus = (context.away?.lineup?.official ? 0.03 : 0) + (context.home?.lineup?.official ? 0.03 : 0);
  return clamp(0.5 + base * 0.4 + lineupBonus, 0.5, 0.96);
}

function calibratedOutcomeMasses(raw, calibratedProbability) {
  const push = clamp(raw.push, 0, 1);
  const resolved = Math.max(0, 1 - push);
  const winMass = raw.fullWin + raw.partialWin;
  const lossMass = raw.fullLoss + raw.partialLoss;
  const targetWin = resolved * calibratedProbability;
  const targetLoss = resolved * (1 - calibratedProbability);
  return {
    fullWin: winMass > 0 ? targetWin * raw.fullWin / winMass : targetWin,
    partialWin: winMass > 0 ? targetWin * raw.partialWin / winMass : 0,
    push,
    partialLoss: lossMass > 0 ? targetLoss * raw.partialLoss / lossMass : 0,
    fullLoss: lossMass > 0 ? targetLoss * raw.fullLoss / lossMass : targetLoss,
  };
}

function marketAnchorProbability(rawProbability, quality, lineConfidence, marketName) {
  const upperMarket = marketName.includes('上半');
  const reliability = clamp(0.1 + (quality - 0.5) * 0.18 + lineConfidence * 0.04 - (upperMarket ? 0.015 : 0), 0.14, 0.26);
  const maximumRawEdge = upperMarket ? 0.16 : 0.18;
  const clippedRawEdge = clamp(rawProbability - 0.5, -maximumRawEdge, maximumRawEdge);
  return {
    probability: clamp(0.5 + clippedRawEdge * reliability, 0.44, 0.56),
    reliability,
    edgeClipped: Math.abs(rawProbability - 0.5) > maximumRawEdge + 1e-12,
  };
}

function calibrateContract({ raw, water, rebateRate, quality, rowConfidence, marketName }) {
  const resolvedEquivalent = raw.equivalentWin + raw.equivalentLoss;
  const rawProbability = resolvedEquivalent > 1e-12 ? raw.equivalentWin / resolvedEquivalent : 0.5;
  const lineConfidence = Number(rowConfidence) > 0 ? clamp(Number(rowConfidence), 0.35, 1) : 0.82;
  const anchor = marketAnchorProbability(rawProbability, quality, lineConfidence, marketName);
  const calibratedProbability = anchor.probability;
  const stressProbability = 0.5 + (calibratedProbability - 0.5) * clamp(0.62 + quality * 0.08, 0.65, 0.7);
  const payoutEV = probability => resolvedEquivalent * (probability * water - (1 - probability) + rebateRate);
  const ev = payoutEV(calibratedProbability);
  const disagreement = Math.abs(rawProbability - 0.5);
  const uncertaintyPenalty = resolvedEquivalent * ((1 - quality) * 0.028 + (1 - lineConfidence) * 0.014 + disagreement * 0.018);
  const robustEV = payoutEV(stressProbability) - uncertaintyPenalty;
  const weightedEV = ev * 0.42 + robustEV * 0.58;
  return {
    rawProbability,
    calibratedProbability,
    reliability: anchor.reliability,
    edgeClipped: anchor.edgeClipped,
    lineConfidence,
    combinedConfidence: Math.sqrt(quality * lineConfidence),
    ev,
    robustEV,
    weightedEV,
    masses: calibratedOutcomeMasses(raw, calibratedProbability),
  };
}

export function analyzeMarkets({ context, markets, settings = {} }) {
  const rebateRate = safe(settings.rebateRate, 0.015);
  const candidate = safe(settings.candidateThreshold, 7.2);
  const strongest = safe(settings.strongestThreshold, 8.5);
  const quality = dataQuality(context);
  const fullRuns = estimateRuns(context, false);
  const first5Runs = estimateRuns(context, true);
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const contractRows = (markets || []).filter(market => market.market === marketName && String(market.pick || '').trim()).slice(0, 2);
    for (const row of contractRows) {
      const expectedRuns = marketName.includes('上半') ? first5Runs : fullRuns;
      const water = normalizeWater(row.water, 0.95);
      const parsedLine = parseTaiwanLine(row.pick);
      if (!parsedLine.valid) continue;
      const raw = contractDistribution({ pick: row.pick, water, context, expectedRuns, rebateRate });
      const calibrated = calibrateContract({ raw, water, rebateRate, quality, rowConfidence: row.confidence, marketName });
      const score = scoreFromEV(calibrated.weightedEV, calibrated.combinedConfidence);
      results.push({
        ...row,
        water,
        modelProbability: calibrated.calibratedProbability,
        rawModelProbability: calibrated.rawProbability,
        fullWinProbability: calibrated.masses.fullWin,
        partialWinProbability: calibrated.masses.partialWin,
        pushProbability: calibrated.masses.push,
        partialLossProbability: calibrated.masses.partialLoss,
        fullLossProbability: calibrated.masses.fullLoss,
        ev: calibrated.ev,
        rawEV: raw.ev,
        robustEV: calibrated.robustEV,
        weightedEV: calibrated.weightedEV,
        calibrationReliability: calibrated.reliability,
        edgeClipped: calibrated.edgeClipped,
        score,
        tag: resultTag(score, candidate, strongest),
        confidence: calibrated.combinedConfidence,
        dataQuality: quality,
        lineConfidence: calibrated.lineConfidence,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    modelVersion: '保守校準模型-2026-08-v2',
    dataQuality: quality,
    expectedRuns: { full: fullRuns, first5: first5Runs },
    results,
  };
}
