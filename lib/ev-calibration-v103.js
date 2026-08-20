import { evFromProbability, hasActualWater } from './markets.js';

export const EV_CALIBRATION_V103_VERSION = 'INDEPENDENT-PRIOR-EXTREME-EV-QUALIFICATION-2026-08-v10.3.0';
export const UNVERIFIED_EXTREME_EV_LIMIT = 0.15;

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function sign(value, epsilon = 1e-9) {
  const number = Number(value);
  return number > epsilon ? 1 : number < -epsilon ? -1 : 0;
}

export function qualifyEvV103({ row, rawWeightedEV, rawRobustEV, modelProbability, rebateRate = 0.015, gate = {} }) {
  const rawW = finite(rawWeightedEV);
  const rawR = finite(rawRobustEV);
  const probability = finite(modelProbability);
  const quality = clamp(finite(gate?.quality, 0.5), 0.5, 0.97);
  const probabilityTolerance = clamp(0.035 + (0.97 - quality) * 0.055, 0.035, 0.061);
  const priorProbability = finite(row?.marketVerification?.referenceNoVigProbability);
  const priorEligible = row?.marketVerification?.referencePriorEligible === true
    && priorProbability != null
    && hasActualWater(row?.water);
  const referenceEV = priorEligible
    ? evFromProbability(priorProbability, row.water, rebateRate)
    : null;
  const probabilityGap = priorEligible && probability != null
    ? Math.abs(probability - priorProbability)
    : null;
  const extreme = rawW != null && Math.abs(rawW) >= UNVERIFIED_EXTREME_EV_LIMIT;
  const reasons = [];

  if (rawW == null || rawR == null || probability == null) reasons.push('原始模型EV或機率不是有限數值');
  if (gate?.passedForShadowScore !== true) reasons.push('資料Gate未通過');

  if (priorEligible) {
    if (probabilityGap > probabilityTolerance) {
      reasons.push(`資料模型與獨立市場先驗差距${(probabilityGap * 100).toFixed(1)}個百分點，超過容許${(probabilityTolerance * 100).toFixed(1)}個百分點`);
    }
    if (sign(rawW) !== 0 && sign(referenceEV) !== 0 && sign(rawW) !== sign(referenceEV)) {
      reasons.push('資料模型EV與獨立市場價格EV方向相反');
    }
    if (extreme && Math.abs(referenceEV) < 0.08) {
      reasons.push('原始模型屬極端EV，但獨立市場未確認同等級錯價');
    }
  } else if (extreme) {
    reasons.push(`原始模型EV達${(Math.abs(rawW) * 100).toFixed(1)}%，但缺少可去水的獨立同合約半分盤先驗`);
  }

  const qualified = reasons.length === 0;
  const robustEV = qualified
    ? priorEligible ? Math.min(rawR, referenceEV) : rawR
    : null;
  const weightedEV = qualified ? rawW : null;
  const status = qualified
    ? priorEligible ? 'QUALIFIED_WITH_INDEPENDENT_NO_VIG_PRIOR' : 'SHADOW_WITHIN_UNVERIFIED_EXTREME_EV_GUARD'
    : 'CALIBRATION_BLOCK';

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
    referenceEV,
    probabilityGap,
    probabilityTolerance,
    unverifiedExtremeEvLimit: UNVERIFIED_EXTREME_EV_LIMIT,
    extreme,
    robustVariants: priorEligible && referenceEV != null
      ? [{ id: 'independent-reference-ev', value: referenceEV }]
      : [],
  };
}
