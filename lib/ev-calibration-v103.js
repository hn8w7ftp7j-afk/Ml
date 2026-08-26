import { evFromProbability, hasActualWater } from './markets.js';

export const EV_CALIBRATION_V103_VERSION = 'RAW-MODEL-EV-S-FIRST-DIAGNOSTIC-WARNINGS-2026-08-v11.2.0';
export const UNVERIFIED_EXTREME_EV_LIMIT = 0.15;
// A quoted-market gap above 5% is too large to trust from one three-book
// snapshot alone. A genuinely separate external validation may lift that
// review gate, but 15% remains the absolute fail-closed ceiling.
export const UNVERIFIED_MARKET_EDGE_LIMIT = 0.05;
export const ABSOLUTE_MARKET_EDGE_LIMIT = 0.15;
export const MAX_MODEL_REFERENCE_PROBABILITY_GAP = 0.02;
export const MAX_WEIGHTED_ROBUST_EV_GAP = 0.04;
export const MAX_RAW_SCENARIO_EV_SPREAD = 0.05;
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
  const extreme = rawW != null && rawW >= UNVERIFIED_EXTREME_EV_LIMIT;
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
    reasons.push('非 Tai888 Reader 自動同步的實際信用盤；原始模型W/R保留供稽核，但不得評分、排名或下注');
  } else if (!hasActualWater(row?.water)) {
    reasons.push('Tai888 Reader 實際信用盤缺少有效水位');
  } else if (!actualReaderFresh) {
    reasons.push('Tai888 Reader 實際盤已過期或尚未完成最新版本驗證；可追溯快照的原始模型W/R保留，但不得排名或下注');
  }

  // The joint score distribution is the only source of model W/R. External
  // books are optional audit evidence because Tai888 tail/split contracts do
  // not normally have an exact international-market equivalent.
  if (!referenceEvidenceEligible) {
    const externalReason = row?.marketVerification?.priorIneligibleReason || '未取得可比的獨立國際市場';
    auditWarnings.push(`${externalReason}；不影響模型W/R，只停用外部稽核與高分交叉驗證`);
  }
  if (extreme) {
    auditWarnings.push(`極高模型EV（W +${(rawW * 100).toFixed(1)}%），建議複核；W、R、S與排名資格照實保留`);
  }

  if (rawScenarioSpread != null && rawScenarioSpread > MAX_RAW_SCENARIO_EV_SPREAD) {
    auditWarnings.push(`模型W/R情境差距${(rawScenarioSpread * 100).toFixed(1)}個百分點，超過${(MAX_RAW_SCENARIO_EV_SPREAD * 100).toFixed(0)}個百分點穩定線；顯示分數但不進排名`);
  }

  if (priorEligible) {
    if (probabilityGap > probabilityTolerance) {
      auditWarnings.push(`模型與獨立市場機率差距${(probabilityGap * 100).toFixed(1)}個百分點，超過稽核線${(probabilityTolerance * 100).toFixed(1)}個百分點`);
    }
    if (sign(rawW) !== 0 && sign(referenceEV) !== 0 && sign(rawW) !== sign(referenceEV)) {
      auditWarnings.push('模型EV與獨立市場價格EV方向相反');
    }
    if (absoluteMarketEdgeExtreme) {
      auditWarnings.push(`Tai888與獨立市場價格差達${(Math.abs(referenceEV) * 100).toFixed(1)}%，列為外部價格異常稽核`);
    } else if (unverifiedMarketEdgeExtreme) {
      auditWarnings.push(`Tai888與獨立市場價格差達${(Math.abs(referenceEV) * 100).toFixed(1)}%，缺少第二個外部市場交叉驗證`);
    }
    if (weightedRobustGap > MAX_WEIGHTED_ROBUST_EV_GAP) {
      auditWarnings.push(`獨立市場加權與保守價格差距${(weightedRobustGap * 100).toFixed(1)}個百分點，超過稽核線`);
    }
  }

  const qualified = reasons.length === 0;
  // W and R are numerical outputs of the frozen baseball distribution. Reader
  // freshness, external evidence and downstream QA decide ranking/execution,
  // never whether an otherwise finite raw calculation is published.
  const weightedEV = rawW;
  const robustEV = rawW != null && rawR != null ? Math.min(rawW, rawR) : null;
  const status = qualified
    ? referenceEvidenceEligible ? 'QUALIFIED_MODEL_EV_WITH_INDEPENDENT_MARKET_AUDIT' : 'QUALIFIED_MODEL_EV_EXTERNAL_AUDIT_UNAVAILABLE'
    : marketEdgeExtreme ? 'MODEL_EV_VISIBLE_EXTREME_MARKET_EDGE_QA_BLOCK' : 'MODEL_EV_VISIBLE_QA_BLOCK';

  return {
    version: EV_CALIBRATION_V103_VERSION,
    qualified,
    status,
    reasons,
    auditWarnings,
    modelEvVisible: weightedEV != null,
    qaQualified: qualified,
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
    scenarioStable: rawScenarioSpread != null && rawScenarioSpread <= MAX_RAW_SCENARIO_EV_SPREAD,
    weightedRobustGap,
    calibratedProbability: qualified ? probability : null,
    calibratedRobustProbability: null,
    // Independent books remain a separate audit surface. They never enter the
    // model uncertainty set that defines public R.
    robustVariants: [],
    externalAuditVariants: priorEligible && referenceEV != null
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
