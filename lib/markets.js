import { parseTaiwanContract, settleTaiwanContract, settlementProfit, profitFromNetFraction, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';

export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
export const SCORE_CONTRACT_VERSION = 'DUAL-EV-BOTTLENECK-2026-08-v1.0.0';
export { SETTLEMENT_RULE_VERSION, settleTaiwanContract };

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const LINE_AT_END = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;

export function hasActualWater(value) {
  if (value == null || String(value).trim() === '') return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.5 && number <= 1.5;
}

export function normalizeWater(value, fallback = 0.95) {
  if (!hasActualWater(value)) return fallback;
  return clamp(Number(value), 0.5, 1.5);
}

export function breakEvenProbability(water, rebateRate = 0) {
  const w = normalizeWater(water);
  const rebate = clamp(Number(rebateRate) || 0, 0, 0.1);
  return (1 - rebate) / Math.max(1e-12, w + 1);
}

export function evFromProbability(probability, water, rebateRate = 0.015) {
  const p = clamp(Number(probability) || 0, 0, 1);
  const w = normalizeWater(water);
  const r = clamp(Number(rebateRate) || 0, 0, 0.1);
  return p * (w + r) - (1 - p) * (1 - r);
}

function smooth(value, scale) {
  return Math.tanh(value / Math.max(1e-9, scale));
}

/**
 * Composite rating for the user's MLB framework.
 * EV is a qualification gate and important evidence, not a direct EV -> score table.
 */
export function scoreEvidenceBreakdown(conservativeEV, options = {}) {
  const conservative = Number.isFinite(Number(conservativeEV)) ? Number(conservativeEV) : 0;
  const weightedEV = Number.isFinite(Number(options.weightedEV)) ? Number(options.weightedEV) : conservative;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : conservative;
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const qualityValue = Number(options.quality ?? options.confidence);
  const quality = clamp(Number.isFinite(qualityValue) ? qualityValue : 0.72, 0.35, 1);
  const edgeStrength = clamp(Number(options.edgeStrength) || 0, -1, 1);
  const stabilityValue = Number(options.stability);
  const stability = clamp(Number.isFinite(stabilityValue) ? stabilityValue : (1 - flipProbability), 0, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const divergenceRisk = clamp(Number(options.divergenceRisk) || 0, 0, 0.50);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const edgeAboveError = conservative - modelErrorFloor;

  const asymmetric = (value, positiveWeight, positiveScale, negativeWeight, negativeScale) => (
    value >= 0
      ? positiveWeight * smooth(value, positiveScale)
      : negativeWeight * smooth(value, negativeScale)
  );

  // The user's GPT scale is centred near 5.0. Positive evidence may build into
  // the 7.2/8.0/8.5 bands, while ordinary negative EV declines smoothly rather
  // than collapsing every weak direction onto the same artificial 3.5 floor.
  const components = {
    weightedEV: asymmetric(weightedEV, 0.95, 0.055, 0.62, 0.065),
    robustEV: asymmetric(robustEV, 1.05, 0.050, 0.72, 0.060),
    conservativeEV: asymmetric(conservative, 0.70, 0.045, 0.48, 0.075),
    edgeStrength: 0.45 * edgeStrength,
    stability: 0.32 * ((stability - 0.5) * 2),
    dataQuality: 0.24 * ((quality - 0.70) / 0.30),
    independentEvidence: 0.19 * ((independentEvidence - 0.40) / 0.45),
    flipRisk: -0.30 * flipProbability,
    divergenceRisk: -0.15 * divergenceRisk,
  };
  const rawScore = 5 + Object.values(components).reduce((sum, value) => sum + value, 0);

  let cap = 9.4;
  const capReasons = [];
  if (integrityWarning || waterEstimated) {
    cap = 6.6;
    capReasons.push(integrityWarning ? '資料完整性警告' : '暫估水位');
  } else if (weightedEV <= 0) {
    cap = 6.6;
    capReasons.push('加權 EV 非正');
  } else if (robustEV <= 0 || conservative <= 0) {
    cap = 7.1;
    capReasons.push('穩健或保守 EV 非正');
  } else if (conservative <= modelErrorFloor) {
    cap = 7.4;
    capReasons.push('保守 EV 未明顯超過模型誤差');
  } else {
    if (robustEV < modelErrorFloor + 0.012 || conservative < modelErrorFloor + 0.004) {
      cap = Math.min(cap, 7.4);
      capReasons.push('正 EV 證據偏薄');
    } else if (robustEV < modelErrorFloor + 0.027 || conservative < modelErrorFloor + 0.014) {
      cap = Math.min(cap, 7.9);
      capReasons.push('穩健優勢尚未達主推');
    } else if (robustEV < modelErrorFloor + 0.050 || conservative < modelErrorFloor + 0.030) {
      cap = Math.min(cap, 8.4);
      capReasons.push('優勢未達最強主推');
    }

    if (flipProbability > 0.35) {
      cap = Math.min(cap, 7.4);
      capReasons.push('EV 翻負風險高');
    } else if (flipProbability > 0.25) {
      cap = Math.min(cap, 7.9);
      capReasons.push('EV 翻負風險偏高');
    } else if (flipProbability > 0.15) {
      cap = Math.min(cap, 8.4);
      capReasons.push('EV 翻負風險未達最強門檻');
    }

    if (cap > 8.4 && (
      independentEvidence < 0.55
      || quality < 0.78
      || flipProbability > 0.12
      || edgeAboveError < 0.035
    )) {
      cap = 8.4;
      capReasons.push('獨立證據／品質／誤差優勢不足');
    }
  }

  const floor = 1.0;
  const score = clamp(rawScore, floor, cap);
  return {
    version: SCORE_CONTRACT_VERSION,
    score,
    rawScore,
    floor,
    cap,
    clampedLow: rawScore < floor,
    clampedHigh: rawScore > cap,
    capReasons,
    components,
    evidence: {
      weightedEV,
      robustEV,
      conservativeEV: conservative,
      flipProbability,
      quality,
      edgeStrength,
      stability,
      modelErrorFloor,
      edgeAboveError,
      independentEvidence,
      divergenceRisk,
      integrityWarning,
      waterEstimated,
    },
  };
}

export function scoreFromCompositeEV(conservativeEV, options = {}) {
  return scoreEvidenceBreakdown(conservativeEV, options).score;
}

export function validateScoreContract(score, conservativeEV, options = {}) {
  const errors = [];
  const value = Number(score);
  const conservative = Number(conservativeEV);
  const weightedEV = Number(options.weightedEV);
  const robustEV = Number(options.robustEV);
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const qualityValue = Number(options.quality ?? options.confidence);
  const quality = clamp(Number.isFinite(qualityValue) ? qualityValue : 0.72, 0.35, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const breakdown = scoreEvidenceBreakdown(conservative, options);

  if (!Number.isFinite(value)) errors.push('評分不是有限數值');
  if (Number.isFinite(value) && (value < 1 - 1e-9 || value > 9.4 + 1e-9)) errors.push('評分超出 1.0～9.4 正式尺度');
  if (Number.isFinite(value) && (Math.abs(value) < 1e-9 || Math.abs(value - 10) < 1e-9)) errors.push('正式評分不可直接落在 0 或 10');
  if (Number.isFinite(value) && Math.abs(value - breakdown.score) > 1e-9) errors.push('評分與固定公式重算不一致');
  if (!Number.isFinite(conservative) || !Number.isFinite(weightedEV) || !Number.isFinite(robustEV)) errors.push('EV 證據不完整');
  if ((integrityWarning || waterEstimated) && value > 6.600001) errors.push('資料或水位未確認卻高於 6.6');
  if (weightedEV <= 0 && value > 6.600001) errors.push('加權 EV 非正卻高於 6.6');
  if ((robustEV <= 0 || conservative <= 0) && value > 7.100001) errors.push('穩健／保守 EV 非正卻高於 7.1');
  if (value >= 7.2 && !(weightedEV > 0 && robustEV > 0 && conservative > 0 && !integrityWarning && !waterEstimated)) {
    errors.push('7.2+ 未通過正 EV 與完整性門檻');
  }
  if (value >= 8.5 && (
    robustEV < modelErrorFloor + 0.050
    || conservative < modelErrorFloor + 0.035
    || flipProbability > 0.12
    || quality < 0.78
    || independentEvidence < 0.55
  )) errors.push('8.5+ 未通過最強主推證據門檻');

  return {
    ok: errors.length === 0,
    version: SCORE_CONTRACT_VERSION,
    errors,
    expectedScore: breakdown.score,
    breakdown,
  };
}

// Backward-compatible wrapper used by older callers/tests.
export function scoreFromEV(weightedEV, confidence = 0.75, options = {}) {
  return scoreFromCompositeEV(
    Number.isFinite(Number(options.conservativeEV)) ? Number(options.conservativeEV) : weightedEV,
    {
      ...options,
      weightedEV,
      robustEV: Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : weightedEV,
      confidence,
      quality: options.quality ?? options.dataQuality ?? confidence,
    },
  );
}

export function resultTag(score, candidate = 7.2, strongest = 8.5) {
  if (score == null || !Number.isFinite(Number(score))) return '不評分';
  if (score >= strongest) return '最強主推';
  if (score >= 8.0) return '主推';
  if (score >= 7.5) return '正常下注';
  if (score >= candidate) return '小注候選';
  if (score >= 6.7) return '觀察';
  return 'PASS';
}

export function parseTaiwanLine(pick, options = {}) {
  return parseTaiwanContract(pick, options);
}

function normalizeTeamName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

export function outcomeSettlementForScore(pick, awayRuns, homeRuns, awayName = '', homeName = '', options = {}) {
  return settleTaiwanContract(pick, awayRuns, homeRuns, awayName, homeName, options);
}

export function outcomeFractionForScore(pick, awayRuns, homeRuns, awayName = '', homeName = '') {
  const settlement = settleTaiwanContract(pick, awayRuns, homeRuns, awayName, homeName);
  return settlement == null ? null : settlement.netFraction;
}

export function resultLabel(fraction) {
  if (fraction == null || !Number.isFinite(Number(fraction))) return '無法結算';
  const value = Number(fraction);
  if (Math.abs(value - 1) < 1e-9) return '勝';
  if (Math.abs(value + 1) < 1e-9) return '敗';
  if (Math.abs(value) < 1e-9) return '走水';
  if (Math.abs(value - 0.5) < 1e-9) return '半勝';
  if (Math.abs(value + 0.5) < 1e-9) return '半敗';
  return `${value > 0 ? '贏' : '輸'}${Math.round(Math.abs(value) * 100)}%`;
}

export function calculateProfit({ stake, water, fraction, settlement = null, rebateRate = 0.015 }) {
  return settlement
    ? settlementProfit({ stake, water, settlement, rebateRate })
    : profitFromNetFraction({ stake, water, fraction, rebateRate });
}

export function priceCLV(openWater, closeWater) {
  return breakEvenProbability(closeWater) - breakEvenProbability(openWater);
}

export function extractLineToken(pick) {
  const parsed = parseTaiwanLine(pick);
  return parsed.valid ? `${parsed.lineText}${parsed.modifier}` : '';
}

export function mirrorTaiwanLineToken(value) {
  const token = String(value || '').replace(/\s+/g, '');
  const match = token.match(/^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/);
  if (!match) return '';
  const base = match[1];
  const modifier = match[2] || '';
  if (!modifier || modifier === '平') return `${base}${modifier}`;
  return `${base}${modifier[0] === '+' ? '-' : '+'}${modifier.slice(1)}`;
}

function sameTaiwanLineBase(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick);
  const right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.legs.length !== right.legs.length) return false;
  return left.legs.every((value, index) => Math.abs(value - right.legs[index]) < 1e-9);
}

function mirroredTaiwanPair(leftPick, rightPick) {
  const left = extractLineToken(leftPick);
  const right = extractLineToken(rightPick);
  return Boolean(left && right && mirrorTaiwanLineToken(left) === right);
}

export function marketIsOpen(directions) {
  return (Array.isArray(directions) ? directions : []).some(direction => String(direction?.pick || '').trim() !== '');
}


function numericLineBase(pick) {
  const parsed = typeof pick === 'string' ? parseTaiwanLine(pick) : pick;
  if (!parsed?.valid || !parsed.legs?.length) return null;
  return parsed.legs.reduce((sum, value) => sum + value, 0) / parsed.legs.length;
}

function plausibleMarketLine(market, pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) return false;
  const base = numericLineBase(parsed);
  if (!Number.isFinite(base)) return false;
  // MLB full-game runlines are normally small; values such as 9-10 are almost certainly a total/water column shifted into runline.
  if (market === '全場讓分') return base >= 0 && base <= 4.5;
  if (market === '上半讓分') return base >= 0 && base <= 3.0;
  if (market === '全場大小') return base >= 4.5 && base <= 16.5;
  if (market === '上半大小') return base >= 2.0 && base <= 10.0;
  return true;
}

export function validateMarketPair(market, directions) {
  const rows = Array.isArray(directions) ? directions.slice(0, 2) : [];
  const errors = [];
  if (!marketIsOpen(rows)) return errors;
  if (rows.length !== 2) errors.push('已開盤市場必須有兩個方向');

  for (const row of rows) {
    const pick = String(row?.pick || '').trim();
    if (!pick) errors.push('已開盤市場的方向＋盤口不可空白');
    else if (pick.length > 120) errors.push('盤口文字過長');
    else if (!parseTaiwanLine(pick).valid) errors.push(`盤口格式無法辨識：${pick}`);
    else if (!plausibleMarketLine(market, pick)) errors.push(`盤口數值與市場不合理，疑似辨識錯欄：${pick}`);

    if (row?.water != null && String(row.water).trim() !== '' && !hasActualWater(row.water)) {
      errors.push('水位範圍應為 0.500～1.500');
    }
  }

  if (rows.length === 2 && rows[0]?.pick && rows[1]?.pick) {
    const left = parseTaiwanLine(rows[0].pick);
    const right = parseTaiwanLine(rows[1].pick);
    if (market.includes('大小')) {
      if (!((left.isOver && right.isUnder) || (left.isUnder && right.isOver))) errors.push('大小盤必須是一大一小');
      if (extractLineToken(rows[0].pick) !== extractLineToken(rows[1].pick)) errors.push('大小盤兩邊總分線不一致');
    } else {
      if (!((left.isGiving && right.isReceiving) || (left.isReceiving && right.isGiving))) errors.push('讓分盤必須是一讓一受讓');
      if (extractLineToken(rows[0].pick) !== extractLineToken(rows[1].pick)) errors.push('讓分盤兩邊盤口不一致');
      if (normalizeTeamName(left.team) && normalizeTeamName(left.team) === normalizeTeamName(right.team)) errors.push('讓分盤兩個方向不可是同一隊');
    }
  }
  return [...new Set(errors)];
}


function cleanVisionLine(value) {
  if (value == null) return '';
  const line = String(value).replace(/\s+/g, '').trim().slice(0, 20);
  if (!line || /^(?:null|undefined|none|n\/a|na|nil|未開盤|未開|無|沒有|—|-)$/i.test(line)) return '';
  return /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/.test(line) ? line : '';
}

function fallbackForMarket(defaultWater, market, fallback) {
  if (defaultWater && typeof defaultWater === 'object' && hasActualWater(defaultWater[market])) return Number(defaultWater[market]);
  if (hasActualWater(defaultWater)) return Number(defaultWater);
  return fallback;
}

function visionWater(value, fallback, estimateBoth) {
  if (hasActualWater(value)) return { water: Number(value), waterEstimated: false, waterMissing: false };
  if (estimateBoth) return { water: fallback, waterEstimated: true, waterMissing: false };
  return { water: null, waterEstimated: false, waterMissing: true };
}

export function normalizeVisionGame(raw, scheduleGame = null, defaultWater = null) {
  const away = scheduleGame?.away || String(raw?.away || '').slice(0, 80);
  const home = scheduleGame?.home || String(raw?.home || '').slice(0, 80);
  const marketMap = [
    ['全場讓分', raw?.fullRunline, 0.95],
    ['全場大小', raw?.fullTotal, 0.94],
    ['上半讓分', raw?.first5Runline, 0.94],
    ['上半大小', raw?.first5Total, 0.93],
  ];

  const markets = marketMap.map(([market, value, standardFallback]) => {
    const fallback = fallbackForMarket(defaultWater, market, standardFallback);
    if (market.includes('大小')) {
      const line = cleanVisionLine(value?.line);
      if (!line || !plausibleMarketLine(market, `大${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }] };
      const overActual = hasActualWater(value?.overWater);
      const underActual = hasActualWater(value?.underWater);
      const estimateBoth = !overActual && !underActual;
      return {
        market,
        directions: [
          { pick: `大${line}`, ...visionWater(value?.overWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
          { pick: `小${line}`, ...visionWater(value?.underWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        ],
      };
    }

    const line = cleanVisionLine(value?.line);
    const lineSide = value?.lineSide || value?.listedSide || value?.favoriteSide;
    const favorite = lineSide === 'away' ? away : lineSide === 'home' ? home : '';
    const underdog = lineSide === 'away' ? home : lineSide === 'home' ? away : '';
    if (!line || !favorite || !underdog || !plausibleMarketLine(market, `${favorite}讓${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口方向或數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口方向或數值疑似辨識錯欄' : '' }] };

    const awayWater = hasActualWater(value?.awayWater) ? Number(value.awayWater) : null;
    const homeWater = hasActualWater(value?.homeWater) ? Number(value.homeWater) : null;
    const favoriteWater = lineSide === 'away' ? awayWater : homeWater;
    const underdogWater = lineSide === 'away' ? homeWater : awayWater;
    const resolvedFavoriteWater = hasActualWater(favoriteWater) ? favoriteWater : value?.favoriteWater;
    const resolvedUnderdogWater = hasActualWater(underdogWater) ? underdogWater : value?.underdogWater;
    const favoriteActual = hasActualWater(resolvedFavoriteWater);
    const underdogActual = hasActualWater(resolvedUnderdogWater);
    const estimateBoth = !favoriteActual && !underdogActual;
    const oppositeLine = mirrorTaiwanLineToken(line);
    return {
      market,
      directions: [
        { pick: `${favorite}讓${line}`, ...visionWater(resolvedFavoriteWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        { pick: `${underdog}受讓${line}`, ...visionWater(resolvedUnderdogWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
      ],
    };
  });

  return {
    away,
    home,
    gamePk: scheduleGame?.gamePk || raw?.gamePk || null,
    confidence: clamp(Number(raw?.confidence || 0), 0, 1),
    markets,
  };
}
