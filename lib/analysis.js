import {
  MARKET_ORDER,
  calculateProfit,
  outcomeFractionForScore,
  resultTag,
  scoreFromEV,
  normalizeWater,
} from './markets.js';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const safe = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function poisson(lambda, max = 20) {
  const l = clamp(safe(lambda, 4.4), 0.35, 12);
  const p = new Array(max + 1).fill(0);
  p[0] = Math.exp(-l);
  for (let i = 1; i <= max; i += 1) p[i] = p[i - 1] * l / i;
  const sum = p.reduce((a, b) => a + b, 0);
  p[max] += Math.max(0, 1 - sum);
  return p;
}

function blend(a, b, weightB = 0.3) {
  return safe(a, b) * (1 - weightB) + safe(b, a) * weightB;
}

function offenseFactor(team) {
  const season = team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const runs = blend(season.runsPerGame, recent.runsPerGame, recent.gamesPlayed >= 5 ? 0.35 : 0.15);
  const ops = blend(season.ops, recent.ops, recent.gamesPlayed >= 5 ? 0.3 : 0.1);
  return clamp(0.58 * (runs / 4.4) + 0.42 * (ops / 0.72), 0.68, 1.38);
}

function starterFactor(starter) {
  if (!starter?.available) return 1;
  const season = starter.season || {};
  const recent = starter.recent || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 8 ? 0.32 : 0.12);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 8 ? 0.28 : 0.1);
  const kbb = blend(season.kMinusBB, recent.kMinusBB, recent.inningsPitched >= 8 ? 0.25 : 0.08);
  return clamp(0.55 * (era / 4.2) + 0.33 * (whip / 1.3) + 0.12 * (1 - (kbb - 0.14)), 0.62, 1.55);
}

function bullpenFactor(team) {
  const season = team?.seasonPitching || {};
  const recent = team?.recentPitching || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 15 ? 0.32 : 0.12);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 15 ? 0.28 : 0.1);
  const fatigue = clamp(safe(team?.bullpen?.fatigueIndex, 0), 0, 1);
  return clamp(0.62 * (era / 4.2) + 0.38 * (whip / 1.3) + fatigue * 0.12, 0.72, 1.42);
}

function platoonFactor(team, opposingStarter) {
  const hand = opposingStarter?.throws;
  if (!hand) return 1;
  const split = hand === 'L' ? team?.vsLeft : team?.vsRight;
  if (!split?.available) return 1;
  return clamp(safe(split.ops, 0.72) / 0.72, 0.84, 1.16);
}

function lineupFactor(team) {
  const lineup = team?.lineup || {};
  const injuries = Array.isArray(team?.injuries) ? team.injuries.length : 0;
  const lineupPenalty = lineup.official ? clamp(safe(lineup.missingCoreCount, 0), 0, 5) * 0.025 : 0;
  const injuryPenalty = Math.min(injuries, 5) * 0.004;
  return clamp(1 - lineupPenalty - injuryPenalty, 0.86, 1.03);
}

function restFactor(team) {
  const rest = safe(team?.rest?.days, 1);
  const travelKm = safe(team?.rest?.travelKm, 0);
  const extra = team?.rest?.previousExtraInnings ? 1 : 0;
  return clamp(1 + (rest >= 2 ? 0.012 : 0) - (rest <= 0 ? 0.025 : 0) - Math.min(travelKm / 10000, 0.025) - extra * 0.012, 0.92, 1.04);
}

function environmentFactor(context) {
  const park = clamp(safe(context?.park?.runFactor, 1), 0.85, 1.22);
  const weather = context?.weather || {};
  const temp = safe(weather.temperature, 20);
  const wind = safe(weather.windSpeed, 0);
  const roofClosed = context?.park?.roof === 'closed' || context?.park?.roof === 'dome';
  const weatherAdj = roofClosed ? 1 : clamp(1 + (temp - 20) * 0.0025 + Math.min(wind, 30) * 0.0015, 0.92, 1.11);
  return clamp(park * weatherAdj, 0.82, 1.28);
}

export function estimateRuns(context, first5 = false) {
  const away = context.away;
  const home = context.home;
  const env = environmentFactor(context);
  const awayPitch = first5
    ? starterFactor(home.starter)
    : starterFactor(home.starter) * 0.62 + bullpenFactor(home) * 0.38;
  const homePitch = first5
    ? starterFactor(away.starter)
    : starterFactor(away.starter) * 0.62 + bullpenFactor(away) * 0.38;
  const inningsScale = first5 ? 0.56 : 1;
  const homeAdv = first5 ? 1.018 : 1.035;
  const awayRuns = 4.4 * inningsScale * offenseFactor(away) * awayPitch * platoonFactor(away, home.starter) * lineupFactor(away) * restFactor(away) * env;
  const homeRuns = 4.4 * inningsScale * offenseFactor(home) * homePitch * platoonFactor(home, away.starter) * lineupFactor(home) * restFactor(home) * env * homeAdv;
  return { away: clamp(awayRuns, 0.25, first5 ? 7 : 13), home: clamp(homeRuns, 0.25, first5 ? 7 : 13) };
}

function contractDistribution({ pick, water, context, expectedRuns, rebateRate }) {
  const awayP = poisson(expectedRuns.away, 20);
  const homeP = poisson(expectedRuns.home, 20);
  const outcomes = { fullWin: 0, partialWin: 0, push: 0, partialLoss: 0, fullLoss: 0, equivalentWin: 0, equivalentLoss: 0, ev: 0 };
  for (let a = 0; a < awayP.length; a += 1) {
    for (let h = 0; h < homeP.length; h += 1) {
      const probability = awayP[a] * homeP[h];
      const fraction = outcomeFractionForScore(pick, a, h, context.game.away, context.game.home);
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
  const lineupBonus = (context.away?.lineup?.official ? 0.04 : 0) + (context.home?.lineup?.official ? 0.04 : 0);
  return clamp(0.5 + base * 0.42 + lineupBonus, 0.5, 0.98);
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

function calibrateContract({ raw, water, rebateRate, quality, rowConfidence, marketName }) {
  const resolvedEquivalent = raw.equivalentWin + raw.equivalentLoss;
  const rawProbability = resolvedEquivalent > 1e-12 ? raw.equivalentWin / resolvedEquivalent : 0.5;
  const confidence = clamp(safe(rowConfidence, 0.65), 0, 1);
  const reliability = clamp(0.32 + (quality - 0.5) * 0.32 + confidence * 0.03 - (marketName.includes('上半') ? 0.025 : 0), 0.28, 0.5);
  const maximumRawEdge = marketName.includes('上半') ? 0.2 : 0.22;
  const clippedRawEdge = clamp(rawProbability - 0.5, -maximumRawEdge, maximumRawEdge);
  const calibratedProbability = clamp(0.5 + clippedRawEdge * reliability, 0.35, 0.65);
  const stressProbability = 0.5 + (calibratedProbability - 0.5) * clamp(0.66 + quality * 0.08, 0.68, 0.74);
  const payoutEV = probability => resolvedEquivalent * (probability * water - (1 - probability) + rebateRate);
  const ev = payoutEV(calibratedProbability);
  const uncertaintyPenalty = resolvedEquivalent * ((1 - quality) * 0.025 + (1 - confidence) * 0.012);
  const robustEV = payoutEV(stressProbability) - uncertaintyPenalty;
  const weightedEV = ev * 0.55 + robustEV * 0.45;
  return {
    rawProbability,
    calibratedProbability,
    reliability,
    edgeClipped: Math.abs(rawProbability - 0.5) > maximumRawEdge + 1e-12,
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
      const raw = contractDistribution({ pick: row.pick, water, context, expectedRuns, rebateRate });
      const calibrated = calibrateContract({ raw, water, rebateRate, quality, rowConfidence: row.confidence, marketName });
      const score = scoreFromEV(calibrated.weightedEV, quality);
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
        confidence: quality,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    modelVersion: 'calibrated-2026-08',
    dataQuality: quality,
    expectedRuns: { full: fullRuns, first5: first5Runs },
    results,
  };
}
