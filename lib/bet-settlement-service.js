import { fetchLeagueFinalResult, withLeagueProviderTimeout } from './league-provider.js';
import {
  settleTaiwanContract,
  settlementProfit,
  SETTLEMENT_RULE_VERSION,
  TAIWAN_CREDIT_REBATE_RATE,
} from './taiwan-settlement-v9.js';

export const BET_SETTLEMENT_SERVICE_VERSION = 'BASEBALL-BET-SETTLEMENT-2026-09-v1.1.2';

// An absent official score is not a zero. Number(null) and Number('') would
// otherwise fabricate a 0-0 result and permanently settle an incomplete feed.
const finite = value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value))
  ? Number(value)
  : null;
const clean = value => String(value || '').trim();

// Missing official scores are retryable evidence gaps. Other manual-review
// reasons (identity, contract, cancellation, suspension) remain isolated.
export function isRetryableResultGap(bet) {
  return clean(bet?.status).toUpperCase() === 'MANUAL_REVIEW'
    && ['缺少可驗證的前五局正式賽果', '缺少可驗證的全場正式賽果'].includes(clean(bet?.settlementError))
    && !bet?.settlement
    && bet?.resultSnapshot?.final === true;
}

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
  const checkedAt = new Date().toISOString();
  return {
    ...bet,
    status: 'MANUAL_REVIEW',
    resultSnapshot: {
      ...(result || {}),
      checkedAt,
      serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
    },
    settlementError: reason,
    lastResultCheckAt: checkedAt,
    lastResultError: null,
    updatedAt: checkedAt,
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

async function fetchBetResult(bet, { timeoutMs = 15_000 } = {}) {
  const { league, gamePk, resultOptions } = resultLookup(bet);
  return withLeagueProviderTimeout(
    league,
    fetchLeagueFinalResult(league, gamePk, resultOptions),
    timeoutMs,
    '正式賽果取得逾時',
  );
}

export function settleBetTicketFromResult(value, result) {
  const bet = value && typeof value === 'object' ? value : null;
  if (!bet || ['SETTLED', 'VOID', 'CANCELLED'].includes(clean(bet.status).toUpperCase())) return bet;

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
      lastResultError: null,
    };
  }

  const firstFive = clean(bet.market).includes('上半');
  if (firstFive && result.first5Complete !== true) {
    return manualReview(bet, result, '缺少可驗證的前五局正式賽果');
  }
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
    lastResultError: null,
    lastResultCheckAt: settledAt,
    updatedAt: settledAt,
  };
}

export async function settleBetTicket(value) {
  const bet = value && typeof value === 'object' ? value : null;
  if (!bet || ['SETTLED', 'VOID', 'CANCELLED'].includes(clean(bet.status).toUpperCase())) return bet;
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

export async function settleBetTickets(values, {
  concurrency = 4,
  timeBudgetMs = Infinity,
  now = () => Date.now(),
  fetchResult = fetchBetResult,
  onGroupSettled = async () => {},
} = {}) {
  const bets = Array.isArray(values) ? values : [];
  const groups = new Map();
  const results = new Array(bets.length);
  const budget = Number.isFinite(Number(timeBudgetMs)) ? Math.max(0, Number(timeBudgetMs)) : Infinity;
  const deadline = now() + budget;
  // Leave time to persist the last completed result before the request budget.
  const persistenceReserve = Number.isFinite(budget) ? Math.min(1_000, budget / 10) : 0;
  bets.forEach((bet, index) => {
    if (bet && ['SETTLED', 'VOID', 'CANCELLED'].includes(clean(bet.status).toUpperCase())) {
      results[index] = bet;
      return;
    }
    const { league, gamePk, resultOptions } = resultLookup(bet || {});
    if (!bet || !league || !Number.isSafeInteger(gamePk) || gamePk <= 0) {
      groups.set(`invalid:${index}`, [{ bet, index, invalid: true }]);
      return;
    }
    const key = `${league}|||${gamePk}|||${resultOptions.date || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ bet, index });
  });

  const grouped = [...groups.values()];
  const width = Math.max(1, Math.min(8, Number(concurrency) || 4));
  let cursor = 0;
  let persistenceError;
  const worker = async () => {
    while (cursor < grouped.length && !persistenceError) {
      const remaining = deadline - now() - persistenceReserve;
      if (remaining <= 0) return;
      const group = grouped[cursor++];
      let updates;
      try {
        if (group[0].invalid) {
          updates = [manualReview(group[0].bet, null, '缺少可驗證的聯盟或場次識別')];
        } else {
          const timeoutMs = Math.max(1, Math.min(15_000, remaining));
          const result = await fetchResult(group[0].bet, { timeoutMs });
          updates = group.map(({ bet }) => settleBetTicketFromResult(bet, result));
        }
      } catch (error) {
        const checkedAt = new Date().toISOString();
        updates = group.map(({ bet }) => ({
            ...bet,
            lastResultCheckAt: checkedAt,
            lastResultError: clean(error?.message || error),
        }));
      }
      try {
        // A later provider stall must not discard already verified results.
        // Await this game's durable write before starting more provider work.
        await onGroupSettled(updates, group.map(({ bet }) => bet));
        group.forEach(({ index }, groupIndex) => { results[index] = updates[groupIndex]; });
      } catch (error) {
        persistenceError ||= error;
      }
    }
  };
  // Drain in-flight writes before reporting a DB failure; no writes continue
  // in the background after the request has returned an error.
  await Promise.all(Array.from({ length: Math.min(width, grouped.length) }, () => worker()));
  if (persistenceError) throw persistenceError;
  return results.filter(Boolean);
}
