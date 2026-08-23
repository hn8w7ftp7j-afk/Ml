import Decimal from 'decimal.js';
import {
  DEFAULT_MODEL_CONFIG,
  FORMAL_ANALYSIS_MODE,
  SHADOW_ANALYSIS_MODE,
  SHADOW_RESULT_TAG,
  SHADOW_SCORE_TYPE,
  assertAnalysisModeContract,
  buildDistributionSnapshot as buildLegacyDistributionSnapshot,
  enforceAnalysisModeSafety,
  enforceShadowAnalysisSafety,
} from './analysis.js';
import {
  MARKET_ORDER,
  breakEvenProbability,
  calculateProfit,
  hasActualWater,
  normalizeWater,
  outcomeSettlementForScore,
  parseTaiwanLine,
} from './markets.js';
import { qualifyEvV103, EV_CALIBRATION_V103_VERSION } from './ev-calibration-v103.js';

export {
  DEFAULT_MODEL_CONFIG,
  FORMAL_ANALYSIS_MODE,
  SHADOW_ANALYSIS_MODE,
  SHADOW_RESULT_TAG,
  SHADOW_SCORE_TYPE,
  assertAnalysisModeContract,
  enforceAnalysisModeSafety,
  enforceShadowAnalysisSafety,
};

export const MODEL_VERSION = 'BASEBALL-RAW-JOINT-SCORE-DISTRIBUTION-2026-08-v10.0.0';
export const RULES_VERSION = 'BASEBALL-TW-RAW-EV-NO-TARGET-CALIBRATION-2026-08-v10.0.0';
export const ANALYSIS_V10_VERSION = 'BASEBALL-RAW-WEIGHTED-ROBUST-EV-2026-08-v10.1.0';
export const ROBUST_EV_VERSION = 'SCENARIO-Q10-NUMERICAL-LB-DATA-MARGIN-v1.0.0';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value || '').trim();

function normalizedTeam(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function expandJoint(rows) {
  return (rows || []).map(row => ({
    awayFirst5: Number(row[0]),
    homeFirst5: Number(row[1]),
    awayRuns: Number(row[2]),
    homeRuns: Number(row[3]),
    probability: Number(row[4]),
  })).filter(row => Number.isFinite(row.probability) && row.probability > 0);
}

function distributionForMarket(cells, market) {
  const first5 = clean(market).includes('上半');
  return (cells || []).map(cell => ({
    awayRuns: first5 ? cell.awayFirst5 : cell.awayRuns,
    homeRuns: first5 ? cell.homeFirst5 : cell.homeRuns,
    probability: cell.probability,
  }));
}

function summaryForContract({ cells, pick, water, context, rebateRate }) {
  const parsed = parseTaiwanLine(pick);
  const values = {
    coverage: new Decimal(0),
    ev: new Decimal(0),
    secondMoment: new Decimal(0),
    equivalentWin: new Decimal(0),
    equivalentLoss: new Decimal(0),
    equivalentPush: new Decimal(0),
    fullWin: new Decimal(0),
    partialWin: new Decimal(0),
    push: new Decimal(0),
    partialLoss: new Decimal(0),
    fullLoss: new Decimal(0),
    mixedWinLoss: new Decimal(0),
    mixedNeutral: new Decimal(0),
    exactLineProbability: new Decimal(0),
  };
  const buckets = new Map();
  let minimumProfit = Infinity;
  let maximumProfit = -Infinity;

  for (const cell of cells || []) {
    const probability = new Decimal(finite(cell.probability, 0));
    if (probability.lte(0)) continue;
    const settlement = outcomeSettlementForScore(parsed, cell.awayRuns, cell.homeRuns, context?.game?.away, context?.game?.home);
    if (!settlement) continue;
    const calculation = calculateProfit({ stake: 1, water, settlement, rebateRate });
    const profit = new Decimal(calculation.profit || 0);
    const win = new Decimal(settlement.winFraction || 0);
    const loss = new Decimal(settlement.lossFraction || 0);
    const push = new Decimal(settlement.pushFraction || 0);
    const net = win.minus(loss);

    values.coverage = values.coverage.plus(probability);
    values.ev = values.ev.plus(probability.mul(profit));
    values.secondMoment = values.secondMoment.plus(probability.mul(profit.pow(2)));
    values.equivalentWin = values.equivalentWin.plus(probability.mul(win));
    values.equivalentLoss = values.equivalentLoss.plus(probability.mul(loss));
    values.equivalentPush = values.equivalentPush.plus(probability.mul(push));
    minimumProfit = Math.min(minimumProfit, profit.toNumber());
    maximumProfit = Math.max(maximumProfit, profit.toNumber());

    if (win.eq(1) && loss.eq(0)) values.fullWin = values.fullWin.plus(probability);
    else if (loss.eq(1) && win.eq(0)) values.fullLoss = values.fullLoss.plus(probability);
    else if (win.eq(0) && loss.eq(0)) values.push = values.push.plus(probability);
    else if (win.gt(0) && loss.gt(0)) {
      values.mixedWinLoss = values.mixedWinLoss.plus(probability);
      if (net.gt(0)) values.partialWin = values.partialWin.plus(probability);
      else if (net.lt(0)) values.partialLoss = values.partialLoss.plus(probability);
      else values.mixedNeutral = values.mixedNeutral.plus(probability);
    } else if (win.gt(0)) values.partialWin = values.partialWin.plus(probability);
    else if (loss.gt(0)) values.partialLoss = values.partialLoss.plus(probability);
    else values.push = values.push.plus(probability);

    if ((settlement.legs || []).some(leg => leg.exactLine)) {
      values.exactLineProbability = values.exactLineProbability.plus(probability);
    }
    const signature = (settlement.legs || []).map(leg => [
      Number(leg.allocation || 0).toFixed(12),
      Number(leg.winShare || 0).toFixed(12),
      Number(leg.lossShare || 0).toFixed(12),
      Number(leg.pushShare || 0).toFixed(12),
      Number(calculation.profit || 0).toFixed(12),
    ].join(':')).join('|');
    const bucket = buckets.get(signature) || { probability: new Decimal(0), profit };
    bucket.probability = bucket.probability.plus(probability);
    buckets.set(signature, bucket);
  }

  const bucketEV = [...buckets.values()].reduce(
    (sum, bucket) => sum.plus(bucket.probability.mul(bucket.profit)),
    new Decimal(0),
  );
  const resolved = values.equivalentWin.plus(values.equivalentLoss);
  const probability = resolved.gt(0) ? values.equivalentWin.div(resolved) : new Decimal(0.5);
  const fairWater = values.equivalentWin.gt(0)
    ? values.equivalentLoss.mul(new Decimal(1).minus(rebateRate)).div(values.equivalentWin).minus(rebateRate)
    : new Decimal(1.5);
  const ev = values.ev.toNumber();
  const variance = Decimal.max(0, values.secondMoment.minus(values.ev.pow(2))).toNumber();
  const categoryCoverage = values.fullWin.plus(values.partialWin).plus(values.push)
    .plus(values.partialLoss).plus(values.fullLoss).plus(values.mixedNeutral);
  return {
    coverage: values.coverage.toNumber(),
    categoryCoverage: categoryCoverage.toNumber(),
    ev,
    evFromBuckets: bucketEV.toNumber(),
    evDoubleCheckError: values.ev.minus(bucketEV).abs().toNumber(),
    variance,
    standardDeviation: Math.sqrt(Math.max(0, variance)),
    equivalentWin: values.equivalentWin.toNumber(),
    equivalentLoss: values.equivalentLoss.toNumber(),
    equivalentPush: values.equivalentPush.toNumber(),
    modelProbability: probability.toNumber(),
    fairWater: clamp(fairWater.toNumber(), 0.5, 1.5),
    fullWin: values.fullWin.toNumber(),
    partialWin: values.partialWin.toNumber(),
    push: values.push.toNumber(),
    partialLoss: values.partialLoss.toNumber(),
    fullLoss: values.fullLoss.toNumber(),
    mixedWinLoss: values.mixedWinLoss.toNumber(),
    mixedNeutral: values.mixedNeutral.toNumber(),
    exactLineProbability: values.exactLineProbability.toNumber(),
    minimumProfit: Number.isFinite(minimumProfit) ? minimumProfit : null,
    maximumProfit: Number.isFinite(maximumProfit) ? maximumProfit : null,
  };
}

function weightedQuantile(values, quantile) {
  const rows = values.filter(row => Number.isFinite(row.value) && Number(row.weight) > 0)
    .sort((left, right) => left.value - right.value);
  const total = rows.reduce((sum, row) => sum + Number(row.weight), 0);
  if (!rows.length || total <= 0) return null;
  let cumulative = 0;
  for (const row of rows) {
    cumulative += Number(row.weight) / total;
    if (cumulative + 1e-12 >= quantile) return Number(row.value);
  }
  return Number(rows.at(-1).value);
}

function marketAnchorInfo(rows, row, rebateRate) {
  const actual = rows.filter(item => hasActualWater(item.water) && !item.waterEstimated);
  if (actual.length === 2) {
    const implied = actual.map(item => breakEvenProbability(item.water, rebateRate));
    const total = implied[0] + implied[1];
    const index = actual.indexOf(row);
    if (total > 0 && index >= 0) return { probability: implied[index] / total, source: 'Tai888雙邊去水診斷', paired: true };
  }
  return hasActualWater(row?.water)
    ? { probability: breakEvenProbability(row.water, rebateRate), source: 'Tai888單邊損益兩平診斷', paired: false }
    : { probability: null, source: '無可用市場診斷', paired: false };
}

function sameContractDirection(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick);
  const right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.isTotal !== right.isTotal) return false;
  if (left.isTotal) return Boolean(left.isOver === right.isOver && left.isUnder === right.isUnder);
  return normalizedTeam(left.team) === normalizedTeam(right.team);
}

function previousMarketRow(previousMarkets, row) {
  return (Array.isArray(previousMarkets) ? previousMarkets : [])
    .filter(previous => previous?.market === row.market && sameContractDirection(previous.pick, row.pick)).at(-1) || null;
}

function movementComparison({ previous, row, cells, context, rebateRate, weightedEV }) {
  if (!previous) return { available: false, reason: '無可比較舊盤' };
  if (clean(previous.pick) !== clean(row.pick)) {
    return {
      available: true,
      lineChanged: true,
      previousPick: previous.pick,
      previousWater: hasActualWater(previous.water) ? Number(previous.water) : null,
      currentPick: row.pick,
      currentWater: row.water,
      verdict: '盤口合約已改變，改由下注帳本逐比分payoff比較，不在EV模型混算',
    };
  }
  if (!hasActualWater(previous.water)) return { available: true, lineChanged: false, reason: '舊盤水位缺失' };
  const previousSummary = summaryForContract({ cells, pick: previous.pick, water: normalizeWater(previous.water), context, rebateRate });
  const deltaEV = weightedEV - previousSummary.ev;
  return {
    available: true,
    lineChanged: false,
    previousPick: previous.pick,
    previousWater: Number(previous.water),
    currentPick: row.pick,
    currentWater: row.water,
    previousWeightedEV: previousSummary.ev,
    deltaEV,
    verdict: deltaEV > 0.005 ? '目前價格較有利' : deltaEV < -0.005 ? '目前價格較差' : '目前價格與舊盤接近',
    method: '同一凍結聯合比分分布直接重算新舊成交水位',
  };
}

function contextGate(context) {
  if (context?.dataGateV10) return context.dataGateV10;
  const passed = context?.coreModelable !== false;
  return {
    version: 'ASIAN-CONTEXT-SHADOW-GATE-v1',
    rows: [],
    missing: passed ? [] : ['coreModelable'],
    projected: ['leagueModelCalibration'],
    blocking: passed ? [] : ['coreModelable'],
    passedForShadowScore: passed,
    passedForFormalScore: false,
    quality: clamp(finite(context?.dataQuality, 0.68), 0.50, 0.90),
    modelErrorMarginEV: 0.008,
  };
}

function robustEvaluation({ scenarioRows, snapshot, gate, weightedEV }) {
  const q10 = weightedQuantile(scenarioRows.map(row => ({ value: row.value, weight: row.weight })), 0.10) ?? weightedEV;
  const simulations = Math.max(1, Number(snapshot?.simulationsPerScenario || 1));
  const numericVariance = scenarioRows.reduce((sum, row) => {
    const weight = Number(row.weight || 0);
    return sum + weight * weight * Math.max(0, Number(row.summary?.variance || 0)) / simulations;
  }, 0);
  const numericSE = Math.sqrt(Math.max(0, numericVariance));
  const numericLower95 = weightedEV - 1.645 * numericSE;
  const modelErrorMarginEV = clamp(finite(gate?.modelErrorMarginEV, 0.008), 0.003, 0.05);
  const errorAdjustedLower = numericLower95 - modelErrorMarginEV;
  const robustEV = Math.min(weightedEV, q10, errorAdjustedLower);
  const flipProbability = scenarioRows.filter(row => row.value <= 0)
    .reduce((sum, row) => sum + Number(row.weight || 0), 0);
  return {
    robustEV,
    q10,
    numericSE,
    numericLower95,
    modelErrorMarginEV,
    errorAdjustedLower,
    flipProbability,
    variants: [
      { id: 'scenario-q10', description: '27情境加權第10百分位', value: q10 },
      { id: 'numeric-lower', description: 'Monte Carlo單側95%下界', value: numericLower95 },
      { id: 'error-adjusted', description: '數值下界再扣資料／模型誤差', value: errorAdjustedLower },
    ].sort((left, right) => left.value - right.value),
  };
}

function waterForTarget(summary, targetEV, rebateRate) {
  const win = finite(summary?.equivalentWin, 0);
  const loss = finite(summary?.equivalentLoss, 0);
  if (win <= 0) return null;
  return (Number(targetEV || 0) + loss * (1 - rebateRate)) / win - rebateRate;
}

function minimumWaterThresholds(weightedSummary, scenarioRows, rebateRate, crossMarketVerified) {
  const required = (weightedTarget, robustTarget) => {
    const weighted = waterForTarget(weightedSummary, weightedTarget, rebateRate);
    const robustCandidates = scenarioRows.map(row => waterForTarget(row.summary, robustTarget, rebateRate)).filter(Number.isFinite);
    const robust = robustCandidates.length ? Math.max(...robustCandidates) : null;
    const values = [weighted, robust].filter(Number.isFinite);
    return {
      weightedWater: weighted,
      robustWater: robust,
      requiredWater: values.length ? Math.max(...values) : null,
    };
  };
  return {
    currentLineOnly: true,
    score7_2: required(0, 0),
    score7_5: required(0.020, 0.008),
    score8_0: required(0.040, 0.020),
    score8_5: { ...required(0.070, 0.040), crossMarketVerified, marketQualificationRequired: true },
  };
}

function primaryRisks({ gate, robust, marketName, rawGap, context }) {
  const risks = [];
  if ((gate?.projected || []).length) risks.push(`預估資料：${gate.projected.join('、')}`);
  if ((gate?.missing || []).length) risks.push(`缺失資料：${gate.missing.join('、')}`);
  if (rawGap != null && rawGap >= 0.08) risks.push(`棒球分布與Tai888去水市場差距 ${(rawGap * 100).toFixed(1)}%，只列為QA風險，未反校準EV`);
  if (robust.numericLower95 <= 0) risks.push('Monte Carlo單側95%下界跨越0');
  if (robust.errorAdjustedLower <= 0) risks.push('扣除資料／模型誤差後EV非正');
  if (robust.flipProbability > 0.20) risks.push(`情境EV翻負權重 ${(robust.flipProbability * 100).toFixed(0)}%`);
  if (marketName.includes('上半')) risks.push('前五局對先發臨場狀態與提前退場較敏感');
  if (context?.weather?.directionalWindApplied === false) risks.push('缺少球場方位，未猜測順逆風平均效果');
  return risks;
}

function integrityAudit({ summary, scenarioRows, weightedEV, scenarioWeightedEV, robust, gate }) {
  const failures = [];
  if (Math.abs(summary.coverage - 1) > 1e-9) failures.push('聯合比分分布總和不等於1');
  if (Math.abs(summary.categoryCoverage - summary.coverage) > 1e-9) failures.push('結算分類未完整覆蓋分布');
  if (summary.evDoubleCheckError > 1e-9) failures.push('逐比分EV與結算桶EV不一致');
  if (Math.abs(weightedEV - scenarioWeightedEV) > 1e-6) failures.push('合併分布EV與27情境加權EV不一致');
  if (!Number.isFinite(weightedEV) || !Number.isFinite(robust.robustEV)) failures.push('EV不是有限數值');
  if (robust.robustEV > weightedEV + 1e-12) failures.push('Robust EV高於Weighted EV');
  if (weightedEV > 0 && robust.numericLower95 <= 0) failures.push('正EV數值信賴下界跨0');
  if (gate?.passedForShadowScore !== true) failures.push(`資料Gate未通過：${(gate?.blocking || []).join('、') || '核心資料缺失'}`);
  return { passed: failures.length === 0, failures };
}

export function buildDistributionSnapshot({ context, settings = {} }) {
  const simulationsPerScenario = Math.max(4000, Math.round(Number(settings.simulationsPerScenario) || 4000));
  return buildLegacyDistributionSnapshot({
    context,
    settings: { ...settings, simulationsPerScenario },
  });
}

export function evaluateMarketsFromDistribution({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  const contract = assertAnalysisModeContract(context);
  if (!distributionSnapshot || distributionSnapshot.modelVersion !== contract.modelVersion
    || distributionSnapshot.rulesVersion !== contract.rulesVersion) {
    throw new Error('V10凍結聯合比分分布版本不相容，必須完整重算');
  }
  const rebateRate = clamp(finite(settings.rebateRate, 0.015), 0, 0.1);
  const scenarios = (distributionSnapshot.scenarios || []).map(scenario => ({
    ...scenario,
    weight: Number(scenario.weight || 0),
    joint: expandJoint(scenario.joint),
  }));
  const combinedJoint = expandJoint(distributionSnapshot.combinedJoint);
  const gate = contextGate(context);
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const rows = (Array.isArray(markets) ? markets : []).filter(row => row?.market === marketName && clean(row?.pick)).slice(0, 2);
    if (!rows.length) continue;
    const combinedDistribution = distributionForMarket(combinedJoint, marketName);
    for (const row of rows) {
      const anchor = marketAnchorInfo(rows, row, rebateRate);
      const previous = previousMarketRow(previousMarkets, row);
      if (!hasActualWater(row.water)) {
        results.push({
          ...row,
          water: null,
          waterMissing: true,
          waterEstimated: false,
          modelProbability: null,
          rawModelProbability: null,
          marketAnchorProbability: anchor.probability,
          marketAnchorSource: anchor.source,
          marketCalibrationApplied: false,
          weightedEV: null,
          robustEV: null,
          conservativeEV: null,
          rawEV: null,
          ev: null,
          score: null,
          tag: '水位未提供｜不評分',
          betEligible: false,
          distributionCoverage: 1,
          dataGateV10: gate,
          numericalQA: { passed: false, skipped: true, reason: '水位未提供' },
          evDoubleCheck: { passed: true, skipped: true },
          movement: { available: false, reason: '水位未提供' },
        });
        continue;
      }

      const water = normalizeWater(row.water);
      const weightedSummary = summaryForContract({ cells: combinedDistribution, pick: row.pick, water, context, rebateRate });
      const scenarioRows = scenarios.map(scenario => {
        const summary = summaryForContract({
          cells: distributionForMarket(scenario.joint, marketName), pick: row.pick, water, context, rebateRate,
        });
        return { id: scenario.id, weight: scenario.weight, value: summary.ev, summary, shocks: scenario.shocks };
      });
      const scenarioWeightedEV = scenarioRows.reduce((sum, scenario) => sum + scenario.weight * scenario.value, 0);
      const rawWeightedEV = weightedSummary.ev;
      const robust = robustEvaluation({ scenarioRows, snapshot: distributionSnapshot, gate, weightedEV: rawWeightedEV });
      const rawRobustEV = robust.robustEV;
      const integrity = integrityAudit({ summary: weightedSummary, scenarioRows, weightedEV: rawWeightedEV, scenarioWeightedEV, robust, gate });
      const evCalibration = qualifyEvV103({ row, rawWeightedEV, rawRobustEV, modelProbability: weightedSummary.modelProbability, rebateRate, gate });
      const weightedEV = evCalibration.weightedEV;
      const robustEV = evCalibration.robustEV;
      const rawGap = anchor.probability == null ? null : Math.abs(weightedSummary.modelProbability - anchor.probability);
      const crossMarketVerified = row.marketVerification?.verified === true;
      const movement = movementComparison({ previous, row, cells: combinedDistribution, context, rebateRate, weightedEV: rawWeightedEV });

      results.push({
        ...row,
        water,
        waterMissing: false,
        waterEstimated: Boolean(row.waterEstimated),
        modelProbability: weightedSummary.modelProbability,
        rawModelProbability: weightedSummary.modelProbability,
        marketAnchorProbability: anchor.probability,
        marketAnchorSource: anchor.source,
        marketCalibrationWeight: 0,
        maximumCalibratedProbabilityEdge: null,
        rawMarketProbabilityGap: rawGap,
        calibratedMarketProbabilityGap: rawGap,
        marketCalibrationApplied: false,
        targetPriceCalibratesDistribution: false,
        outcomeProbabilitiesSource: 'V10 point-in-time棒球資料聯合比分分布；Tai888只作成交payoff，不反校準勝率',
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
        rawWeightedEV,
        rawRobustEV,
        weightedEV,
        robustEV,
        conservativeEV: robustEV,
        cev: robustEV,
        rawEV: rawWeightedEV,
        ev: weightedEV,
        evCalibration,
        evCalibrationVersion: EV_CALIBRATION_V103_VERSION,
        calibrationQualified: evCalibration.qualified,
        evFlipProbability: null,
        evFlipProbabilityDiagnostic: robust.flipProbability,
        evFlipStatus: '27情境診斷權重；不當成頻率機率',
        worstVariant: robust.variants[0]?.description || '',
        robustVariants: robust.variants,
        robustEVVersion: ROBUST_EV_VERSION,
        numericStandardError: robust.numericSE,
        numericLower95: robust.numericLower95,
        modelErrorMarginEV: robust.modelErrorMarginEV,
        integrityWarning: !integrity.passed,
        integrityMessage: integrity.failures.join('；'),
        confidence: gate.quality,
        score: 0,
        scoreAudit: { ok: integrity.passed && evCalibration.qualified, evidenceOnly: true, errors: [...integrity.failures, ...(evCalibration.qualified ? [] : evCalibration.reasons || [])], engineVersion: ANALYSIS_V10_VERSION },
        scoreBreakdown: null,
        tag: integrity.passed && evCalibration.qualified ? 'V10影子雙EV待固定公式評分' : '⛔ QA未通過｜不評分｜不下注',
        betEligible: false,
        unitSuggestion: null,
        primaryRisks: [
          ...primaryRisks({ gate, robust, marketName, rawGap, context }),
          ...(evCalibration.auditWarnings || []).map(reason => `模型／外部稽核：${reason}`),
          ...(evCalibration.qualified ? [] : (evCalibration.reasons || []).map(reason => `模型評分阻擋：${reason}`)),
        ],
        movement,
        distributionId: distributionSnapshot.distributionId,
        sourceStatuses: context?.sourceStatuses || context?.dataGateV10?.rows || {},
        dataGateV10: gate,
        numericalQA: {
          passed: evCalibration.qualified === true && Number.isFinite(weightedEV) && Number.isFinite(robustEV),
          standardError: robust.numericSE,
          lower95: robustEV,
          signStable: evCalibration.qualified === true && (weightedEV <= 0 || robustEV > 0),
          simulationsPerScenario: distributionSnapshot.simulationsPerScenario,
        },
        evDoubleCheck: {
          passed: weightedSummary.evDoubleCheckError <= 1e-9 && Math.abs(rawWeightedEV - scenarioWeightedEV) <= 1e-6,
          directEV: rawWeightedEV,
          bucketEV: weightedSummary.evFromBuckets,
          scenarioWeightedEV,
          combinedDistributionEV: rawWeightedEV,
          maximumBucketError: weightedSummary.evDoubleCheckError,
          aggregationError: Math.abs(rawWeightedEV - scenarioWeightedEV),
          tolerance: 1e-6,
          methods: ['同一聯合比分分布逐比分逐腿損益', '結算結果桶獨立加總', '27情境權重加總'],
        },
        minimumWater: minimumWaterThresholds(weightedSummary, scenarioRows, rebateRate, crossMarketVerified),
      });
    }
  }

  const analysis = {
    leagueId: contract.leagueId,
    analysisMode: contract.analysisMode,
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    modelConfig: contract.modelConfig,
    modelContractHash: contract.modelContractHash,
    engineVersion: ANALYSIS_V10_VERSION,
    robustEVVersion: ROBUST_EV_VERSION,
    snapshotId: distributionSnapshot.distributionId,
    distributionId: distributionSnapshot.distributionId,
    distributionHash: distributionSnapshot.distributionHash,
    distributionSnapshot,
    createdAt: new Date().toISOString(),
    analysisStatus: gate.passedForShadowScore ? 'V10 point-in-time聯合情境版' : '資料Gate BLOCK',
    dataQuality: gate.quality,
    dataGateV10: gate,
    expectedRuns: {
      full: distributionSnapshot.profile?.full || null,
      first5: distributionSnapshot.profile?.first5 || null,
    },
    modelInputs: distributionSnapshot.profile?.components || {},
    sourceStatuses: distributionSnapshot.profile?.statuses || {},
    scenarioSummary: {
      count: scenarios.length,
      simulationsPerScenario: distributionSnapshot.simulationsPerScenario,
      totalSimulations: scenarios.length * Number(distributionSnapshot.simulationsPerScenario || 0),
      conservativeQuantile: 0.10,
      sharedDistribution: true,
      jointPortfolioDistribution: true,
      jointCellCount: combinedJoint.length,
      persistedForReprice: true,
      targetPriceCalibratesDistribution: false,
      marketProbabilityCalibrationApplied: false,
      numericalUncertaintyIncluded: true,
      dataModelErrorMarginIncluded: true,
    },
    alignmentAudit: {
      instructionVersion: 'V10正確資料→同一聯合比分分布→台灣盤逐腿結算→Raw Weighted/Robust EV→QA→影子雙EV分數',
      targetMarketCalibration: 'DISABLED',
      gptNumericScoring: 'DISABLED',
      formalRecommendation: 'DISABLED_UNTIL_LOCKED_OOS_FORWARD_VALIDATION',
      modules: [
        { name: 'point-in-time資料與provenance', status: gate.passedForShadowScore ? 'SHADOW_PASS' : 'BLOCK' },
        { name: '同一上半／全場聯合比分分布', status: 'ENABLED' },
        { name: 'Tai888逐腿payoff', status: 'ENABLED' },
        { name: '同Tai888盤反校準', status: 'DISABLED' },
        { name: '數值誤差下界', status: 'ENABLED' },
      ],
    },
    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],
    warnings: Array.isArray(context?.warnings) ? context.warnings : [],
    portfolio: [],
    results,
  };
  return enforceShadowAnalysisSafety(analysis, context);
}

export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {
  const distributionSnapshot = buildDistributionSnapshot({ context, settings });
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}

export function repriceMarkets({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  if (!distributionSnapshot) throw new Error('缺少V10凍結聯合比分分布，不能快速重算');
  if (context?.coreFingerprint && distributionSnapshot.coreFingerprint
    && context.coreFingerprint !== distributionSnapshot.coreFingerprint) {
    throw new Error('核心資料指紋已改變，必須完整重算');
  }
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}
