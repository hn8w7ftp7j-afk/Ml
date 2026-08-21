import Decimal from 'decimal.js';

export const SCORE_FORMULA_VERSION = 'DUAL-EV-BOTTLENECK-2026-08-v1.7.0';
export const SCORE_POLICY_VERSION = 'MLB-DAILY-CONTINUOUS-DUAL-EV-SCORE-2026-08';

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const decimal = (value, fallback = 0) => {
  try {
    if (value == null || value === '') return new Decimal(fallback);
    const result = new Decimal(value);
    return result.isFinite() ? result : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
};
const clampDecimal = (value, minimum = ZERO, maximum = ONE) => Decimal.max(minimum, Decimal.min(maximum, value));
const floorOneDecimal = value => decimal(value).mul(10).floor().div(10);
const roundOneDecimal = value => decimal(value).toDecimalPlaces(1, Decimal.ROUND_HALF_UP);
const toNumber = value => Number(decimal(value).toString());

export const SCORE_BANDS = Object.freeze({
  candidate: Object.freeze({ id: '7.2-7.4', startScore: '7.2', nextScore: '7.5', weightedLower: '0', weightedUpper: '0.020', robustLower: '0', robustUpper: '0.008' }),
  normal: Object.freeze({ id: '7.5-7.9', startScore: '7.5', nextScore: '8.0', weightedLower: '0.020', weightedUpper: '0.040', robustLower: '0.008', robustUpper: '0.020' }),
  primary: Object.freeze({ id: '8.0-8.4', startScore: '8.0', nextScore: '8.5', weightedLower: '0.040', weightedUpper: '0.070', robustLower: '0.020', robustUpper: '0.040' }),
  strongest: Object.freeze({ id: '8.5-8.9', startScore: '8.5', nextScore: '9.0', weightedLower: '0.070', weightedUpper: '0.120', robustLower: '0.040', robustUpper: '0.080' }),
});

function progress(value, lower, upper) {
  const denominator = decimal(upper).minus(lower);
  if (denominator.lte(0)) return ZERO;
  return clampDecimal(decimal(value).minus(lower).div(denominator));
}

// Keep the fixed qualification gates, but preserve comparison below 7.2.
// W and R are decimal returns (for example -0.05 means -5%).  The two terms
// intentionally penalize the central estimate and conservative tail together.
function nonPositiveScore(weightedEV, robustEV) {
  const raw = new Decimal('6.6').plus(decimal(weightedEV).mul(20)).plus(decimal(robustEV).mul(5));
  return roundOneDecimal(clampDecimal(raw, new Decimal('1.0'), new Decimal('6.6')));
}

function observationScore(weightedEV, robustEV) {
  const raw = new Decimal('6.9').plus(decimal(weightedEV).mul(5)).plus(decimal(robustEV).mul(10));
  return roundOneDecimal(clampDecimal(raw, new Decimal('6.7'), new Decimal('7.1')));
}

function selectBand(weightedEV, robustEV) {
  const weighted = decimal(weightedEV);
  const robust = decimal(robustEV);
  if (weighted.lte(0) || robust.lte(0)) return null;
  if (weighted.gte(SCORE_BANDS.strongest.weightedLower) && robust.gte(SCORE_BANDS.strongest.robustLower)) return SCORE_BANDS.strongest;
  if (weighted.gte(SCORE_BANDS.primary.weightedLower) && robust.gte(SCORE_BANDS.primary.robustLower)) return SCORE_BANDS.primary;
  if (weighted.gte(SCORE_BANDS.normal.weightedLower) && robust.gte(SCORE_BANDS.normal.robustLower)) return SCORE_BANDS.normal;
  return SCORE_BANDS.candidate;
}

export function deterministicScore(input = {}) {
  const weightedEV = decimal(input.weightedEV);
  const robustEV = decimal(input.robustEV);
  const qaPassed = input.qaPassed !== false;
  const actualWater = input.actualWater !== false;
  const executable = input.executable !== false;
  const crossMarketVerified = input.crossMarketVerified === true;
  const rawMarketProbabilityGap = decimal(input.rawMarketProbabilityGap, 0).abs();
  const caps = [];

  if (!qaPassed) return { score: null, rawScore: null, displayedScore: null, band: 'BLOCKED', label: '⛔ QA未通過｜不評分｜不下注', eligible: false, scoreType: actualWater ? 'FORMAL' : 'REFERENCE_SCREENING', formulaVersion: SCORE_FORMULA_VERSION, policyVersion: SCORE_POLICY_VERSION, weightedEV: toNumber(weightedEV), robustEV: toNumber(robustEV), rawMarketProbabilityGap: toNumber(rawMarketProbabilityGap), caps: ['QA_BLOCK'], progress: null, highScoreAnomaly: false };

  if (weightedEV.lte(0)) {
    const score = toNumber(nonPositiveScore(weightedEV, robustEV));
    return { score, rawScore: score, displayedScore: score, band: 'PASS_1.0-6.6', label: 'PASS', eligible: false, scoreType: actualWater ? 'FORMAL' : 'REFERENCE_SCREENING', formulaVersion: SCORE_FORMULA_VERSION, policyVersion: SCORE_POLICY_VERSION, weightedEV: toNumber(weightedEV), robustEV: toNumber(robustEV), rawMarketProbabilityGap: toNumber(rawMarketProbabilityGap), caps: ['WEIGHTED_EV_NON_POSITIVE'], progress: null, highScoreAnomaly: false };
  }

  if (robustEV.lte(0)) {
    const score = toNumber(observationScore(weightedEV, robustEV));
    return { score, rawScore: score, displayedScore: score, band: 'OBSERVATION_6.7-7.1', label: '觀察', eligible: false, scoreType: actualWater ? 'FORMAL' : 'REFERENCE_SCREENING', formulaVersion: SCORE_FORMULA_VERSION, policyVersion: SCORE_POLICY_VERSION, weightedEV: toNumber(weightedEV), robustEV: toNumber(robustEV), rawMarketProbabilityGap: toNumber(rawMarketProbabilityGap), caps: ['ROBUST_EV_NON_POSITIVE'], progress: null, highScoreAnomaly: false };
  }

  const band = selectBand(weightedEV, robustEV);
  const weightedProgress = progress(weightedEV, band.weightedLower, band.weightedUpper);
  const robustProgress = progress(robustEV, band.robustLower, band.robustUpper);
  const bottleneckProgress = Decimal.min(weightedProgress, robustProgress);
  const rawScore = decimal(band.startScore).plus(bottleneckProgress.mul(decimal(band.nextScore).minus(band.startScore)));
  let published = floorOneDecimal(rawScore);
  let publishedBand = band.id;

  if (!crossMarketVerified && published.gte(SCORE_BANDS.strongest.startScore)) {
    published = new Decimal('8.4');
    publishedBand = SCORE_BANDS.primary.id;
    caps.push('INDEPENDENT_MARKET_AUDIT_UNAVAILABLE');
  }
  if (published.gte(9)) { published = new Decimal('8.9'); caps.push('GENERAL_SINGLE_BET_MAX_8_9'); }

  const highScoreAnomaly = rawScore.gte(9);
  const score = toNumber(published);
  const formalEligible = actualWater && executable && score >= 7.2;
  if (!actualWater) caps.push('NON_ACTUAL_WATER_REFERENCE_ONLY');
  if (!executable) caps.push('HISTORICAL_OR_NON_EXECUTABLE_PRICE');

  return {
    score, rawScore: toNumber(rawScore), displayedScore: score, band: publishedBand,
    label: score >= 8.5 ? '最強主推' : score >= 8.0 ? '主推' : score >= 7.5 ? '正常下注' : score >= 7.2 ? '小注候選' : score >= 6.7 ? '觀察' : 'PASS',
    eligible: formalEligible, scoreType: actualWater ? 'FORMAL' : 'REFERENCE_SCREENING', formulaVersion: SCORE_FORMULA_VERSION, policyVersion: SCORE_POLICY_VERSION,
    weightedEV: toNumber(weightedEV), robustEV: toNumber(robustEV), rawMarketProbabilityGap: toNumber(rawMarketProbabilityGap),
    progress: { weighted: toNumber(weightedProgress), robust: toNumber(robustProgress), bottleneck: toNumber(bottleneckProgress), startScore: Number(band.startScore), nextScore: Number(band.nextScore), weightedLower: Number(band.weightedLower), weightedUpper: Number(band.weightedUpper), robustLower: Number(band.robustLower), robustUpper: Number(band.robustUpper) },
    caps, highScoreAnomaly,
  };
}

export function scoreBoundaryAudit(result, input = {}) {
  const errors = [];
  const weighted = decimal(input.weightedEV);
  const robust = decimal(input.robustEV);
  const score = result?.score == null ? null : Number(result.score);
  if (result?.formulaVersion !== SCORE_FORMULA_VERSION) errors.push('評分公式版本不符');
  if (score != null && (!Number.isFinite(score) || score < 1.0 || score > 8.9)) errors.push('連續S分數超出1.0～8.9');
  if (weighted.lte(0) && score !== toNumber(nonPositiveScore(weighted, robust))) errors.push('W≤0連續分數與W/R不一致');
  if (weighted.gt(0) && robust.lte(0) && score !== toNumber(observationScore(weighted, robust))) errors.push('W>0且R≤0連續分數與W/R不一致');
  if (score != null && score >= 7.2 && !(weighted.gt(0) && robust.gt(0))) errors.push('7.2+未通過雙EV正值門檻');
  if (score != null && score >= 7.5 && !(weighted.gte('0.020') && robust.gte('0.008'))) errors.push('7.5+未通過2.0%／0.8%門檻');
  if (score != null && score >= 8.0 && !(weighted.gte('0.040') && robust.gte('0.020'))) errors.push('8.0+未通過4.0%／2.0%門檻');
  if (score != null && score >= 8.5 && !(weighted.gte('0.070') && robust.gte('0.040'))) errors.push('8.5+未通過7.0%／4.0%雙EV門檻');
  return { ok: errors.length === 0, errors, formulaVersion: SCORE_FORMULA_VERSION };
}

export function floorScoreToOneDecimal(value) { return toNumber(floorOneDecimal(value)); }
