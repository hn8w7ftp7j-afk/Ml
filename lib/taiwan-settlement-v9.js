import Decimal from 'decimal.js';

export const SETTLEMENT_RULE_VERSION = 'TW-CREDIT-PER-LEG-REBATE-2026-08-v1.0.0';

const LINE_AT_END = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/;
const decimal = (value, fallback = 0) => {
  try {
    if (value == null || value === '') return new Decimal(fallback);
    const result = new Decimal(value);
    return result.isFinite() ? result : new Decimal(fallback);
  } catch {
    return new Decimal(fallback);
  }
};
const number = value => Number(decimal(value).toString());
const cleanTeam = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

function sameTeam(left, right) {
  const a = cleanTeam(left);
  const b = cleanTeam(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export function parseTaiwanContract(pick, options = {}) {
  const rawText = String(pick || '').trim().slice(0, 240);
  const raw = rawText.replace(/\s+/g, '');
  const match = raw.match(LINE_AT_END);
  if (!match) {
    return {
      rawText,
      raw,
      valid: false,
      period: options.period || null,
      marketType: options.marketType || null,
      direction: null,
      referenceSide: options.referenceSide || null,
      legs: [],
      tailSign: null,
      tailPercent: null,
      modifier: '',
      team: '',
    };
  }

  const lineText = match[1];
  const modifier = match[2] || '';
  const prefix = raw.slice(0, match.index);
  const totalMarker = prefix.match(/^(大|小|over|under)$/i)?.[1] || '';
  const isOver = /^(大|over)$/i.test(totalMarker);
  const isUnder = /^(小|under)$/i.test(totalMarker);
  const isTotal = Boolean(totalMarker);
  const isReceiving = !isTotal && prefix.endsWith('受讓');
  const isGiving = !isTotal && !isReceiving && prefix.endsWith('讓');
  const team = isReceiving ? prefix.slice(0, -2) : isGiving ? prefix.slice(0, -1) : '';
  const legTexts = lineText.split('/');
  const legs = legTexts.map(value => decimal(value, NaN)).filter(value => value.isFinite() && value.gte(0));
  const tailSign = !modifier || modifier === '平' ? (modifier === '平' ? 'flat' : 'none') : modifier[0] === '+' ? 'positive' : 'negative';
  const tailPercent = tailSign === 'positive' || tailSign === 'negative'
    ? Number(modifier.slice(1))
    : 0;
  const direction = isOver ? 'over' : isUnder ? 'under' : isGiving ? 'giving' : isReceiving ? 'receiving' : null;
  const referenceSide = options.referenceSide
    || (isTotal ? 'over' : isGiving ? 'listed-team' : isReceiving ? 'opposite-listed-team' : null);

  return {
    rawText,
    raw,
    valid: legs.length > 0 && Boolean(direction) && (isTotal || Boolean(team)),
    period: options.period || null,
    marketType: options.marketType || (isTotal ? 'total' : 'runline'),
    direction,
    referenceSide,
    isTotal,
    isOver,
    isUnder,
    isGiving,
    isReceiving,
    team,
    lineText,
    legTexts,
    legs: legs.map(number),
    modifier,
    tailSign,
    tailPercent: Number.isFinite(tailPercent) ? Math.max(0, Math.min(100, tailPercent)) : 0,
    sourceTemplateVersion: options.sourceTemplateVersion || null,
  };
}

function exactReferenceOutcome(contract) {
  if (!contract.modifier || contract.modifier === '平' || contract.tailSign === 'flat' || contract.tailSign === 'none') return new Decimal(0);
  const fraction = decimal(contract.tailPercent).div(100);
  return contract.tailSign === 'positive' ? fraction : fraction.neg();
}

function standardOutcome(delta) {
  if (delta.gt(0)) return new Decimal(1);
  if (delta.lt(0)) return new Decimal(-1);
  return new Decimal(0);
}

function selectedMargin(contract, awayRuns, homeRuns, awayName, homeName) {
  if (contract.isTotal) return null;
  const isAway = sameTeam(contract.team, awayName);
  const isHome = sameTeam(contract.team, homeName);
  if ((isAway && isHome) || (!isAway && !isHome)) return null;
  return isAway ? decimal(awayRuns).minus(homeRuns) : decimal(homeRuns).minus(awayRuns);
}

export function settleTaiwanContract(pickOrContract, awayRuns, homeRuns, awayName = '', homeName = '', options = {}) {
  const contract = typeof pickOrContract === 'string'
    ? parseTaiwanContract(pickOrContract, options)
    : pickOrContract;
  if (!contract?.valid) return null;
  if (awayRuns == null || homeRuns == null || String(awayRuns).trim() === '' || String(homeRuns).trim() === '') return null;
  const away = decimal(awayRuns, NaN);
  const home = decimal(homeRuns, NaN);
  if (!away.isFinite() || !home.isFinite()) return null;
  const total = away.plus(home);
  const margin = selectedMargin(contract, away, home, awayName, homeName);
  if (!contract.isTotal && margin == null) return null;
  const allocation = new Decimal(1).div(contract.legs.length);
  const referenceExact = exactReferenceOutcome(contract);

  const legs = contract.legs.map((lineValue, index) => {
    const line = decimal(lineValue);
    let delta;
    let positiveReferenceSide;
    if (contract.isTotal) {
      delta = contract.isOver ? total.minus(line) : line.minus(total);
      positiveReferenceSide = contract.isOver;
    } else if (contract.isGiving) {
      delta = margin.minus(line);
      positiveReferenceSide = true;
    } else {
      delta = margin.plus(line);
      positiveReferenceSide = false;
    }
    const exact = delta.abs().lte('0.000000000001');
    const fraction = exact
      ? (positiveReferenceSide ? referenceExact : referenceExact.neg())
      : standardOutcome(delta);
    const winShare = Decimal.max(0, fraction);
    const lossShare = Decimal.max(0, fraction.neg());
    const pushShare = Decimal.max(0, new Decimal(1).minus(winShare).minus(lossShare));
    return {
      index,
      line: number(line),
      allocation: number(allocation),
      fraction: number(fraction),
      winShare: number(winShare),
      lossShare: number(lossShare),
      pushShare: number(pushShare),
      exactLine: exact,
    };
  });

  const winFraction = legs.reduce((sum, leg) => sum.plus(decimal(leg.allocation).mul(leg.winShare)), new Decimal(0));
  const lossFraction = legs.reduce((sum, leg) => sum.plus(decimal(leg.allocation).mul(leg.lossShare)), new Decimal(0));
  const pushFraction = legs.reduce((sum, leg) => sum.plus(decimal(leg.allocation).mul(leg.pushShare)), new Decimal(0));
  const netFraction = winFraction.minus(lossFraction);

  return {
    version: SETTLEMENT_RULE_VERSION,
    contract,
    legs,
    winFraction: number(winFraction),
    lossFraction: number(lossFraction),
    pushFraction: number(pushFraction),
    netFraction: number(netFraction),
    coverage: number(winFraction.plus(lossFraction).plus(pushFraction)),
  };
}

function waterForLeg(water, index, leg) {
  if (Array.isArray(water)) return decimal(water[index] ?? water[0] ?? 0.95);
  if (leg?.water != null) return decimal(leg.water);
  return decimal(water == null ? 0.95 : water);
}

export function settlementProfit({ stake, water, settlement, rebateRate = 0.015 }) {
  const principal = Decimal.max(0, decimal(stake));
  const rebate = Decimal.max(0, decimal(rebateRate));
  if (!settlement || !Array.isArray(settlement.legs) || !settlement.legs.length || principal.eq(0)) {
    return { profit: 0, rebate: 0, settledAmount: 0, grossWin: 0, grossLoss: 0, legs: [] };
  }

  const legRows = settlement.legs.map((leg, index) => {
    const allocation = decimal(leg.allocation);
    const legPrincipal = principal.mul(allocation);
    const price = waterForLeg(water, index, leg);
    const winPrincipal = legPrincipal.mul(leg.winShare);
    const lossPrincipal = legPrincipal.mul(leg.lossShare);
    const settledPrincipal = winPrincipal.plus(lossPrincipal);
    const rebateAmount = settledPrincipal.mul(rebate);
    const grossWin = winPrincipal.mul(price);
    const grossLoss = lossPrincipal.neg();
    const profit = grossWin.plus(grossLoss).plus(rebateAmount);
    return {
      ...leg,
      water: number(price),
      principal: number(legPrincipal),
      winPrincipal: number(winPrincipal),
      lossPrincipal: number(lossPrincipal),
      settledPrincipal: number(settledPrincipal),
      rebate: number(rebateAmount),
      grossWin: number(grossWin),
      grossLoss: number(grossLoss),
      profit: number(profit),
    };
  });

  const sum = key => legRows.reduce((total, row) => total.plus(decimal(row[key])), new Decimal(0));
  return {
    profit: number(sum('profit')),
    rebate: number(sum('rebate')),
    settledAmount: number(sum('settledPrincipal')),
    grossWin: number(sum('grossWin')),
    grossLoss: number(sum('grossLoss')),
    legs: legRows,
  };
}

export function profitFromNetFraction({ stake, water, fraction, rebateRate = 0.015 }) {
  const value = decimal(fraction);
  const winShare = Decimal.max(0, value);
  const lossShare = Decimal.max(0, value.neg());
  const pushShare = Decimal.max(0, new Decimal(1).minus(winShare).minus(lossShare));
  return settlementProfit({
    stake,
    water,
    rebateRate,
    settlement: {
      version: SETTLEMENT_RULE_VERSION,
      legs: [{ index: 0, line: null, allocation: 1, fraction: number(value), winShare: number(winShare), lossShare: number(lossShare), pushShare: number(pushShare), exactLine: false }],
    },
  });
}

export function mirrorSettlementAudit(leftPick, rightPick, awayRuns, homeRuns, awayName, homeName) {
  const left = settleTaiwanContract(leftPick, awayRuns, homeRuns, awayName, homeName);
  const right = settleTaiwanContract(rightPick, awayRuns, homeRuns, awayName, homeName);
  if (!left || !right) return { ok: false, error: '盤口無法結算' };
  const netError = decimal(left.netFraction).plus(right.netFraction).abs();
  const winLossError = decimal(left.winFraction).minus(right.lossFraction).abs()
    .plus(decimal(left.lossFraction).minus(right.winFraction).abs());
  const pushError = decimal(left.pushFraction).minus(right.pushFraction).abs();
  return {
    ok: netError.lte('0.000000000001') && winLossError.lte('0.000000000001') && pushError.lte('0.000000000001'),
    netError: number(netError),
    winLossError: number(winLossError),
    pushError: number(pushError),
    left,
    right,
  };
}
