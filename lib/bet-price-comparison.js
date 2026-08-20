import { canonicalBetPick, canonicalBetPosition } from './bet-ledger.js';
import { parseTaiwanContract, settleTaiwanContract, settlementProfit } from './taiwan-settlement-v9.js';

export const BET_PRICE_COMPARISON_VERSION = 'TW-BET-PRICE-COMPARISON-2026-08-v1.0.0';

const EPSILON = 1e-9;
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value || '').replace(/\s+/g, '').trim();

function compareNumber(left, right) {
  const delta = Number(left) - Number(right);
  if (Math.abs(delta) <= EPSILON) return 'EQUIVALENT';
  return delta > 0 ? 'BETTER' : 'WORSE';
}

function statusFromDeltas(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return 'UNKNOWN';
  const positive = finiteValues.some(value => value > EPSILON);
  const negative = finiteValues.some(value => value < -EPSILON);
  if (!positive && !negative) return 'EQUIVALENT';
  if (positive && !negative) return 'BETTER';
  if (!positive && negative) return 'WORSE';
  return 'MIXED';
}

function statusLabel(status, prefix = '') {
  const label = status === 'BETTER' ? '優'
    : status === 'WORSE' ? '劣'
      : status === 'EQUIVALENT' ? '平'
        : status === 'MIXED' ? '混合' : '無法比較';
  return prefix && ['BETTER', 'WORSE', 'EQUIVALENT'].includes(status) ? `${prefix}${label}` : label;
}

function scoreLimit(market, placedContract, currentContract) {
  const firstFive = clean(market).includes('上半');
  const largestLine = Math.max(
    0,
    ...(placedContract?.legs || []).map(Number).filter(Number.isFinite),
    ...(currentContract?.legs || []).map(Number).filter(Number.isFinite),
  );
  return Math.max(firstFive ? 10 : 16, Math.ceil(largestLine + 7));
}

function comparisonRows({ market, placedPick, currentPick, placedWater, currentWater, awayName, homeName, rebateRate }) {
  const placedContract = parseTaiwanContract(placedPick);
  const currentContract = parseTaiwanContract(currentPick);
  const limit = scoreLimit(market, placedContract, currentContract);
  const rows = [];
  for (let awayRuns = 0; awayRuns <= limit; awayRuns += 1) {
    for (let homeRuns = 0; homeRuns <= limit; homeRuns += 1) {
      const placedSettlement = settleTaiwanContract(placedContract, awayRuns, homeRuns, awayName, homeName);
      const currentSettlement = settleTaiwanContract(currentContract, awayRuns, homeRuns, awayName, homeName);
      if (!placedSettlement || !currentSettlement) continue;
      const placedLineProfit = settlementProfit({ stake: 1, water: 1, settlement: placedSettlement, rebateRate: 0 }).profit;
      const currentLineProfit = settlementProfit({ stake: 1, water: 1, settlement: currentSettlement, rebateRate: 0 }).profit;
      const placedFullProfit = settlementProfit({ stake: 1, water: placedWater, settlement: placedSettlement, rebateRate }).profit;
      const currentFullProfit = settlementProfit({ stake: 1, water: currentWater, settlement: currentSettlement, rebateRate }).profit;
      rows.push({
        awayRuns,
        homeRuns,
        totalRuns: awayRuns + homeRuns,
        lineDelta: placedLineProfit - currentLineProfit,
        fullDelta: placedFullProfit - currentFullProfit,
      });
    }
  }
  return rows;
}

function keyDifference(rows, isTotal) {
  const candidates = rows.filter(row => Math.abs(row.lineDelta) > EPSILON);
  if (!candidates.length) return null;
  const selected = candidates.sort((left, right) => Math.abs(right.lineDelta) - Math.abs(left.lineDelta))[0];
  const delta = selected.lineDelta;
  return {
    awayRuns: selected.awayRuns,
    homeRuns: selected.homeRuns,
    totalRuns: selected.totalRuns,
    delta,
    text: isTotal
      ? `${selected.totalRuns}分結果：${delta > 0 ? '少輸／多贏' : '多輸／少贏'}${Math.abs(delta).toFixed(2)}u`
      : `比分${selected.awayRuns}-${selected.homeRuns}：${delta > 0 ? '少輸／多贏' : '多輸／少贏'}${Math.abs(delta).toFixed(2)}u`,
  };
}

export function sameBetPrice(bet, row) {
  const placedWater = finite(bet?.water);
  const currentWater = finite(row?.water);
  return canonicalBetPick(bet?.pick) === canonicalBetPick(row?.pick)
    && placedWater != null
    && currentWater != null
    && Math.abs(placedWater - currentWater) <= EPSILON;
}

export function compareBetPrice({ bet, row, game, rebateRate = 0.015 } = {}) {
  const placedPick = clean(bet?.pick);
  const currentPick = clean(row?.pick);
  const placedWater = finite(bet?.water);
  const currentWater = finite(row?.water);
  const placedContract = parseTaiwanContract(placedPick);
  const currentContract = parseTaiwanContract(currentPick);
  const samePosition = canonicalBetPosition(placedPick) === canonicalBetPosition(currentPick);
  if (!placedContract.valid || !currentContract.valid || !samePosition || placedWater == null || currentWater == null) {
    return {
      version: BET_PRICE_COMPARISON_VERSION,
      comparable: false,
      exact: false,
      lineStatus: 'UNKNOWN',
      waterStatus: 'UNKNOWN',
      combinedStatus: 'UNKNOWN',
      label: '無法比較',
      reason: '場次方向、盤口或水位資料不足',
    };
  }

  const exactContract = canonicalBetPick(placedPick) === canonicalBetPick(currentPick);
  const exactWater = Math.abs(placedWater - currentWater) <= EPSILON;
  if (exactContract && exactWater) {
    return {
      version: BET_PRICE_COMPARISON_VERSION,
      comparable: true,
      exact: true,
      lineStatus: 'EQUIVALENT',
      waterStatus: 'EQUIVALENT',
      combinedStatus: 'EQUIVALENT',
      label: '相同',
      lineLabel: '盤平',
      waterLabel: '水平',
      keyDifference: null,
    };
  }

  const rows = comparisonRows({
    market: bet?.market || row?.market,
    placedPick,
    currentPick,
    placedWater,
    currentWater,
    awayName: bet?.away || game?.away || '',
    homeName: bet?.home || game?.home || '',
    rebateRate: finite(bet?.rebateRate) ?? finite(rebateRate) ?? 0.015,
  });
  if (!rows.length) {
    return {
      version: BET_PRICE_COMPARISON_VERSION,
      comparable: false,
      exact: false,
      lineStatus: 'UNKNOWN',
      waterStatus: 'UNKNOWN',
      combinedStatus: 'UNKNOWN',
      label: '無法比較',
      reason: '無法建立同方向逐比分結算向量',
    };
  }

  const lineStatus = statusFromDeltas(rows.map(item => item.lineDelta));
  const waterStatus = compareNumber(placedWater, currentWater);
  const payoffStatus = statusFromDeltas(rows.map(item => item.fullDelta));
  const combinedStatus = payoffStatus === 'UNKNOWN' ? 'MIXED' : payoffStatus;
  const isTotal = placedContract.isTotal === true;
  const difference = keyDifference(rows, isTotal);

  return {
    version: BET_PRICE_COMPARISON_VERSION,
    comparable: true,
    exact: false,
    lineStatus,
    waterStatus,
    payoffStatus,
    combinedStatus,
    label: statusLabel(combinedStatus),
    lineLabel: statusLabel(lineStatus, '盤'),
    waterLabel: statusLabel(waterStatus, '水'),
    keyDifference: difference,
    placed: { pick: placedPick, water: placedWater },
    current: { pick: currentPick, water: currentWater },
  };
}
