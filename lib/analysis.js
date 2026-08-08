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
const logistic = value => 1 / (1 + Math.exp(-value));
const logit = value => {
  const p = clamp(safe(value, 0.5), 0.001, 0.999);
  return Math.log(p / (1 - p));
};

function poisson(lambda, max = 20) {
  const l = clamp(safe(lambda, 4.35), 0.35, 11);
  const probabilities = new Array(max + 1).fill(0);
  probabilities[0] = Math.exp(-l);
  for (let i = 1; i <= max; i += 1) probabilities[i] = probabilities[i - 1] * l / i;
  const sum = probabilities.reduce((a, b) => a + b, 0);
  probabilities[max] += Math.max(0, 1 - sum);
  return probabilities;
}

function blend(a, b, weightB = 0.3, fallback = 1) {
  const left = safe(a, fallback);
  const right = safe(b, left);
  return left * (1 - weightB) + right * weightB;
}

function offenseFactor(team) {
  const season = team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const runs = blend(season.runsPerGame, recent.runsPerGame, recent.gamesPlayed >= 5 ? 0.32 : 0.14, 4.35);
  const ops = blend(season.ops, recent.ops, recent.gamesPlayed >= 5 ? 0.28 : 0.1, 0.72);
  return clamp(0.58 * (runs / 4.35) + 0.42 * (ops / 0.72), 0.82, 1.18);
}

function starterFactor(starter) {
  if (!starter?.available) return 1;
  const season = starter.season || {};
  const recent = starter.recent || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 8 ? 0.3 : 0.1, 4.2);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 8 ? 0.25 : 0.08, 1.3);
  const kbb = blend(season.kMinusBB, recent.kMinusBB, recent.inningsPitched >= 8 ? 0.22 : 0.06, 0.14);
  return clamp(0.55 * (era / 4.2) + 0.33 * (whip / 1.3) + 0.12 * (1 - (kbb - 0.14)), 0.78, 1.3);
}

function bullpenFactor(team) {
  const season = team?.seasonPitching || {};
  const recent = team?.recentPitching || {};
  const era = blend(season.era, recent.era, recent.inningsPitched >= 15 ? 0.28 : 0.1, 4.2);
  const whip = blend(season.whip, recent.whip, recent.inningsPitched >= 15 ? 0.24 : 0.08, 1.3);
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
  const away = context?.away || {};
  const home = context?.home || {};
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

function buildScoreCells(expectedRuns) {
  const awayProbabilities = poisson(expectedRuns.away, 20);
  const homeProbabilities = poisson(expectedRuns.home, 20);
  const cells = [];
  for (let awayRuns = 0; awayRuns < awayProbabilities.length; awayRuns += 1) {
    for (let homeRuns = 0; homeRuns < homeProbabilities.length; homeRuns += 1) {
      cells.push({
        awayRuns,
        homeRuns,
        probability: awayProbabilities[awayRuns] * homeProbabilities[homeRuns],
      });
    }
  }
  return cells;
}

function summarizeCells({ cells, pick, water, context, rebateRate }) {
  const outcomes = {
    fullWin: 0,
    partialWin: 0,
    push: 0,
    partialLoss: 0,
    fullLoss: 0,
    equivalentWin: 0,
    equivalentLoss: 0,
    coverage: 0,
    ev: 0,
  };

  for (const cell of cells) {
    const probability = safe(cell.probability, 0);
    const fraction = outcomeFractionForScore(pick, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
    if (fraction == null) continue;
    outcomes.coverage += probability;
    if (fraction >= 0.999) outcomes.fullWin += probability;
    else if (fraction > 0) outcomes.partialWin += probability;
    else if (fraction <= -0.999) outcomes.fullLoss += probability;
    else if (fraction < 0) outcomes.partialLoss += probability;
    else outcomes.push += probability;
    outcomes.equivalentWin += probability * Math.max(0, fraction);
    outcomes.equivalentLoss += probability * Math.max(0, -fraction);
    outcomes.ev += probability * calculateProfit({ stake: 1, water, fraction, rebateRate }).profit;
  }

  const resolvedEquivalent = outcomes.equivalentWin + outcomes.equivalentLoss;
  outcomes.modelProbability = resolvedEquivalent > 1e-12 ? outcomes.equivalentWin / resolvedEquivalent : 0.5;
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
  const availability = checks.filter(Boolean).length / checks.length;
  const seasonGames = [context.away?.seasonHitting?.gamesPlayed, context.home?.seasonHitting?.gamesPlayed]
    .map(value => clamp(safe(value, 0), 0, 162));
  const seasonSample = clamp((seasonGames[0] + seasonGames[1]) / 60, 0.35, 1);
  const starterInnings = [context.away?.starter?.season?.inningsPitched, context.home?.starter?.season?.inningsPitched]
    .map(value => clamp(safe(value, 0), 0, 220));
  const starterSample = clamp((starterInnings[0] + starterInnings[1]) / 50, 0.35, 1);
  const recentGames = [context.away?.recentHitting?.gamesPlayed, context.home?.recentHitting?.gamesPlayed]
    .map(value => clamp(safe(value, 0), 0, 20));
  const recentSample = clamp((recentGames[0] + recentGames[1]) / 20, 0.35, 1);
  const lineupBonus = (context.away?.lineup?.official ? 0.025 : 0) + (context.home?.lineup?.official ? 0.025 : 0);
  return clamp(0.52 + availability * 0.28 + seasonSample * 0.07 + starterSample * 0.05 + recentSample * 0.04 + lineupBonus, 0.5, 0.97);
}

function rowConfidence(row) {
  return Number(row?.confidence) > 0 ? clamp(Number(row.confidence), 0.35, 1) : 0.82;
}

function primaryRowForMarket(rows, marketName) {
  const preferred = rows.find(row => {
    const parsed = parseTaiwanLine(row.pick);
    return marketName.includes('大小') ? parsed.isOver : parsed.isGiving;
  });
  return preferred || rows[0];
}

function marketAnchorProbability(primary, opposite) {
  if (!opposite) return 0.5;
  const primaryImplied = 1 / (1 + normalizeWater(primary.water, 0.95));
  const oppositeImplied = 1 / (1 + normalizeWater(opposite.water, 0.95));
  const total = primaryImplied + oppositeImplied;
  return total > 1e-12 ? primaryImplied / total : 0.5;
}

function calibrationPlan({ rawProbability, anchorProbability, quality, lineConfidence, marketName }) {
  const upperMarket = marketName.includes('上半');
  const reliability = clamp(
    (upperMarket ? 0.22 : 0.25) + (quality - 0.5) * 0.45 + (lineConfidence - 0.35) * 0.1,
    upperMarket ? 0.22 : 0.25,
    upperMarket ? 0.44 : 0.48,
  );
  const maximumLogitEdge = upperMarket ? 0.62 : 0.78;
  const rawLogitEdge = logit(rawProbability) - logit(anchorProbability);
  const clippedLogitEdge = clamp(rawLogitEdge, -maximumLogitEdge, maximumLogitEdge);
  const stressReliability = reliability * clamp(0.5 + quality * 0.15, 0.56, 0.65);
  return {
    reliability,
    stressReliability,
    maximumLogitEdge,
    rawLogitEdge,
    clippedLogitEdge,
    edgeClipped: Math.abs(rawLogitEdge) > maximumLogitEdge + 1e-12,
    calibratedProbability: logistic(logit(anchorProbability) + clippedLogitEdge * reliability),
    stressProbability: logistic(logit(anchorProbability) + clippedLogitEdge * stressReliability),
  };
}

function tiltCellsToProbability({ cells, primaryPick, targetProbability, context }) {
  let positiveMass = 0, negativeMass = 0, pushMass = 0, equivalentWin = 0, equivalentLoss = 0;
  const classified = [];

  for (const cell of cells) {
    const fraction = outcomeFractionForScore(primaryPick, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
    if (fraction == null) return { valid: false, cells };
    classified.push({ ...cell, fraction });
    if (fraction > 0) {
      positiveMass += cell.probability;
      equivalentWin += cell.probability * fraction;
    } else if (fraction < 0) {
      negativeMass += cell.probability;
      equivalentLoss += cell.probability * -fraction;
    } else {
      pushMass += cell.probability;
    }
  }

  if (equivalentWin <= 1e-12 || equivalentLoss <= 1e-12 || positiveMass <= 1e-12 || negativeMass <= 1e-12) {
    return { valid: false, cells };
  }

  const target = clamp(targetProbability, 0.02, 0.98);
  const ratio = (target * equivalentLoss) / ((1 - target) * equivalentWin);
  const resolvedMass = Math.max(0, 1 - pushMass);
  const negativeScale = resolvedMass / (ratio * positiveMass + negativeMass);
  const positiveScale = ratio * negativeScale;
  const tilted = classified.map(cell => ({
    awayRuns: cell.awayRuns,
    homeRuns: cell.homeRuns,
    probability: cell.probability * (cell.fraction > 0 ? positiveScale : cell.fraction < 0 ? negativeScale : 1),
  }));
  const sum = tilted.reduce((total, cell) => total + cell.probability, 0);
  if (!Number.isFinite(sum) || sum <= 0) return { valid: false, cells };
  return {
    valid: true,
    cells: tilted.map(cell => ({ ...cell, probability: cell.probability / sum })),
  };
}

function oppositeDirections(a, b, marketName) {
  if (!a || !b) return false;
  const left = parseTaiwanLine(a.pick), right = parseTaiwanLine(b.pick);
  if (!left.valid || !right.valid) return false;
  return marketName.includes('大小')
    ? (left.isOver && right.isUnder) || (left.isUnder && right.isOver)
    : (left.isGiving && right.isReceiving) || (left.isReceiving && right.isGiving);
}

function uncertaintyPenalty({ quality, lineConfidence, rawProbability, anchorProbability, plan, integrityWarning }) {
  const modelDistance = Math.abs(rawProbability - anchorProbability);
  const excessLogit = Math.max(0, Math.abs(plan.rawLogitEdge) - plan.maximumLogitEdge);
  return (
    (1 - quality) * 0.018
    + (1 - lineConfidence) * 0.012
    + Math.min(0.018, Math.max(0, modelDistance - 0.2) * 0.08)
    + Math.min(0.02, excessLogit * 0.006)
    + (integrityWarning ? 0.035 : 0)
  );
}

export function analyzeMarkets({ context, markets, settings = {} }) {
  const rebateRate = clamp(safe(settings.rebateRate, 0.015), 0, 0.1);
  const candidate = clamp(safe(settings.candidateThreshold, 7.2), 1, 9.6);
  const strongest = clamp(safe(settings.strongestThreshold, 8.5), 1, 9.6);
  const quality = dataQuality(context);
  const fullRuns = estimateRuns(context, false);
  const first5Runs = estimateRuns(context, true);
  const scoreCells = {
    full: buildScoreCells(fullRuns),
    first5: buildScoreCells(first5Runs),
  };
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const rows = (markets || [])
      .filter(market => market.market === marketName && String(market.pick || '').trim())
      .slice(0, 2)
      .map(row => ({ ...row, water: normalizeWater(row.water, 0.95) }));
    if (!rows.length) continue;

    const primary = primaryRowForMarket(rows, marketName);
    const opposite = rows.find(row => row !== primary) || null;
    const expectedCells = marketName.includes('上半') ? scoreCells.first5 : scoreCells.full;
    const primaryRaw = summarizeCells({ cells: expectedCells, pick: primary.pick, water: primary.water, context, rebateRate });
    if (primaryRaw.coverage < 0.999999 || primaryRaw.equivalentWin + primaryRaw.equivalentLoss <= 1e-10) {
      throw new Error(`${marketName}：盤口球隊名稱無法與官方賽事唯一配對，請重新確認方向文字`);
    }

    const pairLineConfidence = opposite
      ? Math.sqrt(rowConfidence(primary) * rowConfidence(opposite))
      : rowConfidence(primary);
    const anchorProbability = marketAnchorProbability(primary, opposite);
    const plan = calibrationPlan({
      rawProbability: primaryRaw.modelProbability,
      anchorProbability,
      quality,
      lineConfidence: pairLineConfidence,
      marketName,
    });
    const calibratedCellsResult = tiltCellsToProbability({
      cells: expectedCells,
      primaryPick: primary.pick,
      targetProbability: plan.calibratedProbability,
      context,
    });
    const stressCellsResult = tiltCellsToProbability({
      cells: expectedCells,
      primaryPick: primary.pick,
      targetProbability: plan.stressProbability,
      context,
    });
    if (!calibratedCellsResult.valid || !stressCellsResult.valid) {
      throw new Error(`${marketName}：校準分布無法建立，請重新確認盤口`);
    }

    const pairIsOpposite = oppositeDirections(primary, opposite, marketName);
    let complementError = 0;
    if (pairIsOpposite && opposite) {
      const oppositeRaw = summarizeCells({ cells: expectedCells, pick: opposite.pick, water: opposite.water, context, rebateRate });
      complementError = Math.abs(primaryRaw.modelProbability + oppositeRaw.modelProbability - 1);
    }
    const integrityWarning = (
      primaryRaw.modelProbability < 0.08
      || primaryRaw.modelProbability > 0.92
      || primaryRaw.coverage < 0.999999
      || (opposite && !pairIsOpposite)
      || complementError > 0.005
    );
    const integrityMessage = integrityWarning
      ? '模型或盤口結構出現異常差距，已禁止列入下注候選'
      : '';
    const penalty = uncertaintyPenalty({
      quality,
      lineConfidence: pairLineConfidence,
      rawProbability: primaryRaw.modelProbability,
      anchorProbability,
      plan,
      integrityWarning,
    });

    for (const row of rows) {
      const raw = summarizeCells({ cells: expectedCells, pick: row.pick, water: row.water, context, rebateRate });
      const calibrated = summarizeCells({ cells: calibratedCellsResult.cells, pick: row.pick, water: row.water, context, rebateRate });
      const stress = summarizeCells({ cells: stressCellsResult.cells, pick: row.pick, water: row.water, context, rebateRate });
      if (raw.coverage < 0.999999 || calibrated.coverage < 0.999999 || stress.coverage < 0.999999) {
        throw new Error(`${marketName}：盤口方向無法完整結算，請重新確認球隊名稱`);
      }

      const robustEV = stress.ev - penalty;
      const weightedEV = calibrated.ev * 0.35 + robustEV * 0.65;
      const combinedConfidence = clamp(Math.sqrt(quality * pairLineConfidence) * (integrityWarning ? 0.65 : 1), 0.35, 0.99);
      const score = scoreFromEV(weightedEV, combinedConfidence, { robustEV, integrityWarning });
      const rowIsPrimary = row === primary;
      const rowAnchorProbability = rowIsPrimary ? anchorProbability : 1 - anchorProbability;

      results.push({
        ...row,
        modelProbability: calibrated.modelProbability,
        rawModelProbability: raw.modelProbability,
        marketAnchorProbability: rowAnchorProbability,
        fullWinProbability: calibrated.fullWin,
        partialWinProbability: calibrated.partialWin,
        pushProbability: calibrated.push,
        partialLossProbability: calibrated.partialLoss,
        fullLossProbability: calibrated.fullLoss,
        ev: calibrated.ev,
        rawEV: raw.ev,
        robustEV,
        weightedEV,
        uncertaintyPenalty: penalty,
        calibrationReliability: plan.reliability,
        edgeClipped: plan.edgeClipped,
        integrityWarning,
        integrityMessage,
        complementError,
        score,
        betEligible: !integrityWarning && score >= candidate,
        tag: integrityWarning ? '模型異常｜不下注' : resultTag(score, candidate, strongest),
        confidence: combinedConfidence,
        dataQuality: quality,
        lineConfidence: pairLineConfidence,
        distributionCoverage: calibrated.coverage,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    modelVersion: '市場錨定穩健模型-2026-08-v5',
    dataQuality: quality,
    expectedRuns: { full: fullRuns, first5: first5Runs },
    results,
  };
}
