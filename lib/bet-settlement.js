import { fetchLeagueFinalResult, withLeagueProviderTimeout } from './league-provider.js';
import { settleTaiwanContract, settlementProfit, SETTLEMENT_RULE_VERSION } from './taiwan-settlement-v9.js';

export const BET_SETTLEMENT_SERVICE_VERSION = 'BET-SETTLEMENT-SERVICE-2026-08-v1.0.0';

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();
const normalizeLeague = value => clean(value || 'MLB').toUpperCase();

function outcomeFromSettlement(settlement) {
  const win = finite(settlement?.winFraction, 0);
  const loss = finite(settlement?.lossFraction, 0);
  const push = finite(settlement?.pushFraction, 0);
  const epsilon = 1e-9;
  if (win >= 1 - epsilon && loss <= epsilon) return 'WIN';
  if (loss >= 1 - epsilon && win <= epsilon) return 'LOSS';
  if (push >= 1 - epsilon) return 'PUSH';
  if (win > epsilon && push > epsilon && loss <= epsilon) return 'HALF_WIN';
  if (loss > epsilon && push > epsilon && win <= epsilon) return 'HALF_LOSS';
  if (win > epsilon && loss > epsilon) return 'MIXED';
  return 'MANUAL_REVIEW';
}

function periodScore(bet, result) {
  const firstFive = clean(bet?.market).includes('上半');
  return firstFive
    ? { awayRuns: finite(result?.awayFirst5), homeRuns: finite(result?.homeFirst5), period: 'FIRST5' }
    : { awayRuns: finite(result?.awayRuns), homeRuns: finite(result?.homeRuns), period: 'FULL' };
}

export function settleBetFromOfficialResult(bet, result, now = new Date().toISOString()) {
  if (!bet || typeof bet !== 'object') return bet;
  if (!result?.final) {
    return {
      ...bet,
      status: clean(bet.status || 'OPEN').toUpperCase() === 'SETTLED' ? 'SETTLED' : 'OPEN',
      resultStatus: result?.status || result?.statusEnglish || 'PENDING',
      resultCheckedAt: now,
    };
  }
  const period = periodScore(bet, result);
  if (period.awayRuns == null || period.homeRuns == null) {
    return {
      ...bet,
      status: 'MANUAL_REVIEW',
      resultStatus: 'FINAL_BUT_PERIOD_SCORE_MISSING',
      resultCheckedAt: now,
      lastSettlementError: `${period.period}賽果缺失`,
    };
  }
  const awayName = clean(bet.away || bet.awayTeam || '');
  const homeName = clean(bet.home || bet.homeTeam || '');
  const settled = settleTaiwanContract(bet.pick, period.awayRuns, period.homeRuns, awayName, homeName);
  if (!settled) {
    return {
      ...bet,
      status: 'MANUAL_REVIEW',
      resultStatus: 'FINAL_CONTRACT_UNSETTLED',
      resultCheckedAt: now,
      lastSettlementError: '下注合約與正式賽果無法可靠結算',
      resultSnapshot: { ...result, period: period.period, periodAwayRuns: period.awayRuns, periodHomeRuns: period.homeRuns },
    };
  }
  const money = settlementProfit({
    stake: Math.max(0, finite(bet.stake, 0)),
    water: finite(bet.water, 0),
    settlement: settled,
    rebateRate: Math.max(0, finite(bet.rebateRate, 0.015)),
  });
  const outcome = outcomeFromSettlement(settled);
  if (outcome === 'MANUAL_REVIEW') {
    return {
      ...bet,
      status: 'MANUAL_REVIEW',
      resultStatus: 'FINAL_COMPLEX_OUTCOME',
      resultCheckedAt: now,
      resultSnapshot: { ...result, period: period.period, periodAwayRuns: period.awayRuns, periodHomeRuns: period.homeRuns },
      lastSettlementError: '結算結果需要人工覆核',
    };
  }
  return {
    ...bet,
    status: 'SETTLED',
    resultStatus: 'FINAL',
    resultCheckedAt: now,
    settledAt: now,
    resultSnapshot: {
      ...result,
      period: period.period,
      periodAwayRuns: period.awayRuns,
      periodHomeRuns: period.homeRuns,
    },
    settlement: {
      serviceVersion: BET_SETTLEMENT_SERVICE_VERSION,
      ruleVersion: SETTLEMENT_RULE_VERSION,
      outcome,
      winFraction: settled.winFraction,
      lossFraction: settled.lossFraction,
      pushFraction: settled.pushFraction,
      legOutcomes: settled.legs,
      grossWin: money.grossWin,
      grossLoss: money.grossLoss,
      rebate: money.rebate,
      netProfit: money.profit,
      settledAmount: money.settledAmount,
      roi: finite(bet.stake, 0) > 0 ? money.profit / finite(bet.stake, 1) : null,
    },
    lastSettlementError: null,
  };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

export async function settleOpenBets(values, { league = null, limit = 200 } = {}) {
  const bets = (Array.isArray(values) ? values : []).map(value => ({ ...value }));
  const targetLeague = league ? normalizeLeague(league) : null;
  const candidates = bets.filter(bet => {
    const status = clean(bet?.status || 'OPEN').toUpperCase();
    return status !== 'SETTLED'
      && status !== 'VOID'
      && (!targetLeague || normalizeLeague(bet.league) === targetLeague)
      && Number.isSafeInteger(Number(bet.gamePk))
      && Number(bet.gamePk) > 0;
  }).slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)));

  const groups = new Map();
  for (const bet of candidates) {
    const key = `${normalizeLeague(bet.league)}|||${Number(bet.gamePk)}|||${clean(bet.date)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bet);
  }
  const updates = new Map();
  await runPool([...groups.values()], 3, async group => {
    const sample = group[0];
    const checkedAt = new Date().toISOString();
    try {
      const result = await withLeagueProviderTimeout(
        sample.league,
        fetchLeagueFinalResult(sample.league, Number(sample.gamePk), { date: sample.date }),
        15000,
        '正式賽果取得逾時',
      );
      for (const bet of group) updates.set(bet.id, settleBetFromOfficialResult(bet, result, checkedAt));
    } catch (error) {
      for (const bet of group) updates.set(bet.id, {
        ...bet,
        resultCheckedAt: checkedAt,
        lastSettlementError: clean(error?.message || error || '正式賽果取得失敗'),
      });
    }
  });
  return bets.map(bet => updates.get(bet.id) || bet);
}
