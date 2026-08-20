import { evFromProbability, hasActualWater } from './markets.js';

export const EV_CALIBRATION_V103_VERSION = 'INDEPENDENT-CONSENSUS-PRICE-EV-GATE-2026-08-v10.4.1';
export const UNVERIFIED_EXTREME_EV_LIMIT = 0.15;
export const UNVERIFIED_MARKET_EDGE_LIMIT = 0.05;
export const MAX_MODEL_REFERENCE_PROBABILITY_GAP = 0.02;
export const MAX_WEIGHTED_ROBUST_EV_GAP = 0.04;
export const MAX_RAW_SCENARIO_EV_SPREAD = 0.04;
export const MINIMUM_DATA_QUALITY = 0.85;
export const MINIMUM_CONSENSUS_BOOKS = 3;

const finite = (value, fallback = null) => {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function sign(value, epsilon = 1e-9) {
  const number = Number(value);
  return number > epsilon ? 1 : number < -epsilon ? -1 : 0;
}

function qualificationDataQuality(gate = {}) {
  const explicit = finite(gate?.qualificationQuality);
  if (explicit != null) return clamp(explicit, 0.5, 0.97);
  const coreRows = (Array.isArray(gate?.rows) ? gate.rows : []).filter(row => row?.core === true);
  if (!coreRows.length) return clamp(finite(gate?.quality, 0.5), 0.5, 0.97);
  const missing = coreRows.filter(row => String(row?.status || '').toUpperCase() === 'MISSING').length;
  const projected = coreRows.filter(row => String(row?.status || '').toUpperCase() === 'PROJECTED').length;
  return clamp(0.97 - missing * 0.12 - projected * 0.04, 0.5, 0.97);
}

export function qualifyEvV103({ row, rawWeightedEV, rawRobustEV, modelProbability, rebateRate = 0.015, gate = {} }) {
  const rawW = finite(rawWeightedEV);
  const rawR = finite(rawRobustEV);
  const probability = finite(modelProbability);
  const overallQuality = clamp(finite(gate?.quality, 0.5), 0.5, 0.97);
  const quality = qualificationDataQuality(gate);
  const probabilityTolerance = MAX_MODEL_REFERENCE_PROBABILITY_GAP;
  const priorProbability = finite(row?.marketVerification?.referenceNoVigProbability);
  const priorRobustProbability = finite(row?.marketVerification?.referenceRobustProbability);
  const consensusBookCount = finite(row?.marketVerification?.referenceConsensusBookCount, 0);
  const consensusTimeSpanMs = finite(row?.marketVerification?.referenceConsensusTimeSpanMs);
  const consensusFreshnessMaxMs = finite(row?.marketVerification?.referenceConsensusFreshnessMaxMs);
  const consensusProbabilitySpread = finite(row?.marketVerification?.referenceProbabilitySpread);
  const consensusProbabilityMad = finite(row?.marketVerification?.referenceProbabilityMad);
  const priorEligible = row?.marketVerification?.referencePriorEligible === true
    && priorProbability != null
    && priorRobustProbability != null
    && priorRobustProbability <= priorProbability
    && consensusBookCount >= MINIMUM_CONSENSUS_BOOKS
    && consensusTimeSpanMs != null
    && consensusTimeSpanMs <= 3 * 60 * 1000
    && consensusFreshnessMaxMs != null
    && consensusFreshnessMaxMs <= 5 * 60 * 1000
    && consensusProbabilitySpread != null
    && consensusProbabilitySpread <= 0.03
    && consensusProbabilityMad != null
    && consensusProbabilityMad <= 0.01
    && hasActualWater(row?.water);
  const referenceEV = priorEligible
    ? evFromProbability(priorProbability, row.water, rebateRate)
    : null;
  const referenceRobustEV = priorEligible
    ? evFromProbability(priorRobustProbability, row.water, rebateRate)
    : null;
  const probabilityGap = priorEligible && probability != null
    ? Math.abs(probability - priorProbability)
    : null;
  const extreme = rawW != null && Math.abs(rawW) >= UNVERIFIED_EXTREME_EV_LIMIT;
  const marketEdgeExtreme = referenceEV != null && Math.abs(referenceEV) >= UNVERIFIED_MARKET_EDGE_LIMIT;
  const rawScenarioSpread = rawW != null && rawR != null ? Math.abs(rawW - rawR) : null;
  const weightedRobustGap = referenceEV != null && referenceRobustEV != null
    ? referenceEV - referenceRobustEV
    : null;
  const reasons = [];

  if (rawW == null || rawR == null || probability == null) reasons.push('原始模型EV或機率不是有限數值');
  if (gate?.passedForShadowScore !== true) reasons.push('資料Gate未通過');
  if (quality < MINIMUM_DATA_QUALITY) reasons.push(`核心資料品質${quality.toFixed(2)}低於${MINIMUM_DATA_QUALITY.toFixed(2)}安全門檻`);
  if (!priorEligible) {
    reasons.push(row?.marketVerification?.priorIneligibleReason || '缺少至少3家獨立國際市場的同合約去水機率；原始模型不得單獨產生有效EV');
  }

  // Until the locked out-of-sample / forward validation has proved that the
  // model is calibrated in this tail, an extreme raw EV is diagnostic only.
  // Independent market agreement is useful evidence, but it cannot promote
  // an unvalidated 15%+ model output into a valid W/R EV or S score.
  if (extreme) {
    reasons.push(`原始模型EV達${(Math.abs(rawW) * 100).toFixed(1)}%，超過15%極端值安全線；完成locked OOS與forward校準前只供稽核`);
  }

  if (rawScenarioSpread != null && rawScenarioSpread > MAX_RAW_SCENARIO_EV_SPREAD) {
    reasons.push(`原始模型中央與壓力情境EV差距${(rawScenarioSpread * 100).toFixed(1)}個百分點，超過${(MAX_RAW_SCENARIO_EV_SPREAD * 100).toFixed(0)}個百分點穩定線`);
  }

  if (priorEligible) {
    if (probabilityGap > probabilityTolerance) {
      reasons.push(`資料模型與獨立市場先驗差距${(probabilityGap * 100).toFixed(1)}個百分點，超過容許${(probabilityTolerance * 100).toFixed(1)}個百分點`);
    }
    if (sign(rawW) !== 0 && sign(referenceEV) !== 0 && sign(rawW) !== sign(referenceEV)) {
      reasons.push('資料模型EV與獨立市場價格EV方向相反');
    }
    if (marketEdgeExtreme) {
      reasons.push(`Tai888與獨立市場的價格EV達${(Math.abs(referenceEV) * 100).toFixed(1)}%，超過${(UNVERIFIED_MARKET_EDGE_LIMIT * 100).toFixed(0)}%未驗證價差安全線`);
    }
    if (weightedRobustGap > MAX_WEIGHTED_ROBUST_EV_GAP) {
      reasons.push(`獨立市場加權與保守EV差距${(weightedRobustGap * 100).toFixed(1)}個百分點，超過${(MAX_WEIGHTED_ROBUST_EV_GAP * 100).toFixed(0)}個百分點`);
    }
  }

  const qualified = reasons.length === 0;
  // V10.4 no longer exposes the uncalibrated baseball model EV as a usable
  // number. W is the independent no-vig consensus price edge against Tai888;
  // R is the same calculation at the cross-book lower probability. The raw
  // model remains server-side diagnostic evidence and can only block results.
  const weightedEV = qualified ? referenceEV : null;
  const robustEV = qualified ? Math.min(referenceEV, referenceRobustEV) : null;
  const status = qualified
    ? 'QUALIFIED_WITH_INDEPENDENT_EXACT_CONTRACT_CONSENSUS'
    : extreme ? 'EXTREME_EV_HELD_FOR_LOCKED_OOS' : 'CALIBRATION_BLOCK';

  return {
    version: EV_CALIBRATION_V103_VERSION,
    qualified,
    status,
    reasons,
    weightedEV,
    robustEV,
    rawWeightedEV: rawW,
    rawRobustEV: rawR,
    rawModelProbability: probability,
    referencePriorEligible: priorEligible,
    referenceProbability: priorProbability,
    referenceRobustProbability: priorRobustProbability,
    referenceEV,
    referenceRobustEV,
    probabilityGap,
    probabilityTolerance,
    unverifiedExtremeEvLimit: UNVERIFIED_EXTREME_EV_LIMIT,
    unverifiedMarketEdgeLimit: UNVERIFIED_MARKET_EDGE_LIMIT,
    maxWeightedRobustGap: MAX_WEIGHTED_ROBUST_EV_GAP,
    maxRawScenarioSpread: MAX_RAW_SCENARIO_EV_SPREAD,
    minimumDataQuality: MINIMUM_DATA_QUALITY,
    dataQuality: quality,
    qualificationDataQuality: quality,
    overallDataQuality: overallQuality,
    consensusBookCount,
    consensusTimeSpanMs,
    consensusFreshnessMaxMs,
    consensusProbabilitySpread,
    consensusProbabilityMad,
    extreme,
    marketEdgeExtreme,
    rawScenarioSpread,
    weightedRobustGap,
    calibratedProbability: qualified ? priorProbability : null,
    calibratedRobustProbability: qualified ? priorRobustProbability : null,
    robustVariants: priorEligible && referenceEV != null
      ? [
        { id: 'independent-consensus-ev', value: referenceEV },
        { id: 'independent-cross-book-lower-ev', value: referenceRobustEV },
      ]
      : [],
  };
}
