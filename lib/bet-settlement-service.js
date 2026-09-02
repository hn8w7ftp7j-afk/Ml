import { fetchLeagueFinalResult, withLeagueProviderTimeout } from './league-provider.js';
import {
  settleTaiwanContract,
  settlementProfit,
  SETTLEMENT_RULE_VERSION,
  TAIWAN_CREDIT_REBATE_RATE,
} from './taiwan-settlement-v9.js';

export const BET_SETTLEMENT_SERVICE_VERSION = 'BASEBALL-BET-SETTLEMENT-2026-09-v1.1.0';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => String(value || '').trim();

function outcomeFor(settlement) {
  const win = finite(settlement?.winFraction) ?? 0;
  const loss = finite(settlement?.lossFraction) ?? 0;
  const push = finite(settlement?.pushFraction) ?? 0;
  if (win >= 1 - 1e-9) return 'WIN';
  if (loss >= 1 - 1e-9) return 'LOSS';
  if (push >= 1 - 1e-9) return 'PUSH';
  if (win > 0 && loss <= 1e-9) return 'HALF_WIN';
  if (loss > 0 && win <= 1e-9) return 'HALF_LOSS';
  return 'MIXED';
}

function manualReview(bet, result, reason) {
  return {
    ...bet,
    status: 'MANUAL_REVIEW',
    resultSnapshot: {
      ...(result || {}),
      checkedAt: new Date().toISOString(),
      serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
    },
    settlementError: reason,
    updatedAt: new Date().toISOString(),
  };
}

function resultLookup(bet) {
  const league = clean(bet.league).toUpperCase();
  const gamePk = Number(bet.gamePk);
  const officialResultDate = clean(bet.officialDate);
  const resultOptions = {
    ...(officialResultDate ? { date: officialResultDate } : {}),
    expectedAway: clean(bet.away),
    expectedHome: clean(bet.home),
    expectedGameNumber: Number(bet.gameNumber || 1),
    // NPB does not always publish the immutable `s...` detail id before first
    // pitch. Preserve the pregame composite identity so the result provider can
    // bind it to the unique same-date matchup after the official link appears.
    expectedProviderGameId: clean(bet.resultSnapshot?.providerGameId),
  };
  return { league, gamePk, resultOptions };
}

async function fetchBetResult(bet) {
  const { league, gamePk, resultOptions } = resultLookup(bet);
  return withLeagueProviderTimeout(
    league,
    fetchLeagueFinalResult(league, gamePk, resultOptions),
    15_000,
    '正式賽果取得逾時',
  );
}

export function settleBetTicketFromResult(value, result) {
  const bet = value && typeof value === 'object' ? value : null;
  if (!bet || ['SETTLED', 'VOID'].includes(clean(bet.status).toUpperCase())) return bet;

  const resultStatus = `${result?.statusEnglish || ''} ${result?.status || ''}`.toLowerCase();
  if (/cancel|postpon|suspend|forfeit|called|shortened|abandon/.test(resultStatus)) {
    return manualReview(bet, result, '賽事不是正常完賽，依版本化合約規則人工確認，不自動結算或判定void');
  }

  if (result?.final !== true) {
    return {
      ...bet,
      status: 'OPEN',
      resultSnapshot: {
        ...result,
        checkedAt: new Date().toISOString(),
        serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
      },
      lastResultCheckAt: new Date().toISOString(),
    };
  }

  const firstFive = clean(bet.market).includes('上半');
  const awayRuns = finite(firstFive ? result.awayFirst5 : result.awayRuns);
  const homeRuns = finite(firstFive ? result.homeFirst5 : result.homeRuns);
  if (awayRuns == null || homeRuns == null) return manualReview(bet, result, firstFive ? '缺少可驗證的前五局正式賽果' : '缺少可驗證的全場正式賽果');

  const settlement = settleTaiwanContract(
    bet.pick,
    awayRuns,
    homeRuns,
    bet.away || '',
    bet.home || '',
  );
  if (!settlement) return manualReview(bet, result, '下注合約與正式賽果無法進行確定性結算');

  const profit = settlementProfit({
    stake: Math.max(0, finite(bet.stake) ?? 0),
    water: finite(bet.water),
    settlement,
    // This is a server-owned, versioned contract. Ticket payloads must never
    // inflate the rebate or the historical ROI.
    rebateRate: TAIWAN_CREDIT_REBATE_RATE,
  });
  const settledAt = new Date().toISOString();
  return {
    ...bet,
    status: 'SETTLED',
    resultSnapshot: {
      ...result,
      selectedPeriod: firstFive ? 'FIRST5' : 'FULL_GAME',
      selectedAwayRuns: awayRuns,
      selectedHomeRuns: homeRuns,
      checkedAt: settledAt,
      serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
    },
    settlement: {
      outcome: outcomeFor(settlement),
      winFraction: settlement.winFraction,
      lossFraction: settlement.lossFraction,
      pushFraction: settlement.pushFraction,
      legOutcomes: profit.legs,
      grossWin: profit.grossWin,
      grossLoss: profit.grossLoss,
      rebate: profit.rebate,
      netProfit: profit.profit,
      roi: Number(bet.stake) > 0 ? profit.profit / Number(bet.stake) : null,
      settlementRuleVersion: SETTLEMENT_RULE_VERSION,
      serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
      settledAt,
    },
    settlementError: null,
    updatedAt: settledAt,
  };
}

export async function settleBetTicket(value) {
  const bet = value && typeof value === 'object' ? value : null;
  if (!bet || ['SETTLED', 'VOID'].includes(clean(bet.status).toUpperCase())) return bet;
  const { league, gamePk } = resultLookup(bet);
  if (!league || !Number.isSafeInteger(gamePk) || gamePk <= 0) {
    return manualReview(bet, null, '缺少可驗證的聯盟或場次識別');
  }
  try {
    return settleBetTicketFromResult(bet, await fetchBetResult(bet));
  } catch (error) {
    return {
      ...bet,
      lastResultCheckAt: new Date().toISOString(),
      lastResultError: clean(error?.message || error),
    };
  }
}

export async function settleBetTickets(values, { concurrency = 4 } = {}) {
  const bets = Array.isArray(values) ? values : [];
  const groups = new Map();
  const results = new Array(bets.length);
  bets.forEach((bet, index) => {
    const { league, gamePk, resultOptions } = resultLookup(bet || {});
    if (!bet || !league || !Number.isSafeInteger(gamePk) || gamePk <= 0) {
      results[index] = manualReview(bet, null, '缺少可驗證的聯盟或場次識別');
      return;
    }
    const key = `${league}|||${gamePk}|||${resultOptions.date || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ bet, index });
  });

  const grouped = [...groups.values()];
  const width = Math.max(1, Math.min(8, Number(concurrency) || 4));
  for (let offset = 0; offset < grouped.length; offset += width) {
    await Promise.all(grouped.slice(offset, offset + width).map(async group => {
      try {
        const result = await fetchBetResult(group[0].bet);
        for (const { bet, index } of group) results[index] = settleBetTicketFromResult(bet, result);
      } catch (error) {
        const checkedAt = new Date().toISOString();
        for (const { bet, index } of group) {
          results[index] = {
            ...bet,
            lastResultCheckAt: checkedAt,
            lastResultError: clean(error?.message || error),
          };
        }
      }
    }));
  }
  return results.filter(Boolean);
}
