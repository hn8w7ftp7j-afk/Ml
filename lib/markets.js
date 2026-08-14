import { parseTaiwanContract, settleTaiwanContract, settlementProfit, profitFromNetFraction, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';

export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
export { SETTLEMENT_RULE_VERSION, settleTaiwanContract };

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const LINE_AT_END = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;
export const MIN_ACTUAL_WATER = 0.01;
export const MAX_ACTUAL_WATER = 3;

export function hasActualWater(value) {
  if (value == null || String(value).trim() === '') return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= MIN_ACTUAL_WATER && number <= MAX_ACTUAL_WATER;
}

export function normalizeWater(value, fallback = 0.95) {
  if (!hasActualWater(value)) return fallback;
  return clamp(Number(value), MIN_ACTUAL_WATER, MAX_ACTUAL_WATER);
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
      errors.push('水位範圍應為 0.010～3.000');
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
