import { evFromProbability, hasActualWater } from './markets.js';

export const EV_CALIBRATION_V103_VERSION = 'MODEL-EV-WITH-INDEPENDENT-MARKET-AUDIT-2026-08-v10.5.0';
export const UNVERIFIED_EXTREME_EV_LIMIT = 0.15;
// A quoted-market gap above 5% is too large to trust from one three-book
// snapshot alone. A genuinely separate external validation may lift that
// review gate, but 15% remains the absolute fail-closed ceiling.
export const UNVERIFIED_MARKET_EDGE_LIMIT = 0.05;
export const ABSOLUTE_MARKET_EDGE_LIMIT = 0.15;
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
const PAYOFF_COVERAGE_TOLERANCE = 1e-6;
const EV_GATE_EPSILON = 1e-12;
export const PAYOFF_ROBUST_EV_HAIRCUT = 0.015;

function median(values) {
  const rows = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function lowerQuantile(values, probability = 0.10) {
  const rows = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return null;
  const index = Math.max(0, Math.min(rows.length - 1, Math.floor((rows.length - 1) * probability)));
  return rows[index];
}

function firstFinite(value, keys) {
  for (const key of keys) {
    const number = finite(value?.[key]);
    if (number != null) return number;
  }
  return null;
}

export function normalizeReferencePayoffVector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const equivalentWin = firstFinite(value, ['equivalentWin', 'winShare', 'winFraction', 'A']);
  const equivalentLoss = firstFinite(value, ['equivalentLoss', 'lossShare', 'lossFraction', 'B']);
  let equivalentPush = firstFinite(value, ['equivalentPush', 'pushShare', 'pushFraction', 'U']);
  if (equivalentWin == null || equivalentLoss == null) return null;
  if (equivalentPush == null) equivalentPush = 1 - equivalentWin - equivalentLoss;
  const coverage = equivalentWin + equivalentLoss + equivalentPush;
  const resolved = equivalentWin + equivalentLoss;
  if ([equivalentWin, equivalentLoss, equivalentPush].some(number => number < -PAYOFF_COVERAGE_TOLERANCE || number > 1 + PAYOFF_COVERAGE_TOLERANCE)) return null;
  if (Math.abs(coverage - 1) > PAYOFF_COVERAGE_TOLERANCE || resolved <= PAYOFF_COVERAGE_TOLERANCE) return null;
  const normalizedWin = clamp(equivalentWin, 0, 1);
  const normalizedLoss = clamp(equivalentLoss, 0, 1);
  const normalizedPush = clamp(1 - normalizedWin - normalizedLoss, 0, 1);
  const normalizedResolved = normalizedWin + normalizedLoss;
  return {
    ...value,
    equivalentWin: normalizedWin,
    equivalentLoss: normalizedLoss,
    equivalentPush: normalizedPush,
    effectiveWinProbability: normalizedWin / normalizedResolved,
    settlementRate: normalizedResolved,
    coverage: normalizedWin + normalizedLoss + normalizedPush,
  };
}

export function evFromPayoffVector(vector, water, rebateRate = 0.015) {
  const normalized = normalizeReferencePayoffVector(vector);
  if (!normalized || !hasActualWater(water)) return null;
  const price = Number(water);
  const rebate = clamp(finite(rebateRate, 0.015), 0, 0.1);
  return normalized.equivalentWin * (price + rebate)
    - normalized.equivalentLoss * (1 - rebate);
}

export function minimumWaterFromPayoffVector(vector, targetEV = 0, rebateRate = 0.015) {
  const normalized = normalizeReferencePayoffVector(vector);
  const target = finite(targetEV);
  if (!normalized || target == null || normalized.equivalentWin <= 0) return null;
  const rebate = clamp(finite(rebateRate, 0.015), 0, 0.1);
  return (target + normalized.equivalentLoss * (1 - rebate)) / normalized.equivalentWin - rebate;
}

function normalizedBookPayoffVectors(value) {
  const seen = new Set();
  const rows = [];
  for (const [index, source] of (Array.isArray(value) ? value : []).entries()) {
    const vector = normalizeReferencePayoffVector(source?.payoffVector || source);
    const bookmakerKey = String(source?.bookmakerKey || source?.bookKey || source?.consensusBookKey || source?.provider || '').trim();
    if (!vector || !bookmakerKey || seen.has(bookmakerKey)) continue;
    seen.add(bookmakerKey);
    rows.push({ ...vector, bookmakerKey, sourceIndex: index });
  }
  return rows;
}

export function aggregatePayoffVectorEV(referenceBookPayoffVectors, water, rebateRate = 0.015) {
  const vectors = normalizedBookPayoffVectors(referenceBookPayoffVectors);
  if (!hasActualWater(water) || vectors.length < MINIMUM_CONSENSUS_BOOKS) return null;
  const bookEVs = vectors.map(vector => ({
    bookmakerKey: vector.bookmakerKey,
    vector,
    ev: evFromPayoffVector(vector, water, rebateRate),
  })).filter(row => Number.isFinite(row.ev));
  if (bookEVs.length < MINIMUM_CONSENSUS_BOOKS) return null;
  const values = bookEVs.map(row => row.ev);
  const weightedEV = median(values);
  const q10EV = lowerQuantile(values, 0.10);
  const medianHaircutEV = weightedEV - PAYOFF_ROBUST_EV_HAIRCUT;
  return {
    weightedEV,
    robustEV: Math.min(q10EV, medianHaircutEV),
    q10EV,
    medianHaircutEV,
    bookEVs,
    vectors,
    bookCount: bookEVs.length,
  };
}

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
  const marketVerification = row?.marketVerification || {};
  const referencePayoffVector = normalizeReferencePayoffVector(marketVerification.referencePayoffVector);
  const payoffConsensus = aggregatePayoffVectorEV(marketVerification.referenceBookPayoffVectors, row?.water, rebateRate);
  const payoffEvidenceAvailable = referencePayoffVector != null
    && payoffConsensus != null
    && payoffConsensus.bookCount >= MINIMUM_CONSENSUS_BOOKS;
  const priorProbability = payoffEvidenceAvailable
    ? referencePayoffVector.effectiveWinProbability
    : finite(marketVerification.referenceNoVigProbability);
  const priorRobustProbability = finite(row?.marketVerification?.referenceRobustProbability);
  const reportedConsensusBookCount = finite(row?.marketVerification?.referenceConsensusBookCount, 0);
  const consensusBookCount = payoffEvidenceAvailable
    ? Math.min(reportedConsensusBookCount || payoffConsensus.bookCount, payoffConsensus.bookCount)
    : reportedConsensusBookCount;
  const consensusTimeSpanMs = finite(row?.marketVerification?.referenceConsensusTimeSpanMs);
  const consensusFreshnessMaxMs = finite(row?.marketVerification?.referenceConsensusFreshnessMaxMs);
  const consensusProbabilitySpread = finite(row?.marketVerification?.referenceProbabilitySpread);
  const consensusProbabilityMad = finite(row?.marketVerification?.referenceProbabilityMad);
  const binaryProbabilityEvidence = priorProbability != null
    && priorRobustProbability != null
    && priorRobustProbability <= priorProbability;
  const referenceEvidenceEligible = row?.marketVerification?.referencePriorEligible === true
    && (payoffEvidenceAvailable || binaryProbabilityEvidence)
    && consensusBookCount >= MINIMUM_CONSENSUS_BOOKS
    && consensusTimeSpanMs != null
    && consensusTimeSpanMs <= 3 * 60 * 1000
    && consensusFreshnessMaxMs != null
    && consensusFreshnessMaxMs <= 5 * 60 * 1000
    && consensusProbabilitySpread != null
    && consensusProbabilitySpread <= 0.03
    && consensusProbabilityMad != null
    && consensusProbabilityMad <= 0.01;
  const actualReaderSource = row?.sourceType === 'ACTUAL_TW_CREDIT'
    && String(row?.provider || '').trim().toUpperCase() === 'TAI888_READER_AUTO';
  const actualReaderFresh = row?.lineFresh === true && row?.executable === true;
  const actualReaderEligible = actualReaderSource
    && actualReaderFresh
    && hasActualWater(row?.water);
  const priorEligible = referenceEvidenceEligible && actualReaderEligible;
  const referenceEV = priorEligible
    ? payoffEvidenceAvailable
      ? payoffConsensus.weightedEV
      : evFromProbability(priorProbability, row.water, rebateRate)
    : null;
  const referenceRobustEV = priorEligible
    ? payoffEvidenceAvailable
      ? payoffConsensus.robustEV
      : evFromProbability(priorRobustProbability, row.water, rebateRate)
    : null;
  const probabilityGap = priorEligible && probability != null
    ? Math.abs(probability - priorProbability)
    : null;
  const extreme = rawW != null && Math.abs(rawW) >= UNVERIFIED_EXTREME_EV_LIMIT;
  const secondaryIndependentMarketVerified = marketVerification.secondaryIndependentMarketVerified === true;
  const unverifiedMarketEdgeExtreme = referenceEV != null
    && Math.abs(referenceEV) + EV_GATE_EPSILON >= UNVERIFIED_MARKET_EDGE_LIMIT
    && !secondaryIndependentMarketVerified;
  const absoluteMarketEdgeExtreme = referenceEV != null
    && Math.abs(referenceEV) + EV_GATE_EPSILON >= ABSOLUTE_MARKET_EDGE_LIMIT;
  const marketEdgeExtreme = unverifiedMarketEdgeExtreme || absoluteMarketEdgeExtreme;
  const rawScenarioSpread = rawW != null && rawR != null ? Math.abs(rawW - rawR) : null;
  const weightedRobustGap = referenceEV != null && referenceRobustEV != null
    ? referenceEV - referenceRobustEV
    : null;
  const reasons = [];
  const auditWarnings = [];

  if (rawW == null || rawR == null || probability == null) reasons.push('模型EV或機率不是有限數值');
  if (rawW != null && rawR != null && rawR > rawW + EV_GATE_EPSILON) reasons.push('模型Robust EV高於Weighted EV');
  if (gate?.passedForShadowScore !== true) reasons.push('核心棒球資料Gate未通過');
  if (quality < MINIMUM_DATA_QUALITY) reasons.push(`核心棒球資料品質${quality.toFixed(2)}低於${MINIMUM_DATA_QUALITY.toFixed(2)}安全門檻`);
  if (!actualReaderSource) {
    reasons.push('只允許 Tai888 Reader 自動同步的實際信用盤建立市場價差 W/R；手動盤只可永久記錄，不得評分或列排名');
  } else if (!hasActualWater(row?.water)) {
    reasons.push('Tai888 Reader 實際信用盤缺少有效水位');
  } else if (!actualReaderFresh) {
    reasons.push('Tai888 Reader 實際盤已過期或尚未完成最新版本驗證');
  } else if (!referenceEvidenceEligible) {
    reasons.push(row?.marketVerification?.priorIneligibleReason || '缺少至少3家獨立國際市場的同合約去水機率或payoff向量；原始模型不得單獨產生有效EV');
  }

  // The joint score distribution is the only source of official model W/R.
  // Independent markets are an external audit gate and never replace model EV.
  if (extreme) {
    reasons.push(`模型EV達${(Math.abs(rawW) * 100).toFixed(1)}%，超過15%極端值安全線；完成locked OOS與forward校準前不評分`);
  }

  if (rawScenarioSpread != null && rawScenarioSpread > MAX_RAW_SCENARIO_EV_SPREAD) {
    reasons.push(`模型中央與壓力情境EV差距${(rawScenarioSpread * 100).toFixed(1)}個百分點，超過${(MAX_RAW_SCENARIO_EV_SPREAD * 100).toFixed(0)}個百分點穩定線`);
  }

  if (priorEligible) {
    if (probabilityGap > probabilityTolerance) {
      reasons.push(`模型與獨立市場機率差距${(probabilityGap * 100).toFixed(1)}個百分點，超過容許${(probabilityTolerance * 100).toFixed(1)}個百分點`);
    }
    if (sign(rawW) !== 0 && sign(referenceEV) !== 0 && sign(rawW) !== sign(referenceEV)) {
      reasons.push('模型EV與獨立市場價格EV方向相反');
    }
    if (absoluteMarketEdgeExtreme) {
      reasons.push(`Tai888與獨立市場的價格EV達${(Math.abs(referenceEV) * 100).toFixed(1)}%，已達${(ABSOLUTE_MARKET_EDGE_LIMIT * 100).toFixed(0)}%絕對安全線`);
    } else if (unverifiedMarketEdgeExtreme) {
      reasons.push(`Tai888與獨立市場的價格EV達${(Math.abs(referenceEV) * 100).toFixed(1)}%，已達${(UNVERIFIED_MARKET_EDGE_LIMIT * 100).toFixed(0)}%單一三莊快照安全線；須第二個獨立外部市場驗證`);
    }
    if (weightedRobustGap > MAX_WEIGHTED_ROBUST_EV_GAP) {
      reasons.push(`獨立市場加權與保守EV差距${(weightedRobustGap * 100).toFixed(1)}個百分點，超過${(MAX_WEIGHTED_ROBUST_EV_GAP * 100).toFixed(0)}個百分點`);
    }
  }

  const qualified = reasons.length === 0;
  const weightedEV = qualified ? rawW : null;
  const robustEV = qualified ? Math.min(rawW, rawR) : null;
  const status = qualified
    ? 'QUALIFIED_MODEL_EV_WITH_INDEPENDENT_MARKET_AUDIT'
    : marketEdgeExtreme ? 'EXTREME_MARKET_EDGE_HELD_FOR_REVIEW' : 'MODEL_OR_DATA_QA_BLOCK';

  return {
    version: EV_CALIBRATION_V103_VERSION,
    qualified,
    status,
    reasons,
    auditWarnings,
    weightedEV,
    robustEV,
    rawWeightedEV: rawW,
    rawRobustEV: rawR,
    rawModelProbability: probability,
    referencePriorEligible: referenceEvidenceEligible,
    actualReaderSource,
    actualReaderFresh,
    actualReaderEligible,
    secondaryIndependentMarketVerified,
    referenceProbability: priorProbability,
    referenceRobustProbability: payoffEvidenceAvailable ? null : priorRobustProbability,
    referencePriorType: payoffEvidenceAvailable ? 'PAYOFF_VECTOR' : 'BINARY_NO_PUSH_PROBABILITY',
    referencePayoffVector: payoffEvidenceAvailable ? referencePayoffVector : null,
    referenceBookPayoffVectors: payoffEvidenceAvailable ? payoffConsensus.vectors : [],
    referenceBookEVs: payoffEvidenceAvailable ? payoffConsensus.bookEVs : [],
    referenceEV,
    referenceRobustEV,
    marketPriceWeightedEV: referenceEV,
    marketPriceRobustEV: referenceRobustEV,
    probabilityGap,
    probabilityTolerance,
    unverifiedExtremeEvLimit: UNVERIFIED_EXTREME_EV_LIMIT,
    unverifiedMarketEdgeLimit: UNVERIFIED_MARKET_EDGE_LIMIT,
    absoluteMarketEdgeLimit: ABSOLUTE_MARKET_EDGE_LIMIT,
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
    calibratedProbability: qualified ? probability : null,
    calibratedRobustProbability: null,
    robustVariants: priorEligible && referenceEV != null
      ? payoffEvidenceAvailable
        ? [
          ...payoffConsensus.bookEVs.map(row => ({ id: `independent-book-${row.bookmakerKey}`, value: row.ev })),
          { id: 'independent-book-q10-ev', value: payoffConsensus.q10EV },
          { id: 'independent-consensus-minus-haircut', value: payoffConsensus.medianHaircutEV },
        ]
        : [
          { id: 'independent-consensus-ev', value: referenceEV },
          { id: 'independent-cross-book-lower-ev', value: referenceRobustEV },
        ]
      : [],
  };
}
