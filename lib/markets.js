export const MARKET_ORDER = ['全場讓分', '全場大小', '上半讓分', '上半大小'];

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function normalizeWater(value, fallback = 0.95) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0.5, 1.5) : fallback;
}

export function breakEvenProbability(water) {
  const w = normalizeWater(water);
  return 1 / (1 + w);
}

export function evFromProbability(probability, water) {
  const p = clamp(Number(probability) || 0, 0, 1);
  const w = normalizeWater(water);
  return p * w - (1 - p);
}

function positiveScore(ev) {
  if (ev < 0.02) return 5 + ev * 70;
  if (ev < 0.035) return 6.4 + (ev - 0.02) * (0.8 / 0.015);
  if (ev < 0.055) return 7.2 + (ev - 0.035) * 40;
  if (ev < 0.08) return 8 + (ev - 0.055) * 20;
  if (ev < 0.12) return 8.5 + (ev - 0.08) * 12.5;
  if (ev < 0.18) return 9 + (ev - 0.12) * (0.4 / 0.06);
  return 9.4 + Math.min(0.2, (ev - 0.18) * 1.5);
}

function scoreCap(confidence, ev) {
  const c = clamp(Number(confidence) || 0.75, 0.35, 1);
  if (c < 0.55) return 6.8;
  if (c < 0.65) return 7.4;
  if (c < 0.75) return 8;
  if (c < 0.85) return 8.6;
  if (c < 0.93) return 9.1;
  if (c < 0.97 || ev < 0.18) return 9.4;
  return 9.6;
}

export function scoreFromEV(weightedEV, confidence = 0.75) {
  const ev = Number(weightedEV) || 0;
  const raw = ev >= 0 ? positiveScore(ev) : 5 + Math.max(-0.12, ev) * (4 / 0.12);
  return clamp(Math.min(raw, scoreCap(confidence, ev)), 1, 9.6);
}

export function resultTag(score, candidate = 7.2, strongest = 8.5) {
  if (score >= strongest) return '最強主推';
  if (score >= candidate) return '下注候選';
  return '';
}

export function parseTaiwanLine(pick) {
  const raw = String(pick || '').replace(/\s+/g, '').slice(0, 160);
  const isTotal = /大|小|over|under/i.test(raw);
  const isOver = /大|over/i.test(raw);
  const isUnder = /小|under/i.test(raw);
  const isGiving = /讓/.test(raw) && !/受讓/.test(raw);
  const isReceiving = /受讓/.test(raw);
  const team = raw
    .replace(/受讓|讓|大|小|over|under/gi, '')
    .replace(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?:平|[+-]\d{1,3})?/g, '');
  const match = raw.match(/(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?/);
  if (!match) return { raw, valid: false, isTotal, isOver, isUnder, isGiving, isReceiving, team };
  const lineText = match[1];
  const modifier = match[2] || '';
  const legs = lineText.split('/').map(Number).filter(Number.isFinite);
  return {
    raw,
    valid: legs.length > 0 && (isTotal ? isOver || isUnder : isGiving || isReceiving),
    isTotal,
    isOver,
    isUnder,
    isGiving,
    isReceiving,
    team,
    lineText,
    legs,
    modifier,
  };
}

function settleStandard(value) {
  if (value > 1e-9) return 1;
  if (value < -1e-9) return -1;
  return 0;
}

function exactModifierOutcome(modifier, positiveSide) {
  if (!modifier || modifier === '平') return 0;
  const sign = modifier[0];
  const fraction = clamp(Number(modifier.slice(1)) / 100, 0, 1);
  if (!Number.isFinite(fraction)) return 0;
  const favoriteOrOver = sign === '-' ? fraction : -fraction;
  return positiveSide ? favoriteOrOver : -favoriteOrOver;
}

export function outcomeFractionForScore(pick, awayRuns, homeRuns, awayName = '', homeName = '') {
  const p = typeof pick === 'string' ? parseTaiwanLine(pick) : pick;
  if (!p?.valid) return null;
  if (awayRuns == null || homeRuns == null || String(awayRuns).trim() === '' || String(homeRuns).trim() === '') return null;
  const ar = Number(awayRuns), hr = Number(homeRuns);
  if (!Number.isFinite(ar) || !Number.isFinite(hr)) return null;
  const total = ar + hr;
  let chosenMargin = 0;
  if (!p.isTotal) {
    const normName = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    const normalizedTeam = normName(p.team);
    const away = normName(awayName);
    const home = normName(homeName);
    const isAway = normalizedTeam && away && (away.includes(normalizedTeam) || normalizedTeam.includes(away));
    const isHome = normalizedTeam && home && (home.includes(normalizedTeam) || normalizedTeam.includes(home));
    if (!isAway && !isHome) return null;
    chosenMargin = isAway ? ar - hr : hr - ar;
  }

  const settleLeg = (line) => {
    if (p.isTotal) {
      const delta = p.isOver ? total - line : line - total;
      if (Math.abs(delta) < 1e-9) return exactModifierOutcome(p.modifier, p.isOver);
      return settleStandard(delta);
    }
    if (p.isGiving) {
      const delta = chosenMargin - line;
      if (Math.abs(delta) < 1e-9) return exactModifierOutcome(p.modifier, true);
      return settleStandard(delta);
    }
    const delta = chosenMargin + line;
    if (Math.abs(delta) < 1e-9) return exactModifierOutcome(p.modifier, false);
    return settleStandard(delta);
  };

  return p.legs.reduce((sum, leg) => sum + settleLeg(leg), 0) / p.legs.length;
}

export function resultLabel(fraction) {
  if (fraction == null || !Number.isFinite(Number(fraction))) return '無法結算';
  const f = Number(fraction);
  if (Math.abs(f - 1) < 1e-9) return '勝';
  if (Math.abs(f + 1) < 1e-9) return '敗';
  if (Math.abs(f) < 1e-9) return '走水';
  if (Math.abs(f - 0.5) < 1e-9) return '半勝';
  if (Math.abs(f + 0.5) < 1e-9) return '半敗';
  return `${f > 0 ? '贏' : '輸'}${Math.round(Math.abs(f) * 100)}%`;
}

export function calculateProfit({ stake, water, fraction, rebateRate = 0.015 }) {
  const s = Math.max(0, Number(stake) || 0);
  const w = normalizeWater(water);
  const f = clamp(Number(fraction) || 0, -1, 1);
  if (Math.abs(f) < 1e-9 || s === 0) return { profit: 0, rebate: 0, settledAmount: 0 };
  const settledAmount = s * Math.abs(f);
  const rebate = settledAmount * Math.max(0, Number(rebateRate) || 0);
  const profit = f > 0 ? settledAmount * w + rebate : -settledAmount + rebate;
  return { profit, rebate, settledAmount };
}

export function priceCLV(openWater, closeWater) {
  return breakEvenProbability(closeWater) - breakEvenProbability(openWater);
}

export function extractLineToken(pick) {
  const p = parseTaiwanLine(pick);
  return p.valid ? `${p.lineText}${p.modifier}` : '';
}

export function marketIsOpen(directions) {
  return (Array.isArray(directions) ? directions : []).some(d => String(d?.pick || '').trim() !== '');
}

export function validateMarketPair(market, directions) {
  const ds = Array.isArray(directions) ? directions.slice(0, 2) : [];
  const errors = [];
  if (!marketIsOpen(ds)) return errors;
  if (ds.length !== 2) errors.push('已開盤市場必須有兩個方向');
  for (const d of ds) {
    const pick = String(d?.pick || '').trim();
    if (!pick) errors.push('已開盤市場的方向＋盤口不可空白');
    else if (pick.length > 120) errors.push('盤口文字過長');
    else if (!parseTaiwanLine(pick).valid) errors.push(`盤口格式無法辨識：${pick}`);
    if (pick && (d?.water == null || String(d.water).trim() === '' || !Number.isFinite(Number(d.water)))) errors.push('已開盤市場的水位不可空白');
    else if (pick && (Number(d.water) < 0.5 || Number(d.water) > 1.5)) errors.push('水位範圍應為 0.500～1.500');
  }
  if (ds.length === 2 && ds[0]?.pick && ds[1]?.pick) {
    const a = parseTaiwanLine(ds[0].pick), b = parseTaiwanLine(ds[1].pick);
    if (market.includes('大小')) {
      if (!(a.isOver && b.isUnder) && !(a.isUnder && b.isOver)) errors.push('大小盤必須是一大一小');
      if (extractLineToken(ds[0].pick) !== extractLineToken(ds[1].pick)) errors.push('大小盤兩邊總分線不一致');
    } else {
      if (!(a.isGiving && b.isReceiving) && !(a.isReceiving && b.isGiving)) errors.push('讓分盤必須是一讓一受讓');
      if (extractLineToken(ds[0].pick) !== extractLineToken(ds[1].pick)) errors.push('讓分盤兩邊盤口不一致');
    }
  }
  return [...new Set(errors)];
}

export function normalizeVisionGame(raw, scheduleGame = null, defaultWater = 0.95) {
  const away = scheduleGame?.away || String(raw?.away || '').slice(0, 80);
  const home = scheduleGame?.home || String(raw?.home || '').slice(0, 80);
  const marketMap = [
    ['全場讓分', raw?.fullRunline],
    ['全場大小', raw?.fullTotal],
    ['上半讓分', raw?.first5Runline],
    ['上半大小', raw?.first5Total],
  ];
  const markets = marketMap.map(([market, value]) => {
    if (market.includes('大小')) {
      const line = String(value?.line || '').slice(0, 20);
      return {
        market,
        directions: [
          { pick: line ? `大${line}` : '', water: normalizeWater(value?.overWater, defaultWater), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
          { pick: line ? `小${line}` : '', water: normalizeWater(value?.underWater, defaultWater), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        ],
      };
    }
    const line = String(value?.line || '').slice(0, 20);
    const favoriteSide = value?.favoriteSide;
    const favorite = favoriteSide === 'away' ? away : favoriteSide === 'home' ? home : '';
    const underdog = favoriteSide === 'away' ? home : favoriteSide === 'home' ? away : '';
    return {
      market,
      directions: [
        { pick: line && favorite ? `${favorite}讓${line}` : '', water: normalizeWater(value?.favoriteWater, defaultWater), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        { pick: line && underdog ? `${underdog}受讓${line}` : '', water: normalizeWater(value?.underdogWater, defaultWater), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
      ],
    };
  });
  return { away, home, gamePk: scheduleGame?.gamePk || raw?.gamePk || null, confidence: clamp(Number(raw?.confidence || 0), 0, 1), markets };
}
