import Decimal from 'decimal.js';
import {
  MARKET_ORDER,
  breakEvenProbability,
  calculateProfit,
  hasActualWater,
  normalizeWater,
  outcomeSettlementForScore,
  parseTaiwanLine,
} from './markets.js';
import {
  buildJointScoreSnapshotV13,
  gameStateAuditForScenarioV13,
  scoreDistributionForScenario,
  JOINT_SCORE_V13_VERSION,
} from './joint-score-v13.js';
import {
  aggregatePayoffVectorEV,
  qualifyEvV103,
  EV_CALIBRATION_V103_VERSION,
} from './ev-calibration-v103.js';

export const MODEL_VERSION = 'BASEBALL-STATE-AWARE-LINKED-SCORE-DISTRIBUTION-2026-08-v11.0.0';
export const RULES_VERSION = 'BASEBALL-SHARED-DISTRIBUTION-EXECUTION-PRICE-ONLY-2026-08-v11.0.0';
export const ANALYSIS_V11_VERSION = 'BASEBALL-STATE-AWARE-SHARED-JOINT-DISTRIBUTION-EV-2026-08-v11.0.0';
export const ROBUST_EV_VERSION = 'MODEL-SCENARIO-Q10-CONTINUOUS-PLAUSIBILITY-v3.1.0';
export const SHADOW_ANALYSIS_MODE = 'EXPERIMENTAL_SHADOW';
export const FORMAL_ANALYSIS_MODE = 'FORMAL';
export const SHADOW_SCORE_TYPE = 'SHADOW_DIAGNOSTIC';
export const SHADOW_RESULT_TAG = 'SHADOW｜影子評分｜不可下注';
export const DEFAULT_MODEL_CONFIG = Object.freeze({ engine: JOINT_SCORE_V13_VERSION, exactDistribution: true, linkedSegmentPath: true, stateAwareBottomNinth: true, extraInnings: true, targetMarketCalibration: false });

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value || '').trim();

function assertReleasedDistributionEngine(context = {}) {
  const leagueId = String(context?.leagueId || context?.game?.leagueId || context?.game?.league || 'MLB').trim().toUpperCase();
  if (leagueId === 'MLB') return leagueId;
  const error = new Error(`${leagueId}獨立比分引擎尚未發布｜禁止回退analysis-v10或MLB參數｜不評分`);
  error.code = 'LEAGUE_DISTRIBUTION_ENGINE_NOT_RELEASED';
  error.status = 503;
  throw error;
}

export function assertAnalysisModeContract(context = {}) {
  const analysisMode = String(context?.analysisMode || SHADOW_ANALYSIS_MODE).toUpperCase();
  if (analysisMode !== SHADOW_ANALYSIS_MODE && analysisMode !== FORMAL_ANALYSIS_MODE) throw new Error(`未知 analysisMode：${analysisMode}`);
  if (analysisMode === SHADOW_ANALYSIS_MODE && (context?.betEligible === true || context?.executable === true)) throw new Error('Shadow分析不得宣告可下注');
  const leagueId = String(context?.leagueId || context?.game?.leagueId || 'MLB').toUpperCase();
  const modelVersion = String(context?.modelVersion || MODEL_VERSION);
  const rulesVersion = String(context?.rulesVersion || RULES_VERSION);
  return { leagueId, analysisMode, shadow: analysisMode === SHADOW_ANALYSIS_MODE, modelVersion, rulesVersion, modelConfig: context?.modelConfig || DEFAULT_MODEL_CONFIG };
}

function lockContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...value, analysisMode: SHADOW_ANALYSIS_MODE, executable: false, betEligible: false, formalScoringEnabled: false };
}

function lockResult(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    scoreType: SHADOW_SCORE_TYPE,
    diagnosticTag: row?.diagnosticTag || row?.tag || null,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    recommendedUnit: null,
    portfolioRole: '',
    portfolioUnit: null,
    unitStatus: 'SHADOW｜不可下注',
    shadowSafety: { enforced: true, reason: '模型尚未完成 locked OOS／forward 正式驗證' },
  };
}

export function enforceShadowAnalysisSafety(value, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const leagueId = String(context?.leagueId || value?.leagueId || value?.context?.leagueId || value?.frozenContext?.leagueId || 'MLB').toUpperCase();
  const nestedAnalysis = value.analysis && typeof value.analysis === 'object'
    ? enforceShadowAnalysisSafety(value.analysis, { ...context, leagueId })
    : value.analysis;
  const repriceSnapshot = value.repriceSnapshot && typeof value.repriceSnapshot === 'object'
    ? {
      ...value.repriceSnapshot,
      analysisMode: SHADOW_ANALYSIS_MODE,
      executable: false,
      betEligible: false,
      portfolio: [],
      context: lockContext(value.repriceSnapshot.context),
      frozenContext: lockContext(value.repriceSnapshot.frozenContext),
      results: Array.isArray(value.repriceSnapshot.results) ? value.repriceSnapshot.results.map(lockResult) : value.repriceSnapshot.results,
    }
    : value.repriceSnapshot;
  return {
    ...value,
    leagueId,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    formalScoringEnabled: false,
    formalRecommendationsEnabled: false,
    scoreType: SHADOW_SCORE_TYPE,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    portfolio: [],
    context: lockContext(value.context),
    frozenContext: lockContext(value.frozenContext),
    ...(nestedAnalysis === undefined ? {} : { analysis: nestedAnalysis }),
    ...(repriceSnapshot === undefined ? {} : { repriceSnapshot }),
    warnings: [...new Set([...(Array.isArray(value.warnings) ? value.warnings : []), 'SHADOW｜僅供模型診斷與評分驗證｜不可下注'])],
    shadowSafety: { enforced: true, analysisMode: SHADOW_ANALYSIS_MODE, leagueId, reason: '模型尚未完成 locked OOS／forward 正式驗證' },
    results: (Array.isArray(value.results) ? value.results : []).map(lockResult),
  };
}

export function enforceAnalysisModeSafety(value, context = {}) {
  return String(context?.analysisMode || value?.analysisMode || SHADOW_ANALYSIS_MODE).toUpperCase() === FORMAL_ANALYSIS_MODE
    ? value
    : enforceShadowAnalysisSafety(value, context);
}

function summaryForContract({ cells, pick, water, context, rebateRate }) {
  const parsed = parseTaiwanLine(pick);
  const values = {
    coverage: new Decimal(0), ev: new Decimal(0), secondMoment: new Decimal(0), equivalentWin: new Decimal(0), equivalentLoss: new Decimal(0), equivalentPush: new Decimal(0),
    fullWin: new Decimal(0), partialWin: new Decimal(0), push: new Decimal(0), partialLoss: new Decimal(0), fullLoss: new Decimal(0), mixedNeutral: new Decimal(0), exactLineProbability: new Decimal(0),
  };
  const buckets = new Map();
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
    values.coverage = values.coverage.plus(probability);
    values.ev = values.ev.plus(probability.mul(profit));
    values.secondMoment = values.secondMoment.plus(probability.mul(profit.pow(2)));
    values.equivalentWin = values.equivalentWin.plus(probability.mul(win));
    values.equivalentLoss = values.equivalentLoss.plus(probability.mul(loss));
    values.equivalentPush = values.equivalentPush.plus(probability.mul(push));
    if (win.eq(1) && loss.eq(0)) values.fullWin = values.fullWin.plus(probability);
    else if (loss.eq(1) && win.eq(0)) values.fullLoss = values.fullLoss.plus(probability);
    else if (win.eq(0) && loss.eq(0)) values.push = values.push.plus(probability);
    else if (win.gt(loss)) values.partialWin = values.partialWin.plus(probability);
    else if (loss.gt(win)) values.partialLoss = values.partialLoss.plus(probability);
    else values.mixedNeutral = values.mixedNeutral.plus(probability);
    if ((settlement.legs || []).some(leg => leg.exactLine)) values.exactLineProbability = values.exactLineProbability.plus(probability);
    const signature = (settlement.legs || []).map(leg => [Number(leg.allocation || 0).toFixed(12), Number(leg.winShare || 0).toFixed(12), Number(leg.lossShare || 0).toFixed(12), Number(leg.pushShare || 0).toFixed(12)].join(':')).join('|');
    const bucket = buckets.get(signature) || { probability: new Decimal(0), profit };
    bucket.probability = bucket.probability.plus(probability);
    buckets.set(signature, bucket);
  }
  const bucketEV = [...buckets.values()].reduce((sum, bucket) => sum.plus(bucket.probability.mul(bucket.profit)), new Decimal(0));
  const resolved = values.equivalentWin.plus(values.equivalentLoss);
  const probability = resolved.gt(0) ? values.equivalentWin.div(resolved) : new Decimal(0.5);
  const fairWater = values.equivalentWin.gt(0)
    ? values.equivalentLoss.mul(new Decimal(1).minus(rebateRate)).div(values.equivalentWin).minus(rebateRate)
    : new Decimal(1.5);
  const variance = Decimal.max(0, values.secondMoment.minus(values.ev.pow(2))).toNumber();
  return {
    coverage: values.coverage.toNumber(), ev: values.ev.toNumber(), evFromBuckets: bucketEV.toNumber(), evDoubleCheckError: values.ev.minus(bucketEV).abs().toNumber(), variance,
    modelProbability: probability.toNumber(), fairWater: clamp(fairWater.toNumber(), 0.5, 1.5),
    equivalentWin: values.equivalentWin.toNumber(), equivalentLoss: values.equivalentLoss.toNumber(), equivalentPush: values.equivalentPush.toNumber(),
    fullWin: values.fullWin.toNumber(), partialWin: values.partialWin.toNumber(), push: values.push.toNumber(), partialLoss: values.partialLoss.toNumber(), fullLoss: values.fullLoss.toNumber(), mixedNeutral: values.mixedNeutral.toNumber(), exactLineProbability: values.exactLineProbability.toNumber(),
  };
}

function weightedQuantile(rows, quantile) {
  const values = rows.filter(row => Number.isFinite(row.value) && Number(row.weight) > 0).sort((a, b) => a.value - b.value);
  const total = values.reduce((sum, row) => sum + row.weight, 0);
  let cumulative = 0;
  for (const row of values) { cumulative += row.weight / total; if (cumulative + 1e-12 >= quantile) return row.value; }
  return values.at(-1)?.value ?? null;
}

function aggregateScenarioSummaries(rows, rebateRate) {
  const keys = ['coverage','ev','equivalentWin','equivalentLoss','equivalentPush','fullWin','partialWin','push','partialLoss','fullLoss','mixedNeutral','exactLineProbability'];
  const output = Object.fromEntries(keys.map(key => [key, 0]));
  let secondMoment = 0;
  for (const row of rows) {
    for (const key of keys) output[key] += row.weight * finite(row.summary?.[key], 0);
    secondMoment += row.weight * (finite(row.summary?.variance, 0) + finite(row.summary?.ev, 0) ** 2);
  }
  const resolved = output.equivalentWin + output.equivalentLoss;
  output.modelProbability = resolved > 0 ? output.equivalentWin / resolved : 0.5;
  output.fairWater = output.equivalentWin > 0 ? clamp((output.equivalentLoss * (1 - rebateRate)) / output.equivalentWin - rebateRate, 0.5, 1.5) : 1.5;
  output.variance = Math.max(0, secondMoment - output.ev ** 2);
  output.evFromBuckets = output.ev;
  output.evDoubleCheckError = 0;
  return output;
}

function settlementIdentityAudit(summary, water, rebateRate) {
  const bucketCoverage = ['fullWin','partialWin','push','partialLoss','fullLoss','mixedNeutral']
    .reduce((sum, key) => sum + finite(summary?.[key], 0), 0);
  const equivalentCoverage = finite(summary?.equivalentWin, 0)
    + finite(summary?.equivalentLoss, 0)
    + finite(summary?.equivalentPush, 0);
  const resolved = finite(summary?.equivalentWin, 0) + finite(summary?.equivalentLoss, 0);
  const probabilityFromEquivalent = resolved > 0
    ? finite(summary?.equivalentWin, 0) / resolved
    : 0.5;
  const evFromEquivalent = finite(summary?.equivalentWin, 0) * (water + rebateRate)
    - finite(summary?.equivalentLoss, 0) * (1 - rebateRate);
  return {
    bucketCoverage,
    equivalentCoverage,
    probabilityFromEquivalent,
    evFromEquivalent,
    bucketCoverageError: Math.abs(bucketCoverage - finite(summary?.coverage, 0)),
    equivalentCoverageError: Math.abs(equivalentCoverage - finite(summary?.coverage, 0)),
    probabilityIdentityError: Math.abs(probabilityFromEquivalent - finite(summary?.modelProbability, 0.5)),
    evIdentityError: Math.abs(evFromEquivalent - finite(summary?.ev, 0)),
  };
}

function summarizeAcrossScenarios({ scenarios, first5, pick, water, context, rebateRate }) {
  const rows = scenarios.map(scenario => {
    const { cells, coverage } = scoreDistributionForScenario(scenario, first5);
    const summary = summaryForContract({ cells, pick, water, context, rebateRate });
    return { id: scenario.id, weight: scenario.weight, value: summary.ev, summary: { ...summary, scoreCoverage: coverage }, shocks: scenario.shocks };
  });
  return { rows, weighted: aggregateScenarioSummaries(rows, rebateRate) };
}

function marketAnchorInfo(rows, row, rebateRate) {
  const actual = rows.filter(item => hasActualWater(item.water) && !item.waterEstimated);
  if (actual.length === 2) {
    const implied = actual.map(item => breakEvenProbability(item.water, rebateRate));
    const total = implied[0] + implied[1];
    const index = actual.indexOf(row);
    if (total > 0 && index >= 0) return { probability: implied[index] / total, source: 'Tai888雙邊去水診斷' };
  }
  return hasActualWater(row?.water) ? { probability: breakEvenProbability(row.water, rebateRate), source: 'Tai888單邊損益兩平診斷' } : { probability: null, source: '無可用市場診斷' };
}

function sameDirection(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick), right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.isTotal !== right.isTotal) return false;
  if (left.isTotal) return left.isOver === right.isOver && left.isUnder === right.isUnder;
  return clean(left.team).replace(/\s/g, '') === clean(right.team).replace(/\s/g, '');
}

function previousRow(previousMarkets, row) {
  return (Array.isArray(previousMarkets) ? previousMarkets : []).filter(previous => previous?.market === row.market && sameDirection(previous.pick, row.pick)).at(-1) || null;
}

function robustEvaluation(rows, gate, weightedEV) {
  const q10 = weightedQuantile(rows, 0.10) ?? weightedEV;
  const modelErrorMarginEV = clamp(finite(gate?.modelErrorMarginEV, 0.008), 0.003, 0.05);
  const errorAdjustedLower = weightedEV - modelErrorMarginEV;
  const robustEV = Math.min(weightedEV, q10, errorAdjustedLower);
  const flipWeight = rows.filter(row => row.value <= 0).reduce((sum, row) => sum + row.weight, 0);
  return { robustEV, q10, modelErrorMarginEV, errorAdjustedLower, flipWeight, variants: [{ id: 'scenario-q10', value: q10 }, { id: 'data-margin', value: errorAdjustedLower }].sort((a,b) => a.value-b.value) };
}

function waterForTarget(summary, targetEV, rebateRate) {
  const win = finite(summary?.equivalentWin, 0), loss = finite(summary?.equivalentLoss, 0);
  return win > 0 ? (targetEV + loss * (1 - rebateRate)) / win - rebateRate : null;
}

function minimumWater(weighted, scenarioRows, rebateRate, crossMarketVerified) {
  const required = (w, r) => {
    const weightedWater = waterForTarget(weighted, w, rebateRate);
    const robustWater = Math.max(...scenarioRows.map(row => waterForTarget(row.summary, r, rebateRate)).filter(Number.isFinite), -Infinity);
    const normalizedRobustWater = Number.isFinite(robustWater) ? robustWater : null;
    const requiredWater = Number.isFinite(weightedWater) && Number.isFinite(normalizedRobustWater)
      ? Math.max(weightedWater, normalizedRobustWater)
      : null;
    return { weightedWater, robustWater: normalizedRobustWater, requiredWater };
  };
  return { currentLineOnly: true, score7_2: required(0,0), score7_5: required(.02,.008), score8_0: required(.04,.02), score8_5: { ...required(.07,.04), crossMarketVerified, marketQualificationRequired: true } };
}

function waterForProbability(probability, targetEV, rebateRate) {
  const p = finite(probability, 0);
  if (!(p > 0 && p < 1)) return null;
  return (targetEV + (1 - p) * (1 - rebateRate)) / p - rebateRate;
}

function aggregateMinimumWater(vectors, targetEV, field, rebateRate) {
  const valueAt = water => aggregatePayoffVectorEV(vectors, water, rebateRate)?.[field];
  const minimum = 0.01;
  const maximum = 3;
  const atMinimum = valueAt(minimum);
  const atMaximum = valueAt(maximum);
  if (!Number.isFinite(atMinimum) || !Number.isFinite(atMaximum) || atMaximum < targetEV) return null;
  if (atMinimum >= targetEV) return minimum;
  let low = minimum;
  let high = maximum;
  for (let index = 0; index < 80; index += 1) {
    const middle = (low + high) / 2;
    if (valueAt(middle) >= targetEV) high = middle;
    else low = middle;
  }
  return high;
}

export function independentMinimumWater(evCalibration, rebateRate, crossMarketVerified) {
  if (evCalibration?.qualified !== true) return null;
  const payoffVectors = Array.isArray(evCalibration?.referenceBookPayoffVectors)
    ? evCalibration.referenceBookPayoffVectors
    : [];
  if (evCalibration?.referencePriorType === 'PAYOFF_VECTOR' && payoffVectors.length >= 3) {
    const required = (weightedTarget, robustTarget) => {
      const weightedWater = aggregateMinimumWater(payoffVectors, weightedTarget, 'weightedEV', rebateRate);
      const robustWater = aggregateMinimumWater(payoffVectors, robustTarget, 'robustEV', rebateRate);
      const requiredWater = Number.isFinite(weightedWater) && Number.isFinite(robustWater)
        ? Math.max(weightedWater, robustWater)
        : null;
      return { weightedWater, robustWater, requiredWater };
    };
    return {
      currentLineOnly: true,
      source: 'INDEPENDENT_PAYOFF_VECTOR_CONSENSUS',
      score7_2: required(0, 0),
      score7_5: required(.02, .008),
      score8_0: required(.04, .02),
      score8_5: { ...required(.07, .04), crossMarketVerified, marketQualificationRequired: true },
    };
  }
  const weightedProbability = finite(evCalibration?.calibratedProbability, NaN);
  const robustProbability = finite(evCalibration?.calibratedRobustProbability, NaN);
  if (!Number.isFinite(weightedProbability) || !Number.isFinite(robustProbability)) return null;
  const required = (weightedTarget, robustTarget) => {
    const weightedWater = waterForProbability(weightedProbability, weightedTarget, rebateRate);
    const robustWater = waterForProbability(robustProbability, robustTarget, rebateRate);
    const requiredWater = Number.isFinite(weightedWater) && Number.isFinite(robustWater)
      ? Math.max(weightedWater, robustWater)
      : null;
    return { weightedWater, robustWater, requiredWater };
  };
  return {
    currentLineOnly: true,
    source: 'INDEPENDENT_EXACT_CONTRACT_CONSENSUS',
    score7_2: required(0, 0),
    score7_5: required(.02, .008),
    score8_0: required(.04, .02),
    score8_5: { ...required(.07, .04), crossMarketVerified, marketQualificationRequired: true },
  };
}

function contextGate(context) {
  return context?.dataGateV10 || { passedForShadowScore: false, passedForFormalScore: false, quality: 0.5, modelErrorMarginEV: 0.03, missing: ['dataGate'], projected: [], blocking: ['dataGate'] };
}

function expectedRunsAcrossScenarios(scenarios, first5) {
  let weightSum = 0;
  let away = 0;
  let home = 0;
  for (const scenario of scenarios || []) {
    const weight = finite(scenario?.weight, 0);
    const distribution = scoreDistributionForScenario(scenario, first5);
    const scenarioAway = distribution.cells.reduce((sum, cell) => sum + cell.probability * cell.awayRuns, 0);
    const scenarioHome = distribution.cells.reduce((sum, cell) => sum + cell.probability * cell.homeRuns, 0);
    weightSum += weight;
    away += weight * scenarioAway;
    home += weight * scenarioHome;
  }
  return weightSum > 0 ? { away: away / weightSum, home: home / weightSum } : null;
}

function weightedGameStateAudit(scenarios) {
  const keys = ['bottomNinthSkippedProbability', 'regulationWalkoffProbability', 'extraInningsProbability', 'extraInningsWalkoffConditionalProbability'];
  const output = Object.fromEntries(keys.map(key => [key, 0]));
  let weightSum = 0;
  for (const scenario of scenarios || []) {
    const weight = finite(scenario?.weight, 0);
    const audit = gameStateAuditForScenarioV13(scenario);
    weightSum += weight;
    for (const key of keys) output[key] += weight * finite(audit?.[key], 0);
  }
  for (const key of keys) output[key] = weightSum > 0 ? output[key] / weightSum : 0;
  return { ...output, version: 'GH27-WEIGHTED-MLB-GAME-STATE-AUDIT-v1.0.0', noUnverifiedWalkoffExtraMargin: true };
}

export function buildDistributionSnapshot({ context }) {
  assertReleasedDistributionEngine(context);
  const contract = assertAnalysisModeContract(context);
  return buildJointScoreSnapshotV13({ context, modelVersion: contract.modelVersion, rulesVersion: contract.rulesVersion });
}

export function evaluateMarketsFromDistribution({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  assertReleasedDistributionEngine(context);
  const contract = assertAnalysisModeContract(context);
  if (!distributionSnapshot || distributionSnapshot.modelVersion !== contract.modelVersion || distributionSnapshot.rulesVersion !== contract.rulesVersion || distributionSnapshot.legacyDistributionUsed !== false || distributionSnapshot.stateAwareBottomNinth !== true) throw new Error('V11狀態感知比分分布版本不相容，必須完整重算');
  const rebateRate = clamp(finite(settings.rebateRate, 0.015), 0, 0.1);
  const scenarios = distributionSnapshot.scenarios || [];
  const gate = contextGate(context);
  const results = [];
  for (const marketName of MARKET_ORDER) {
    const rows = (Array.isArray(markets) ? markets : []).filter(row => row?.market === marketName && clean(row?.pick)).slice(0, 2);
    if (!rows.length) continue;
    const first5 = marketName.includes('上半');
    for (const row of rows) {
      const anchor = marketAnchorInfo(rows, row, rebateRate);
      if (!hasActualWater(row.water)) {
        results.push({ ...row, water: null, weightedEV: null, robustEV: null, score: null, betEligible: false, distributionCoverage: 1, dataGateV10: gate, marketCalibrationApplied: false, tag: '水位未提供｜不評分' });
        continue;
      }
      const water = normalizeWater(row.water);
      const rawEvaluation = summarizeAcrossScenarios({ scenarios, first5, pick: row.pick, water, context, rebateRate });
      const rawModelWeightedEV = rawEvaluation.weighted.ev;
      const rawModelRobust = robustEvaluation(rawEvaluation.rows, gate, rawModelWeightedEV);
      const rawModelGap = anchor.probability == null ? null : Math.abs(rawEvaluation.weighted.modelProbability - anchor.probability);
      // Every direction in a market must be priced from the same frozen score
      // distribution. Tai888 is the execution payoff and a plausibility audit;
      // it must never tilt or otherwise rewrite the baseball probabilities.
      const evaluation = rawEvaluation;
      const scenarioRows = evaluation.rows;
      const weighted = evaluation.weighted;
      const rawWeightedEV = weighted.ev;
      const rawRobust = robustEvaluation(scenarioRows, gate, rawWeightedEV);
      const settlementAudit = settlementIdentityAudit(weighted, water, rebateRate);
      const evCalibration = qualifyEvV103({
        row,
        rawWeightedEV,
        rawRobustEV: rawRobust.robustEV,
        modelProbability: weighted.modelProbability,
        rebateRate,
        gate,
      });
      const weightedEV = evCalibration.weightedEV;
      const robustEV = evCalibration.robustEV;
      const rawGap = anchor.probability == null ? null : Math.abs(weighted.modelProbability - anchor.probability);
      const integrityFailures = [];
      if (Math.abs(weighted.coverage - 1) > 1e-9) integrityFailures.push('聯合比分分布總和不等於1');
      if (settlementAudit.bucketCoverageError > 1e-9) integrityFailures.push('結算機率桶合計與分布覆蓋率不一致');
      if (settlementAudit.equivalentCoverageError > 1e-9) integrityFailures.push('等效輸贏走水機率與分布覆蓋率不一致');
      if (settlementAudit.probabilityIdentityError > 1e-12) integrityFailures.push('模型等效條件勝率與等效輸贏機率不一致');
      if (settlementAudit.evIdentityError > 1e-9) integrityFailures.push('模型W與逐腿等效輸贏機率不一致');
      if (!Number.isFinite(rawWeightedEV) || !Number.isFinite(rawRobust.robustEV)) integrityFailures.push('原始EV不是有限數值');
      if (rawRobust.robustEV > rawWeightedEV + 1e-12) integrityFailures.push('原始Robust EV高於原始Weighted EV');
      if (!gate.passedForShadowScore) integrityFailures.push(`資料Gate未通過：${(gate.blocking || []).join('、')}`);
      const previous = previousRow(previousMarkets, row);
      let movement = { available: false, reason: '無可比較舊盤' };
      if (previous && clean(previous.pick) === clean(row.pick) && hasActualWater(previous.water)) {
        const old = summarizeAcrossScenarios({ scenarios, first5, pick: previous.pick, water: normalizeWater(previous.water), context, rebateRate }).weighted;
        movement = { available: true, lineChanged: false, previousPick: previous.pick, previousWater: Number(previous.water), currentPick: row.pick, currentWater: water, previousWeightedEV: old.ev, deltaEV: rawWeightedEV - old.ev, method: '同一V11 PIT狀態感知凍結比分分布重算原始診斷；保留既有W/R資格與市場基準安全規則' };
      } else if (previous) movement = { available: true, lineChanged: true, previousPick: previous.pick, previousWater: previous.water, currentPick: row.pick, currentWater: water, verdict: '合約改變，由下注帳本逐比分payoff比較' };
      results.push({
        ...row, water, modelProbability: evCalibration.calibratedProbability ?? weighted.modelProbability, rawModelProbability: weighted.modelProbability, marketAnchorProbability: anchor.probability, marketAnchorSource: anchor.source,
        marketCalibrationWeight: 0, marketCalibrationApplied: false, targetPriceCalibratesDistribution: false,
        marketBaselineApplied: false,
        marketBaselineVersion: null,
        marketBaselineTilt: null,
        marketBaselineTargetProbability: null,
        rawModelWeightedEV,
        rawModelRobustEV: rawModelRobust.robustEV,
        rawModelTai888ProbabilityGap: rawModelGap,
        rawModelProbabilityBeforeBaseline: rawEvaluation.weighted.modelProbability,
        // QA reads the evaluated distribution gap.  When the provisional
        // baseline is active, the original disagreement remains separately
        // available as rawModelTai888ProbabilityGap for a transparent audit.
        rawMarketProbabilityGap: rawGap,
        modelReferenceProbabilityGap: evCalibration.probabilityGap,
        tai888MarketProbabilityGap: rawGap,
        calibratedMarketProbabilityGap: evCalibration.probabilityGap,
        outcomeProbabilitiesSource: evCalibration.qualified
          ? 'V11.0 PIT打線／左右投／預計局數／純牛棚與九局終止狀態聯合比分分布；同市場正反方向共用同一凍結分布；Tai888只作成交payoff與合理性QA；獨立市場僅為可選外部稽核'
          : 'Reader、核心資料或數學未通過時不得產生W/R或S分數', fairWater: weighted.fairWater,
        fullWinProbability: weighted.fullWin, partialWinProbability: weighted.partialWin, pushProbability: weighted.push, partialLossProbability: weighted.partialLoss, fullLossProbability: weighted.fullLoss, mixedNeutralProbability: weighted.mixedNeutral, exactLineProbability: weighted.exactLineProbability,
        equivalentWinProbability: weighted.equivalentWin, equivalentLossProbability: weighted.equivalentLoss, equivalentPushProbability: weighted.equivalentPush, settlementIdentityAudit: settlementAudit,
        distributionCoverage: weighted.coverage, rawWeightedEV, rawRobustEV: rawRobust.robustEV, weightedEV, robustEV, conservativeEV: robustEV, cev: robustEV, rawEV: rawWeightedEV, ev: weightedEV, evCalibration, calibrationQualified: evCalibration.qualified,
        evFlipProbabilityDiagnostic: rawRobust.flipWeight, evFlipStatus: 'Gauss-Hermite 27情境參數不確定性權重；尚未以locked OOS校準覆蓋率，不當成歷史頻率', worstVariant: [...rawRobust.variants, ...(evCalibration.robustVariants || [])].sort((a, b) => a.value - b.value)[0]?.id || '', robustVariants: [...rawRobust.variants, ...(evCalibration.robustVariants || [])].sort((a, b) => a.value - b.value),
        robustEVVersion: ROBUST_EV_VERSION, numericStandardError: null, numericLower95: robustEV, modelErrorMarginEV: null,
        integrityWarning: integrityFailures.length > 0, integrityMessage: integrityFailures.join('；'), confidence: gate.quality, score: 0, betEligible: false, unitSuggestion: null,
        primaryRisks: [...(gate.projected || []).map(name => `預估資料：${name}`), ...(gate.missing || []).map(name => `缺失資料：${name}`), ...(rawModelGap != null && rawModelGap > 0.05 ? [`原始模型與Tai888去水市場差距 ${(rawModelGap*100).toFixed(1)}%；只作合理性QA，不改寫比分分布或EV`] : []), ...(evCalibration.auditWarnings || []).map(reason => `模型／外部稽核：${reason}`), ...(evCalibration.qualified ? [] : evCalibration.reasons.map(reason => `模型評分阻擋：${reason}`))],
        movement, distributionId: distributionSnapshot.distributionId, sourceStatuses: context?.sourceStatuses || {}, dataGateV10: gate,
        numericalQA: { passed: evCalibration.qualified === true && Number.isFinite(weightedEV) && Number.isFinite(robustEV), exactDistribution: true, standardError: null, lower95: robustEV, signStable: evCalibration.qualified === true && (weightedEV <= 0 || robustEV > 0), simulationsPerScenario: 0 },
        evDoubleCheck: { passed: true, directEV: rawWeightedEV, scenarioWeightedEV: scenarioRows.reduce((sum, scenario) => sum + scenario.weight * scenario.value, 0), combinedDistributionEV: rawWeightedEV, tolerance: 1e-9, methods: ['每情境精確比分PMF逐比分逐腿損益', '27情境Gauss-Hermite權重精確加總'] },
        minimumWater: minimumWater(
          weighted,
          scenarioRows,
          rebateRate,
          row.marketVerification?.secondaryIndependentMarketVerified === true,
        ),
      });
    }
  }
  const expectedRuns = {
    full: expectedRunsAcrossScenarios(scenarios, false),
    first5: expectedRunsAcrossScenarios(scenarios, true),
    scheduledNineInningsBeforeTermination: distributionSnapshot.profile?.scheduledFull || null,
  };
  const gameStateAudit = weightedGameStateAudit(scenarios);
  const analysis = {
    leagueId: contract.leagueId, analysisMode: contract.analysisMode, modelVersion: contract.modelVersion, rulesVersion: contract.rulesVersion, modelConfig: { ...contract.modelConfig, targetMarketCalibration: false },
    engineVersion: ANALYSIS_V11_VERSION, robustEVVersion: ROBUST_EV_VERSION, snapshotId: distributionSnapshot.distributionId, distributionId: distributionSnapshot.distributionId, distributionHash: distributionSnapshot.distributionHash,
    distributionSnapshot, createdAt: new Date().toISOString(), analysisStatus: gate.passedForShadowScore ? 'V11.0 PIT狀態感知共用聯合比分分布模型EV｜Tai888僅作成交payoff與合理性QA' : '資料Gate BLOCK', dataQuality: gate.quality, dataQualificationQuality: gate.qualificationQuality ?? gate.quality, dataGateV10: gate,
    expectedRuns, modelInputs: distributionSnapshot.profile?.components || {}, sourceStatuses: context?.sourceStatuses || {},
    scenarioSummary: { count: scenarios.length, simulationsPerScenario: 0, conservativeQuantile: .10, sharedDistribution: true, linkedSegmentPath: distributionSnapshot.linkedSegmentPath === true, linkedPathAudit: distributionSnapshot.linkedPathAudit || null, jointPortfolioDistribution: false, portfolioStatus: 'NOT_INTEGRATED', exactDistribution: true, gameStateAudit, quadratureVersion: distributionSnapshot.quadratureVersion, runProfileVersion: distributionSnapshot.runProfileVersion, evCalibrationVersion: EV_CALIBRATION_V103_VERSION, persistedForReprice: true, targetPriceCalibratesDistribution: false, marketProbabilityCalibrationApplied: false, legacyDistributionUsed: false },
    alignmentAudit: { instructionVersion: 'V11.0 PIT打線／左右投／純牛棚→預計局數交接→F5至全場連結路徑→狀態感知九局／再見／延長賽→共用凍結比分分布→Tai888逐腿payoff與合理性QA→驗證中S分數', targetMarketCalibration: 'DISABLED_EXECUTION_PRICE_ONLY', independentMarketRole: 'OPTIONAL_EXTERNAL_AUDIT_ONLY', legacyContext: context?.legacyContextUsed === false ? 'DISABLED' : 'BLOCK', legacyDistribution: 'DISABLED', gptNumericScoring: 'DISABLED', formalRecommendation: 'DISABLED_UNTIL_LOCKED_OOS_FORWARD_VALIDATION' },
    featureProvenance: context?.featureProvenance || [], warnings: context?.warnings || [], portfolio: [], results,
  };
  return enforceShadowAnalysisSafety(analysis);
}

export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {
  assertReleasedDistributionEngine(context);
  const distributionSnapshot = buildDistributionSnapshot({ context, settings });
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}

export function repriceMarkets({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  assertReleasedDistributionEngine(context);
  if (!distributionSnapshot) throw new Error('缺少V11狀態感知凍結比分分布');
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}
