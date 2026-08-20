import { evFromProbability, hasActualWater } from './markets.js';

export const EV_CALIBRATION_V103_VERSION = 'LOCKED-OOS-EXTREME-EV-HOLD-2026-08-v10.3.1';
export const UNVERIFIED_EXTREME_EV_LIMIT = 0.15;

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

  // Until the locked out-of-sample / forward validation has proved that the
  // model is calibrated in this tail, an extreme raw EV is diagnostic only.
  // Independent market agreement is useful evidence, but it cannot promote
  // an unvalidated 15%+ model output into a valid W/R EV or S score.
  if (extreme) {
    reasons.push(`原始模型EV達${(Math.abs(rawW) * 100).toFixed(1)}%，超過15%極端值安全線；完成locked OOS與forward校準前只供稽核`);
  }

  if (priorEligible) {
    if (probabilityGap > probabilityTolerance) {
      reasons.push(`資料模型與獨立市場先驗差距${(probabilityGap * 100).toFixed(1)}個百分點，超過容許${(probabilityTolerance * 100).toFixed(1)}個百分點`);
    }
    if (sign(rawW) !== 0 && sign(referenceEV) !== 0 && sign(rawW) !== sign(referenceEV)) {
      reasons.push('資料模型EV與獨立市場價格EV方向相反');
    }
  }

  const qualified = reasons.length === 0;
  const robustEV = qualified
    ? priorEligible ? Math.min(rawR, referenceEV) : rawR
    : null;
  const weightedEV = qualified ? rawW : null;
  const status = qualified
    ? priorEligible ? 'QUALIFIED_WITH_INDEPENDENT_NO_VIG_PRIOR' : 'SHADOW_WITHIN_EXTREME_EV_GUARD'
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
