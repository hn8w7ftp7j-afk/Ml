from pathlib import Path
import json


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label, include_end=False):
    left = text.find(start)
    right = text.find(end, left + len(start))
    if left < 0 or right < 0:
        raise SystemExit(f'{label}: markers missing')
    if include_end:
        right += len(end)
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]

# ---------------------------------------------------------------------------
# Joint distribution / EV engine: precise per-leg settlement, no target-price
# calibration, persisted compact distribution snapshot, no re-simulation on
# price-only changes, and two independent EV calculations.
# ---------------------------------------------------------------------------
p = Path('lib/analysis.js')
s = p.read_text()
s = one(s, "import {\n  MARKET_ORDER,", "import Decimal from 'decimal.js';\nimport { sha256 } from './snapshot-v9.js';\nimport {\n  MARKET_ORDER,", 'analysis imports')
s = one(s, "  outcomeFractionForScore,", "  outcomeFractionForScore,\n  outcomeSettlementForScore,", 'settlement import')
s = s.replace("export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.4.0';", "export const MODEL_VERSION = 'MLB-JOINT-SCORE-DISTRIBUTION-2026-08-v9.1.0';")
s = s.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.4.0';", "export const RULES_VERSION = 'MLB-TW-DETERMINISTIC-EXECUTION-2026-08-v9.1.0';")

summary_start = 'function summarizeDistribution({ cells, pick, water, context, rebateRate }) {'
summary_end = 'function normalizedWeights(rows) {'
new_summary = r'''function summarizeDistribution({ cells, pick, water, context, rebateRate }) {
  const parsed = parseTaiwanLine(pick);
  const decimals = {
    fullWin: new Decimal(0),
    partialWin: new Decimal(0),
    push: new Decimal(0),
    partialLoss: new Decimal(0),
    fullLoss: new Decimal(0),
    mixedWinLoss: new Decimal(0),
    mixedNeutral: new Decimal(0),
    equivalentWin: new Decimal(0),
    equivalentLoss: new Decimal(0),
    coverage: new Decimal(0),
    directEV: new Decimal(0),
    exactLineProbability: new Decimal(0),
  };
  const outcomeBuckets = new Map();

  for (const cell of cells || []) {
    const probability = new Decimal(safe(cell.probability, 0));
    if (probability.lte(0)) continue;
    const settlement = outcomeSettlementForScore(parsed, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
    if (!settlement) continue;
    const calculation = calculateProfit({ stake: 1, water, settlement, rebateRate });
    const win = new Decimal(settlement.winFraction || 0);
    const loss = new Decimal(settlement.lossFraction || 0);
    const push = new Decimal(settlement.pushFraction || 0);
    const net = win.minus(loss);

    decimals.coverage = decimals.coverage.plus(probability);
    decimals.equivalentWin = decimals.equivalentWin.plus(probability.mul(win));
    decimals.equivalentLoss = decimals.equivalentLoss.plus(probability.mul(loss));
    decimals.directEV = decimals.directEV.plus(probability.mul(calculation.profit));

    if (win.eq(1) && loss.eq(0)) decimals.fullWin = decimals.fullWin.plus(probability);
    else if (loss.eq(1) && win.eq(0)) decimals.fullLoss = decimals.fullLoss.plus(probability);
    else if (win.eq(0) && loss.eq(0)) decimals.push = decimals.push.plus(probability);
    else if (win.gt(0) && loss.gt(0)) {
      decimals.mixedWinLoss = decimals.mixedWinLoss.plus(probability);
      if (net.gt(0)) decimals.partialWin = decimals.partialWin.plus(probability);
      else if (net.lt(0)) decimals.partialLoss = decimals.partialLoss.plus(probability);
      else decimals.mixedNeutral = decimals.mixedNeutral.plus(probability);
    } else if (win.gt(0)) decimals.partialWin = decimals.partialWin.plus(probability);
    else if (loss.gt(0)) decimals.partialLoss = decimals.partialLoss.plus(probability);
    else decimals.push = decimals.push.plus(probability);

    if ((settlement.legs || []).some(leg => leg.exactLine)) {
      decimals.exactLineProbability = decimals.exactLineProbability.plus(probability);
    }

    const signature = (settlement.legs || []).map(leg => [
      Number(leg.allocation || 0).toFixed(12),
      Number(leg.winShare || 0).toFixed(12),
      Number(leg.lossShare || 0).toFixed(12),
      Number(leg.pushShare || 0).toFixed(12),
    ].join(':')).join('|');
    const bucket = outcomeBuckets.get(signature) || {
      signature,
      probability: new Decimal(0),
      profit: new Decimal(calculation.profit),
      winFraction: win,
      lossFraction: loss,
      pushFraction: push,
    };
    bucket.probability = bucket.probability.plus(probability);
    outcomeBuckets.set(signature, bucket);
  }

  const bucketEV = [...outcomeBuckets.values()].reduce(
    (sum, bucket) => sum.plus(bucket.probability.mul(bucket.profit)),
    new Decimal(0),
  );
  const resolved = decimals.equivalentWin.plus(decimals.equivalentLoss);
  const modelProbability = resolved.gt(0)
    ? decimals.equivalentWin.div(resolved)
    : new Decimal('0.5');
  const fairWater = decimals.equivalentWin.gt(0)
    ? Decimal.max('0.5', Decimal.min('1.5',
      new Decimal(1).minus(rebateRate).mul(decimals.equivalentLoss).div(decimals.equivalentWin).minus(rebateRate),
    ))
    : new Decimal('1.5');
  const categoryCoverage = decimals.fullWin
    .plus(decimals.partialWin)
    .plus(decimals.push)
    .plus(decimals.partialLoss)
    .plus(decimals.fullLoss)
    .plus(decimals.mixedNeutral);

  return {
    fullWin: decimals.fullWin.toNumber(),
    partialWin: decimals.partialWin.toNumber(),
    push: decimals.push.toNumber(),
    partialLoss: decimals.partialLoss.toNumber(),
    fullLoss: decimals.fullLoss.toNumber(),
    mixedWinLoss: decimals.mixedWinLoss.toNumber(),
    mixedNeutral: decimals.mixedNeutral.toNumber(),
    equivalentWin: decimals.equivalentWin.toNumber(),
    equivalentLoss: decimals.equivalentLoss.toNumber(),
    coverage: decimals.coverage.toNumber(),
    categoryCoverage: categoryCoverage.toNumber(),
    ev: decimals.directEV.toNumber(),
    evFromBuckets: bucketEV.toNumber(),
    evDoubleCheckError: decimals.directEV.minus(bucketEV).abs().toNumber(),
    exactLineProbability: decimals.exactLineProbability.toNumber(),
    modelProbability: modelProbability.toNumber(),
    fairWater: fairWater.toNumber(),
    outcomeBuckets: [...outcomeBuckets.values()].map(bucket => ({
      signature: bucket.signature,
      probability: bucket.probability.toNumber(),
      profit: bucket.profit.toNumber(),
      winFraction: bucket.winFraction.toNumber(),
      lossFraction: bucket.lossFraction.toNumber(),
      pushFraction: bucket.pushFraction.toNumber(),
    })),
  };
}'''
s = replace_between(s, summary_start, summary_end, new_summary, 'precise summary')

robust_start = 'function robustFromScenarioEVs(scenarioEVs, weightSets) {'
robust_end = 'function weightedQuantile(values, quantile) {'
new_robust = r'''function robustFromScenarioEVs(scenarioEVs, weightSets) {
  const byId = new Map(scenarioEVs.map(row => [row.id, new Decimal(row.value || 0)]));
  const variants = weightSets.map(set => ({
    id: set.id,
    description: set.description,
    value: set.rows.reduce(
      (sum, row) => sum.plus(new Decimal(row.weight || 0).mul(byId.get(row.id) || 0)),
      new Decimal(0),
    ).toNumber(),
  })).sort((left, right) => left.value - right.value);
  return { robustEV: variants[0]?.value ?? 0, worstVariant: variants[0] || null, variants };
}'''
s = replace_between(s, robust_start, robust_end, new_robust, 'decimal robust')

move_start = 'function movementComparison({ previous, row, distribution, context, rebateRate, weightedEV, modelProbability }) {'
move_end = 'function scoreBand(score) {'
new_move = r'''function movementComparison({ previous, row, distribution, context, rebateRate, weightedEV }) {
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
    const keys = currentParsed.isTotal ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] : [0, 1, 2, 3, 4, 5];
    const minimum = Math.min(previousLine, currentLine);
    const maximum = Math.max(previousLine, currentLine);
    for (const key of keys) if (key > minimum && key <= maximum) crossedKeyNumbers.push(key);
  }
  if (!previousHasWater) {
    return { available: true, previousPick: previous.pick, previousWater: null, lineChanged, crossedKeyNumbers, reason: '舊盤水位未提供，只比較盤口文字' };
  }
  const previousWater = normalizeWater(previous.water);
  const previousSummary = summarizeDistribution({ cells: distribution, pick: previous.pick, water: previousWater, context, rebateRate });
  const previousWeightedEV = previousSummary.ev;
  const deltaEV = weightedEV - previousWeightedEV;
  return {
    available: true,
    previousPick: previous.pick,
    previousWater,
    lineChanged,
    waterChanged: currentHasWater && Math.abs(Number(row.water) - previousWater) > 1e-9,
    crossedKeyNumbers,
    previousWeightedEV,
    deltaEV,
    evDoubleCheck: {
      passed: previousSummary.evDoubleCheckError <= 0.0001,
      error: previousSummary.evDoubleCheckError,
    },
    verdict: deltaEV > 0.005 ? '目前價格比舊盤更有利' : deltaEV < -0.005 ? '目前價格比舊盤更差' : '與舊盤價值接近',
    method: '沿用同一凍結聯合比分分布，逐比分與結果桶雙算舊盤及新盤；不重新研究核心資料',
  };
}'''
s = replace_between(s, move_start, move_end, new_move, 'movement raw distribution')

analysis_start = 'export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {'
new_tail = r'''function compactJoint(cells) {
  return (cells || []).map(cell => [cell.awayFirst5, cell.homeFirst5, cell.awayRuns, cell.homeRuns, cell.probability]);
}

function expandJoint(rows) {
  return (rows || []).map(row => ({
    awayFirst5: Number(row[0]),
    homeFirst5: Number(row[1]),
    awayRuns: Number(row[2]),
    homeRuns: Number(row[3]),
    probability: Number(row[4]),
  }));
}

function compactRobustSets(sets) {
  return (sets || []).map(set => ({
    id: set.id,
    description: set.description,
    rows: set.rows.map(row => [row.id, row.weight]),
  }));
}

function expandRobustSets(sets) {
  return (sets || []).map(set => ({
    id: set.id,
    description: set.description,
    rows: (set.rows || []).map(row => ({ id: row[0], weight: Number(row[1]) })),
  }));
}

export function buildDistributionSnapshot({ context, settings = {} }) {
  if (context?.coreModelable === false) throw new Error('資料不足｜不評分');
  const simulationsPerScenario = clamp(Math.round(safe(settings.simulationsPerScenario, 1800)), 500, 4000);
  const profile = gameContextProfile(context);
  const scenarioBase = scenarioGrid(profile);
  const coreIdentity = context?.coreFingerprint || `${context?.game?.gamePk}|${context?.game?.away}|${context?.game?.home}`;
  const seedBase = hashString(`${MODEL_VERSION}|${coreIdentity}|${simulationsPerScenario}`);
  const scenarios = scenarioBase.map((scenario, index) => ({
    ...scenario,
    joint: simulateScenario(
      scenario,
      simulationsPerScenario,
      seedBase ^ hashString(scenario.id) ^ Math.imul(index + 1, 2654435761),
    ),
  }));
  const combinedJointCells = combinedJoint(scenarios);
  const robustSets = robustWeightSets(scenarios);
  const snapshotCore = {
    version: 'MLB-FROZEN-JOINT-DISTRIBUTION-2026-08-v1.0.0',
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    coreFingerprint: context?.coreFingerprint || null,
    seedBase,
    simulationsPerScenario,
    profile,
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      weight: scenario.weight,
      shocks: scenario.shocks,
      means: scenario.means,
      joint: compactJoint(scenario.joint),
    })),
    robustSets: compactRobustSets(robustSets),
    combinedJoint: compactJoint(combinedJointCells),
  };
  const distributionHash = sha256(snapshotCore);
  return {
    ...snapshotCore,
    distributionHash,
    distributionId: `${context?.game?.gamePk || 'game'}-${distributionHash.slice(0, 20)}`,
  };
}

function hydrateDistributionSnapshot(snapshot) {
  if (!snapshot || snapshot.modelVersion !== MODEL_VERSION || !snapshot.distributionHash) {
    throw new Error('凍結比分分布版本不相容，必須完整重算');
  }
  const withoutHash = { ...snapshot };
  delete withoutHash.distributionHash;
  delete withoutHash.distributionId;
  const actualHash = sha256(withoutHash);
  if (actualHash !== snapshot.distributionHash) throw new Error('凍結比分分布雜湊驗證失敗');
  const scenarios = (snapshot.scenarios || []).map(scenario => ({
    ...scenario,
    weight: Number(scenario.weight),
    joint: expandJoint(scenario.joint),
  }));
  const combinedJointCells = expandJoint(snapshot.combinedJoint);
  const robustSets = expandRobustSets(snapshot.robustSets);
  return { profile: snapshot.profile, scenarios, combinedJointCells, robustSets };
}

function pricingAggregate(scenarioEvaluations, rows = null) {
  const weights = rows
    ? new Map(rows.map(row => [row.id, Number(row.weight)]))
    : new Map(scenarioEvaluations.map(row => [row.id, Number(row.weight)]));
  let win = new Decimal(0);
  let loss = new Decimal(0);
  for (const scenario of scenarioEvaluations) {
    const weight = new Decimal(weights.get(scenario.id) || 0);
    win = win.plus(weight.mul(scenario.summary.equivalentWin || 0));
    loss = loss.plus(weight.mul(scenario.summary.equivalentLoss || 0));
  }
  return { win: win.toNumber(), loss: loss.toNumber() };
}

function waterForEVTarget(pricing, targetEV, rebateRate) {
  const win = new Decimal(pricing?.win || 0);
  const loss = new Decimal(pricing?.loss || 0);
  if (win.lte(0)) return null;
  return new Decimal(targetEV || 0)
    .plus(loss.mul(new Decimal(1).minus(rebateRate)))
    .div(win)
    .minus(rebateRate)
    .toNumber();
}

function minimumWaterThresholds(scenarioEvaluations, robustSets, currentWater, rebateRate, crossMarketVerified) {
  const weightedPricing = pricingAggregate(scenarioEvaluations);
  const robustPricings = robustSets.map(set => ({
    id: set.id,
    description: set.description,
    ...pricingAggregate(scenarioEvaluations, set.rows),
  }));
  const threshold = (score, weightedTarget, robustTarget, comparator = '>=') => {
    const weightedWater = waterForEVTarget(weightedPricing, weightedTarget, rebateRate);
    const robustWaters = robustPricings.map(pricing => waterForEVTarget(pricing, robustTarget, rebateRate)).filter(Number.isFinite);
    const robustWater = robustWaters.length ? Math.max(...robustWaters) : null;
    const requiredWater = [weightedWater, robustWater].filter(Number.isFinite).length
      ? Math.max(...[weightedWater, robustWater].filter(Number.isFinite))
      : null;
    return {
      score,
      weightedTarget,
      robustTarget,
      comparator,
      weightedWater,
      robustWater,
      requiredWater,
      withinSupportedWaterRange: requiredWater != null && requiredWater >= 0.5 && requiredWater <= 1.5,
      distanceFromCurrent: requiredWater == null ? null : requiredWater - Number(currentWater),
    };
  };
  return {
    currentLineOnly: true,
    waterPrecisionPolicy: '保留完整內部精度；顯示時不得反向用於資格判定',
    score7_2: threshold(7.2, 0, 0, '>'),
    score7_5: threshold(7.5, 0.020, 0.008),
    score8_0: threshold(8.0, 0.040, 0.020),
    score8_5: {
      ...threshold(8.5, 0.070, 0.040),
      crossMarketVerified: crossMarketVerified === true,
      marketQualificationRequired: true,
    },
    virtual9_0: threshold(9.0, 0.120, 0.080),
  };
}

function holeAuditForRow(row, context, rebateRate) {
  const parsed = parseTaiwanLine(row.pick);
  if (!parsed.valid || !parsed.legs?.length) return null;
  const integerLegs = [...new Set(parsed.legs.filter(line => Number.isInteger(Number(line))).map(Number))];
  if (!integerLegs.length) return null;
  const audits = [];
  for (const line of integerLegs) {
    let awayRuns = 0;
    let homeRuns = 0;
    let trigger = '';
    if (parsed.isTotal) {
      homeRuns = line;
      trigger = `總分剛好${line}`;
    } else {
      const selectedIsAway = normalizedTeam(parsed.team) === normalizedTeam(context.game.away);
      if (parsed.isGiving) {
        if (selectedIsAway) awayRuns = line;
        else homeRuns = line;
      } else {
        if (selectedIsAway) homeRuns = line;
        else awayRuns = line;
      }
      trigger = `讓方剛好贏${line}分`;
    }
    const settlement = outcomeSettlementForScore(row.pick, awayRuns, homeRuns, context.game.away, context.game.home);
    if (!settlement) continue;
    const calculation = calculateProfit({ stake: 10000, water: row.water, settlement, rebateRate });
    audits.push({
      line,
      trigger,
      awayRuns,
      homeRuns,
      winFraction: settlement.winFraction,
      lossFraction: settlement.lossFraction,
      pushFraction: settlement.pushFraction,
      netProfitPer10000: calculation.profit,
      rebatePer10000: calculation.rebate,
      legOutcomes: settlement.legs,
    });
  }
  return audits.length ? { passed: true, audits } : null;
}

function evidenceIntegrity({ weightedSummary, scenarioEvaluations, rows, weightedEV, robustEV }) {
  const failures = [];
  if (weightedSummary.coverage < 0.999999) failures.push('比分分布覆蓋不足100%');
  if (Math.abs(weightedSummary.categoryCoverage - weightedSummary.coverage) > 0.000001) failures.push('結果分類機率未完整覆蓋');
  const maximumDoubleCheckError = Math.max(
    weightedSummary.evDoubleCheckError || 0,
    ...scenarioEvaluations.map(row => row.summary.evDoubleCheckError || 0),
  );
  if (maximumDoubleCheckError > 0.0001) failures.push('逐比分EV與結果桶EV誤差超過0.01%');
  if (scenarioEvaluations.some(row => !Number.isFinite(row.value))) failures.push('情境EV不是有限數值');
  if (robustEV > weightedEV + 0.0000000001) failures.push('穩健EV高於加權EV');
  const parsed = parseTaiwanLine(rows[0]?.pick);
  const allLegsNonInteger = parsed?.legs?.length && parsed.legs.every(line => Math.abs(Number(line) % 1) > 1e-9);
  if (allLegsNonInteger && weightedSummary.push > 0.002) failures.push('純半分盤出現不應存在的走水機率');
  return {
    passed: failures.length === 0,
    failures,
    maximumDoubleCheckError,
  };
}

export function evaluateMarketsFromDistribution({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  const rebateRate = clamp(safe(settings.rebateRate, 0.015), 0, 0.1);
  const { profile, scenarios, combinedJointCells, robustSets } = hydrateDistributionSnapshot(distributionSnapshot);
  const distributionId = distributionSnapshot.distributionId;
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const rows = (Array.isArray(markets) ? markets : [])
      .filter(row => row?.market === marketName && String(row?.pick || '').trim())
      .slice(0, 2);
    if (!rows.length) continue;
    const combinedDistribution = distributionForMarket(combinedJointCells, marketName);

    for (const row of rows) {
      const actualWaterProvided = hasActualWater(row.water);
      const waterEstimated = Boolean(row.waterEstimated);
      const anchorInfo = marketAnchorInfo(rows, row, rebateRate);
      const previous = previousMarketRow(previousMarkets, row);
      if (!actualWaterProvided) {
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
          marketAnchorProbability: anchorInfo.probability,
          weightedEV: null,
          robustEV: null,
          conservativeEV: null,
          ev: null,
          rawEV: null,
          evFlipProbability: null,
          distributionCoverage: 1,
          movement: { available: false, reason: '目前水位未提供' },
          distributionId,
          sourceStatuses: profile.statuses,
          evDoubleCheck: { passed: true, skipped: true },
        });
        continue;
      }

      const water = normalizeWater(row.water);
      const weightedSummary = summarizeDistribution({ cells: combinedDistribution, pick: row.pick, water, context, rebateRate });
      const scenarioEvaluations = scenarios.map(scenario => {
        const summary = summarizeDistribution({
          cells: distributionForMarket(scenario.joint, marketName),
          pick: row.pick,
          water,
          context,
          rebateRate,
        });
        return {
          id: scenario.id,
          weight: scenario.weight,
          value: summary.ev,
          summary,
        };
      });
      const scenarioEVs = scenarioEvaluations.map(scenario => ({ id: scenario.id, weight: scenario.weight, value: scenario.value }));
      const weightedEV = scenarioEvaluations.reduce(
        (sum, scenario) => sum.plus(new Decimal(scenario.weight || 0).mul(scenario.value || 0)),
        new Decimal(0),
      ).toNumber();
      const aggregationError = Math.abs(weightedEV - weightedSummary.ev);
      const robust = robustFromScenarioEVs(scenarioEVs, robustSets);
      const conservativeEV = weightedQuantile(scenarioEVs, 0.20);
      const evFlipProbabilityDiagnostic = scenarioEVs
        .filter(scenario => scenario.value <= 0)
        .reduce((sum, scenario) => sum + scenario.weight, 0);
      const sensitivity = scenarioSensitivity(scenarioEVs, scenarios);
      const integrity = evidenceIntegrity({
        weightedSummary,
        scenarioEvaluations,
        rows,
        weightedEV,
        robustEV: robust.robustEV,
      });
      if (aggregationError > 0.0001) integrity.failures.push('情境加權EV與合併分布EV誤差超過0.01%');
      integrity.passed = integrity.failures.length === 0;
      const marketAnchorProbability = anchorInfo.probability;
      const rawMarketProbabilityGap = marketAnchorProbability == null
        ? null
        : Math.abs(weightedSummary.modelProbability - marketAnchorProbability);
      const movement = movementComparison({
        previous,
        row,
        distribution: combinedDistribution,
        context,
        rebateRate,
        weightedEV,
      });
      const crossMarketVerified = row.marketVerification?.verified === true;
      const minimumWater = minimumWaterThresholds(
        scenarioEvaluations,
        robustSets,
        water,
        rebateRate,
        crossMarketVerified,
      );

      results.push({
        ...row,
        water,
        waterMissing: false,
        waterEstimated,
        modelProbability: weightedSummary.modelProbability,
        rawModelProbability: weightedSummary.modelProbability,
        marketAnchorProbability,
        marketAnchorSource: anchorInfo.source,
        marketCalibrationWeight: 0,
        maximumCalibratedProbabilityEdge: 0,
        rawMarketProbabilityGap,
        calibratedMarketProbabilityGap: rawMarketProbabilityGap,
        marketCalibrationApplied: false,
        marketReliance: 0,
        modelErrorFloor: null,
        independentEvidenceStrength: null,
        divergenceRisk: rawMarketProbabilityGap,
        expertLayerUsed: false,
        expertModel: null,
        outcomeProbabilitiesSource: 'MLB資料建立的凍結聯合比分分布；目標盤口只用於逐結果結算與價格EV，不回寫比分分布',
        fairWater: weightedSummary.fairWater,
        rawFairWater: weightedSummary.fairWater,
        fullWinProbability: weightedSummary.fullWin,
        partialWinProbability: weightedSummary.partialWin,
        pushProbability: weightedSummary.push,
        partialLossProbability: weightedSummary.partialLoss,
        fullLossProbability: weightedSummary.fullLoss,
        mixedWinLossProbability: weightedSummary.mixedWinLoss,
        mixedNeutralProbability: weightedSummary.mixedNeutral,
        exactLineProbability: weightedSummary.exactLineProbability,
        distributionCoverage: weightedSummary.coverage,
        weightedEV,
        robustEV: robust.robustEV,
        conservativeEV,
        cev: conservativeEV,
        rawEV: weightedSummary.ev,
        ev: weightedEV,
        evFlipProbability: null,
        evFlipProbabilityDiagnostic,
        evFlipStatus: '診斷值｜目前情境集合不視為獨立機率抽樣母體',
        worstVariant: robust.worstVariant?.description || '',
        robustVariants: robust.variants,
        scenarioSensitivity: sensitivity,
        integrityWarning: !integrity.passed,
        integrityMessage: integrity.failures.join('；'),
        confidence: profile.quality,
        score: 0,
        scoreAudit: { ok: integrity.passed, evidenceOnly: true, errors: integrity.failures },
        scoreBreakdown: null,
        tag: integrity.passed ? '待固定公式評分' : '⛔ QA未通過｜不評分｜不下注',
        betEligible: false,
        unitSuggestion: null,
        primaryRisks: buildRisks({
          profile,
          flipProbability: evFlipProbabilityDiagnostic,
          robustEV: robust.robustEV,
          marketName,
          row,
          rawProbabilityGap: rawMarketProbabilityGap || 0,
          calibrationWeight: 0,
          divergenceRisk: rawMarketProbabilityGap || 0,
        }),
        movement,
        distributionId,
        sourceStatuses: profile.statuses,
        evDoubleCheck: {
          passed: integrity.maximumDoubleCheckError <= 0.0001 && aggregationError <= 0.0001,
          directEV: weightedSummary.ev,
          bucketEV: weightedSummary.evFromBuckets,
          scenarioWeightedEV: weightedEV,
          combinedDistributionEV: weightedSummary.ev,
          maximumBucketError: integrity.maximumDoubleCheckError,
          aggregationError,
          tolerance: 0.0001,
          methods: ['逐比分逐腿損益加總', '結算結果桶機率彙總'],
        },
        minimumWater,
        holeAudit: holeAuditForRow({ ...row, water }, context, rebateRate),
      });
    }
  }

  return {
    modelVersion: MODEL_VERSION,
    rulesVersion: RULES_VERSION,
    scoreContractVersion: null,
    scoreValidation: {
      version: 'EV-EVIDENCE-ONLY-v9.1',
      passed: results.every(result => result.water == null || result.scoreAudit?.ok === true),
      checkedDirections: results.filter(result => result.water != null).length,
      failures: results.flatMap(result => result.scoreAudit?.ok === false
        ? [`${result.market}｜${result.pick}：${(result.scoreAudit.errors || []).join('；')}`]
        : []),
    },
    snapshotId: distributionId,
    distributionId,
    distributionHash: distributionSnapshot.distributionHash,
    distributionSnapshot,
    createdAt: new Date().toISOString(),
    analysisStatus: Object.values(profile.statuses).every(value => value === '已確認') ? '完整資料版' : '聯合情境版',
    dataQuality: profile.quality,
    expectedRuns: { full: profile.full, first5: profile.first5 },
    modelInputs: profile.components,
    sourceStatuses: profile.statuses,
    scenarioSummary: {
      count: scenarios.length,
      robustVariantCount: robustSets.length,
      simulationsPerScenario: distributionSnapshot.simulationsPerScenario,
      totalSimulations: scenarios.length * distributionSnapshot.simulationsPerScenario,
      conservativeQuantile: 0.20,
      sharedDistribution: true,
      jointPortfolioDistribution: true,
      jointCellCount: combinedJointCells.length,
      persistedForReprice: true,
      targetPriceCalibratesDistribution: false,
    },
    alignmentAudit: {
      instructionVersion: 'MLB 長期正 EV 分析指令｜每日執行最佳化版',
      expertLayer: { used: false, model: null, summary: '', reason: 'GPT不得參與數字評分；本版未使用GPT殘差調整' },
      confirmed: profile.expertAudit?.confirmed || [],
      estimated: profile.expertAudit?.estimated || [],
      unknown: profile.expertAudit?.unknown || [],
      blocking: profile.expertAudit?.blocking || [],
      unmodeled: profile.expertAudit?.unmodeled || [],
      modules: [
        { name: '實際盤口與單邊水位', status: '來源分類；只有實際台灣信用盤＋實際水位可進正式下注' },
        { name: '台灣信用盤逐腿結算與每萬退150', status: '已實作；不得先互抵' },
        { name: '前五局與全場共用聯合比分世界', status: '已實作並保存凍結分布' },
        { name: '目標盤口市場校準', status: '停用；目標價格不回寫比分分布' },
        { name: 'EV雙算', status: '逐比分與結果桶獨立驗算' },
        { name: 'GPT數字評分', status: '停用' },
        { name: '正式／預估打線與捕手', status: profile.statuses.awayLineup === '已確認' && profile.statuses.homeLineup === '已確認' ? '已確認' : '情境建模' },
      ],
    },
    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],
    warnings: Array.isArray(context?.warnings) ? context.warnings : [],
    portfolio: [],
    results,
  };
}

export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {
  const distributionSnapshot = buildDistributionSnapshot({ context, settings });
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}

export function repriceMarkets({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  if (!distributionSnapshot) throw new Error('缺少凍結比分分布，不能進行價格快速重算');
  if (context?.coreFingerprint && distributionSnapshot.coreFingerprint
    && context.coreFingerprint !== distributionSnapshot.coreFingerprint) {
    throw new Error('核心資料指紋已改變，必須完整重算');
  }
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}'''
left = s.find(analysis_start)
if left < 0:
    raise SystemExit('analyzeMarkets marker missing')
s = s[:left] + new_tail + '\n'
p.write_text(s)

# ---------------------------------------------------------------------------
# Stable hash excludes self-referential fingerprint fields.
# ---------------------------------------------------------------------------
p = Path('lib/snapshot-v9.js')
s = p.read_text()
s = one(s,
".filter(key => !['fetchedAt', 'createdAt', 'updatedAt', 'time', 'snapshotId', 'analysis_as_of'].includes(key))",
".filter(key => !['fetchedAt', 'createdAt', 'updatedAt', 'time', 'snapshotId', 'analysis_as_of', 'coreFingerprint', 'priceFingerprint', 'inputHash'].includes(key))",
'snapshot exclusions')
p.write_text(s)

# ---------------------------------------------------------------------------
# Deterministic finalizer: score evidence rows even when legacy score is null,
# require actual source type for formal eligibility, and enforce EV dual-check.
# ---------------------------------------------------------------------------
p = Path('lib/deterministic-finalizer.js')
s = p.read_text()
s = one(s,
"  if (row.integrityWarning && !/評分/.test(clean(row.integrityMessage))) failures.push(clean(row.integrityMessage) || '底層模型完整性警告');",
"  if (row.integrityWarning) failures.push(clean(row.integrityMessage) || '底層模型完整性警告');\n  if (row.evDoubleCheck?.passed !== true) failures.push('EV逐比分與結果桶雙算未通過');",
'finalizer EV dual check')
s = one(s,
"    if (row.water == null || !hasActualWater(row.water)) {",
"    if (row.water == null || !hasActualWater(row.water) || row.weightedEV == null || row.robustEV == null) {",
'finalizer skip gate')
s = one(s,
"    const actualWater = !row.waterEstimated;",
"    const actualWater = !row.waterEstimated && row.sourceType === 'ACTUAL_TW_CREDIT';",
'actual source requirement')
s = one(s,
"    const executable = row.executable !== false;",
"    const executable = row.executable === true;",
'executable strict requirement')
s = one(s,
"    row.scoreType = actualWater ? '正式下注評分' : '參考盤篩選評分｜非最終下注評分';",
"    row.scoreType = actualWater && executable ? '正式下注評分' : '參考盤篩選評分｜非最終下注評分';",
'score type')
p.write_text(s)

# ---------------------------------------------------------------------------
# Full analysis route: establish the core fingerprint before generating the
# distribution; return the compact immutable distribution only in repriceSnapshot.
# ---------------------------------------------------------------------------
Path('app/api/analyze/route.js').write_text(r'''import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  positiveInteger,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 90;
export const dynamic = 'force-dynamic';

const responseCache = globalThis.__MLB_V91_ANALYSIS_CACHE__ || new Map();
globalThis.__MLB_V91_ANALYSIS_CACHE__ = responseCache;

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeGame(game) {
  const safe = {
    gamePk: positiveInteger(game?.gamePk), gameDate: cleanText(game?.gameDate, 40), officialDate: cleanText(game?.officialDate, 20),
    status: cleanText(game?.status, 60), statusEnglish: cleanText(game?.statusEnglish, 60), statusCode: cleanText(game?.statusCode, 10),
    doubleHeader: cleanText(game?.doubleHeader, 10), gameNumber: positiveInteger(game?.gameNumber) || 1,
    scheduledInnings: positiveInteger(game?.scheduledInnings) || 9, away: cleanText(game?.away, 80), home: cleanText(game?.home, 80),
    awayEnglish: cleanText(game?.awayEnglish, 80), homeEnglish: cleanText(game?.homeEnglish, 80), venue: cleanText(game?.venue, 100),
    venueEnglish: cleanText(game?.venueEnglish, 100), awayTeamId: positiveInteger(game?.awayTeamId), homeTeamId: positiveInteger(game?.homeTeamId),
    venueId: positiveInteger(game?.venueId), awayProbableId: positiveInteger(game?.awayProbableId), homeProbableId: positiveInteger(game?.homeProbableId),
    awayProbable: cleanText(game?.awayProbable, 80), homeProbable: cleanText(game?.homeProbable, 80),
  };
  return safe.gamePk && safe.awayTeamId && safe.homeTeamId && safe.away && safe.home ? safe : null;
}

function gameAlreadyStarted(game) {
  const text = `${game?.statusCode || ''} ${game?.statusEnglish || ''} ${game?.status || ''}`.toLowerCase();
  return /in progress|game over|final|completed|live/.test(text) || ['I', 'F', 'O'].includes(String(game?.statusCode || '').toUpperCase());
}

function cleanVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 4).map(source => ({
    provider: cleanText(source?.provider, 80), independentGroup: cleanText(source?.independentGroup, 80),
    observedAt: cleanText(source?.observedAt, 40), contractKey: cleanText(source?.contractKey, 160),
  })).filter(source => source.provider && source.independentGroup && source.observedAt && source.contractKey);
  const groups = new Set(sources.map(source => source.independentGroup));
  return { sources, verified: value.verified === true && sources.length >= 2 && groups.size >= 2, policyStatus: cleanText(value.policyStatus, 80) || 'MANUAL_EVIDENCE_ONLY' };
}

function sanitizeMarketRows(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
  })).filter(row => row.market);
}

function cacheSet(key, value) {
  responseCache.set(key, value);
  while (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'analyze-v9-1-deterministic', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500000);
    const game = sanitizeGame(body.game);
    if (!game || !Array.isArray(body.markets)) return NextResponse.json({ ok: false, error: '缺少或無效的賽事／盤口資料' }, { status: 400 });
    if (gameAlreadyStarted(game)) return NextResponse.json({ ok: false, error: '比賽已開打或結束｜賽前模型停止評分' }, { status: 409 });

    const markets = sanitizeMarketRows(body.markets, 12);
    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `⛔ QA未通過｜不評分｜不下注：${[...new Set(errors)].join('、')}` }, { status: 400 });
    const activeMarkets = markets.filter(row => row.pick);
    if (!activeMarkets.length) return NextResponse.json({ ok: false, error: '目前沒有任何已開盤市場可分析' }, { status: 400 });

    const settings = {
      rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)), candidateThreshold: 7.2, strongestThreshold: 8.5,
      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))), expertMode: 'off',
    };
    const versions = {
      modelVersion: MODEL_VERSION, rulesVersion: RULES_VERSION, dataVersion: DATA_VERSION,
      scoreFormulaVersion: SCORE_FORMULA_VERSION, settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION,
    };
    const context = await Promise.race([
      buildGameContext(game),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB資料取得逾時，請稍後重試')), 30000)),
    ]);
    const coreOnly = buildSnapshotFingerprints({ context, markets: [], versions });
    const frozenContext = { ...context, coreFingerprint: coreOnly.coreFingerprint };
    const preliminary = analyzeMarkets({ context: frozenContext, markets: activeMarkets, previousMarkets, settings });
    const deterministic = finalizeDeterministicAnalysis({ analysis: preliminary, game, settings });
    const fingerprints = buildSnapshotFingerprints({ context: frozenContext, markets: activeMarkets, versions });
    const cached = responseCache.get(fingerprints.inputHash);
    if (cached) return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'HIT' } });

    const distributionSnapshot = deterministic.distributionSnapshot;
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const analysisAsOf = new Date().toISOString();
    const lineAsOf = activeMarkets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf;
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, analysisType: 'FULL', dataVersion: DATA_VERSION,
      dataAsOf: frozenContext.fetchedAt || analysisAsOf, lineAsOf, analysisAsOf, snapshotId: fingerprints.inputHash,
    };
    const repriceSnapshot = {
      frozenContext, distributionSnapshot, coreFingerprint: fingerprints.coreFingerprint, priceFingerprint: fingerprints.priceFingerprint,
      inputHash: fingerprints.inputHash, distributionId: finalized.distributionId, distributionHash: finalized.distributionHash,
      dataAsOf: finalized.dataAsOf, simulationsPerScenario: finalized.scenarioSummary?.simulationsPerScenario, versions,
    };
    const payload = { ok: true, game, context: frozenContext, analysis: finalized, repriceSnapshot, openMarkets: [...new Set(activeMarkets.map(row => row.market))] };
    cacheSet(fingerprints.inputHash, payload);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store', 'X-Analysis-Cache': 'MISS' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
''')

# ---------------------------------------------------------------------------
# Price-only route consumes the frozen distribution cells directly. It never
# calls buildGameContext, scenarioGrid, simulateScenario, or GPT.
# ---------------------------------------------------------------------------
Path('app/api/reprice/route.js').write_text(r'''import { NextResponse } from 'next/server';
import { repriceMarkets, MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';
import { finalizeDeterministicAnalysis, UNCERTAINTY_SET_VERSION } from '../../../lib/deterministic-finalizer.js';
import { SCORE_FORMULA_VERSION } from '../../../lib/deterministic-score.js';
import { SETTLEMENT_RULE_VERSION } from '../../../lib/taiwan-settlement-v9.js';
import { buildSnapshotFingerprints, DATA_VERSION, REPRICE_VERSION } from '../../../lib/snapshot-v9.js';
import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function cleanVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 4).map(source => ({
    provider: cleanText(source?.provider, 80), independentGroup: cleanText(source?.independentGroup, 80),
    observedAt: cleanText(source?.observedAt, 40), contractKey: cleanText(source?.contractKey, 160),
  })).filter(source => source.provider && source.independentGroup && source.observedAt && source.contractKey);
  return { sources, verified: value.verified === true && sources.length >= 2 && new Set(sources.map(source => source.independentGroup)).size >= 2 };
}
function sanitizeMarkets(rows, maximum = 16) {
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => ({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
  })).filter(row => row.market);
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reprice-v9-1', limit: 120, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 8_000_000);
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
    const context = snapshot?.frozenContext;
    const distributionSnapshot = snapshot?.distributionSnapshot;
    if (!context?.game?.gamePk || !snapshot?.coreFingerprint || !distributionSnapshot?.distributionHash) {
      return NextResponse.json({ ok: false, error: '缺少已保存的凍結比分分布，不能快速重算' }, { status: 400 });
    }
    if (distributionSnapshot.distributionId !== snapshot.distributionId || distributionSnapshot.distributionHash !== snapshot.distributionHash) {
      return NextResponse.json({ ok: false, error: '凍結比分分布識別不一致，已停止快速重算' }, { status: 409 });
    }
    const markets = sanitizeMarkets(body.markets, 12);
    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);
    const errors = [];
    for (const name of MARKET_ORDER) {
      const pair = markets.filter(row => row.market === name);
      if (!marketIsOpen(pair)) continue;
      errors.push(...validateMarketPair(name, pair).map(error => `${name}：${error}`));
    }
    if (errors.length) return NextResponse.json({ ok: false, error: `盤口快速重算QA未通過：${[...new Set(errors)].join('、')}` }, { status: 400 });
    if (!markets.some(row => row.pick)) return NextResponse.json({ ok: false, error: '沒有可重算的盤口' }, { status: 400 });

    const settings = { rebateRate: Math.max(0, Math.min(0.1, Number(body.settings?.rebateRate) || 0.015)), candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: distributionSnapshot.simulationsPerScenario, expertMode: 'off' };
    const preliminary = repriceMarkets({ context, markets, previousMarkets, settings, distributionSnapshot });
    const deterministic = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
    const { distributionSnapshot: omitted, ...analysisWithoutDistribution } = deterministic;
    const versions = { modelVersion: MODEL_VERSION, rulesVersion: RULES_VERSION, dataVersion: DATA_VERSION, scoreFormulaVersion: SCORE_FORMULA_VERSION, settlementRuleVersion: SETTLEMENT_RULE_VERSION, uncertaintySetVersion: UNCERTAINTY_SET_VERSION, repriceVersion: REPRICE_VERSION };
    const fingerprints = buildSnapshotFingerprints({ context, markets, versions });
    if (fingerprints.coreFingerprint !== snapshot.coreFingerprint) return NextResponse.json({ ok: false, error: '核心資料指紋已改變，必須完整重算' }, { status: 409 });
    if (analysisWithoutDistribution.distributionId !== snapshot.distributionId || analysisWithoutDistribution.distributionHash !== snapshot.distributionHash) {
      return NextResponse.json({ ok: false, error: '快速重算不得改變比分分布' }, { status: 409 });
    }
    const analysisAsOf = new Date().toISOString();
    const finalized = {
      ...analysisWithoutDistribution, ...fingerprints, analysisType: 'PRICE_ONLY_REPRICE', repriceVersion: REPRICE_VERSION,
      parentInputHash: snapshot.inputHash || null, parentDistributionId: snapshot.distributionId, distributionReused: true,
      dataAsOf: snapshot.dataAsOf || context.fetchedAt || null,
      lineAsOf: markets.map(row => row.lineAsOf).filter(Boolean).sort().at(-1) || analysisAsOf,
      analysisAsOf, snapshotId: fingerprints.inputHash,
    };
    const repriceSnapshot = {
      ...snapshot, priceFingerprint: fingerprints.priceFingerprint, inputHash: fingerprints.inputHash,
      distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, versions,
    };
    return NextResponse.json({
      ok: true, game: context.game, context, analysis: finalized, repriceSnapshot,
      openMarkets: [...new Set(markets.map(row => row.market))],
      reprice: { distributionReused: true, noCoreDataFetch: true, noSimulation: true, noGpt: true, distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, coreFingerprint: snapshot.coreFingerprint, previousInputHash: snapshot.inputHash || null, newInputHash: fingerprints.inputHash },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
''')

# ---------------------------------------------------------------------------
# Import pipeline preserves explicit source/executable fields.
# ---------------------------------------------------------------------------
p = Path('lib/batch.js')
s = p.read_text()
s = one(s,
"  return { pick: '', water: null, waterEstimated: false, waterMissing: false, confidence: 0 };",
"  return { pick: '', water: null, waterEstimated: false, waterMissing: false, confidence: 0, sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: '', executable: true, marketVerification: null };",
'blank direction provenance')
s = s.replace("directions.map(direction => ({ ...direction, water: fallback, waterEstimated: true, waterMissing: false }))", "directions.map(direction => ({ ...direction, water: fallback, waterEstimated: true, waterMissing: false, sourceType: 'ESTIMATED', executable: false }))")
s = one(s,
"      confidence: Number(direction.confidence || 0),",
"      confidence: Number(direction.confidence || 0),\n      sourceType: direction.waterEstimated ? 'ESTIMATED' : (direction.sourceType || 'ACTUAL_TW_CREDIT'),\n      lineAsOf: direction.lineAsOf || new Date().toISOString(),\n      executable: direction.waterEstimated ? false : direction.executable !== false,\n      marketVerification: direction.marketVerification || null,",
'flatten provenance')
p.write_text(s)

# ---------------------------------------------------------------------------
# UI source classification, current-line minimum water and hole audit.
# ---------------------------------------------------------------------------
p = Path('app/page.js')
s = p.read_text()
s = s.replace("const VERSION = '9.0.0-preview';", "const VERSION = '9.1.0-preview';")
s = s.replace("const STORAGE = 'mlb-positive-ev-v9-preview';", "const STORAGE = 'mlb-positive-ev-v9-1-preview';")
# Picker edits preserve explicit provenance.
needle = "          if (key === 'waterEstimated') return { ...direction, waterEstimated: Boolean(value), waterMissing: false };"
replacement = "          if (key === 'waterEstimated') return { ...direction, waterEstimated: Boolean(value), waterMissing: false, sourceType: value ? 'ESTIMATED' : direction.sourceType };\n          if (key === 'sourceType') return { ...direction, sourceType: value, executable: value === 'ACTUAL_TW_CREDIT' ? direction.executable !== false : false };\n          if (key === 'executable') return { ...direction, executable: Boolean(value) };"
s = one(s, needle, replacement, 'direction provenance edits')
old_confirm = '''                <label>水位<input type="number" step=".001" value={direction.water ?? ''} placeholder="可留空" onChange={event => editDirection(market, index, 'water', event.target.value)}/></label>
                <small>辨識信心 {Math.round(Number(direction.confidence || 0) * 100)}%｜{direction.waterEstimated ? '暫估水位' : direction.waterMissing ? '水位未提供' : hasActualWater(direction.water) ? '實際水位' : '未開盤'}</small>'''
new_confirm = '''                <label>水位<input type="number" step=".001" value={direction.water ?? ''} placeholder="可留空" onChange={event => editDirection(market, index, 'water', event.target.value)}/></label>
                <label>盤口來源<select value={direction.sourceType || 'ACTUAL_TW_CREDIT'} onChange={event => editDirection(market, index, 'sourceType', event.target.value)}><option value="ACTUAL_TW_CREDIT">實際台灣信用盤</option><option value="REFERENCE">參考盤</option><option value="INTERNATIONAL">國際盤／使用者匯入</option><option value="HISTORICAL">歷史價格</option><option value="ESTIMATED">暫估水位</option></select></label>
                <label className="check"><input type="checkbox" checked={direction.executable !== false && direction.sourceType === 'ACTUAL_TW_CREDIT'} disabled={direction.sourceType !== 'ACTUAL_TW_CREDIT'} onChange={event => editDirection(market, index, 'executable', event.target.checked)}/>目前仍可下注</label>
                <small>辨識信心 {Math.round(Number(direction.confidence || 0) * 100)}%｜{direction.waterEstimated ? '暫估水位' : direction.waterMissing ? '水位未提供' : hasActualWater(direction.water) ? '已輸入水位' : '未開盤'}｜{direction.sourceType || 'ACTUAL_TW_CREDIT'}｜{direction.executable !== false ? '可執行' : '非正式下注價格'}</small>'''
s = one(s, old_confirm, new_confirm, 'confirm source UI')
# Reprice chain reads any previous version with immutable distribution snapshot.
s = one(s,
"      .find(item => latestVersion(store.analysisHistory, item.id)?.repriceSnapshot);",
"      .find(item => latestVersion(store.analysisHistory, item.id)?.repriceSnapshot?.distributionSnapshot);",
'reprice parent distribution')
# Mobile result details.
classic_anchor = '''    {score != null && <><div className="classicMeta">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜Unit {result.unitSuggestion == null ? '待風控公式校準' : `${unit}`}</div><div className="classicMeta">固定公式：{result.scoreFormulaVersion || '—'}{result.scoreBreakdown?.caps?.length ? `｜封頂 ${result.scoreBreakdown.caps.join('、')}` : ''}</div>{score >= 7.2 && <div className="classicMeta">QA：PASS｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 市場{score >= 8.5 ? '✓' : '—'} 分數上限✓</div>}</>}'''
classic_new = '''    {score != null && <><div className="classicMeta">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜Unit {result.unitSuggestion == null ? '待風控公式校準' : `${unit}`}</div><div className="classicMeta">固定公式：{result.scoreFormulaVersion || '—'}{result.scoreBreakdown?.caps?.length ? `｜封頂 ${result.scoreBreakdown.caps.join('、')}` : ''}</div>{score >= 7.2 && <div className="classicMeta">QA：PASS｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 市場{score >= 8.5 ? '✓' : '—'} 分數上限✓</div>}{result.minimumWater?.score7_2?.requiredWater != null && <div className="classicMeta">目前盤口7.2最低水位：{result.minimumWater.score7_2.comparator} {Number(result.minimumWater.score7_2.requiredWater).toFixed(3)}｜距離PASS {Number(result.minimumWater.score7_2.distanceFromCurrent).toFixed(3)}</div>}{result.holeAudit?.audits?.map((audit, index) => <div className="classicMeta" key={`hole-${index}`}>洞口驗算：{audit.trigger}｜贏 {pct(audit.winFraction)}／輸 {pct(audit.lossFraction)}／走 {pct(audit.pushFraction)}｜每萬 {money(audit.netProfitPer10000)}</div>)}</>}'''
s = one(s, classic_anchor, classic_new, 'classic threshold and hole')
# Fixed score note indicates frozen-distribution reprice.
s = s.replace('雙EV短板法｜GPT不得調分', '雙EV短板法｜GPT不得調分｜價格變動沿用凍結比分分布')
p.write_text(s)

# ---------------------------------------------------------------------------
# Health/version/package/tests/readme
# ---------------------------------------------------------------------------
p = Path('app/api/health/route.js')
s = p.read_text().replace("version: '9.0.0-preview'", "version: '9.1.0-preview'")
p.write_text(s)

p = Path('package.json')
package = json.loads(p.read_text())
package['version'] = '9.1.0-preview'
p.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
Path('DEPLOYMENT_VERSION').write_text('9.1.0-preview-frozen-distribution-precise-ev\n')

p = Path('scripts/deterministic-v9-test.mjs')
s = p.read_text()
s += r'''

// Source/eligibility and score boundaries remain deterministic.
assert.equal(score(0.08, 0.048, { crossMarketVerified: false }).score, 8.4);
assert.equal(score(0.08, 0.048, { crossMarketVerified: true }).score, 8.6);
'''
p.write_text(s)

p = Path('README.md')
s = p.read_text()
s += r'''

## 9.1.0 Preview｜凍結比分分布、EV雙算與來源資格

- 正式EV不再用目標盤口價格回寫或校準比分分布；市場價格只作結算價格與市場差異診斷。
- 完整分析保存每個情境的壓縮聯合比分分布；`/api/reprice`直接讀取該分布，不重新抓資料、不重新模擬、不呼叫GPT。
- 每個結果以逐比分逐腿損益及結算結果桶兩種方式獨立計算EV，誤差容忍0.01%。
- `coreFingerprint`在模擬前建立並進入固定seed；核心資料改變必定建立不同distribution hash。
- 只有`ACTUAL_TW_CREDIT`、實際水位且仍可下注的方向可進正式下注池；參考盤、國際盤、歷史盤與暫估盤只作非最終篩選。
- 每個方向輸出目前盤口的7.2／7.5／8.0／8.5水位門檻，以及整數洞口逐腿每萬損益。
'''
p.write_text(s)

print('v9.1 frozen distribution and precise EV integration applied')
