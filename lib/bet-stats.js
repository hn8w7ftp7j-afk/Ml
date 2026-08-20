export const BET_STATS_VERSION = 'BASEBALL-BET-STATS-2026-08-v1.0.0';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();

function emptySummary(key = 'ALL') {
  return {
    key,
    bets: 0,
    open: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    halfWins: 0,
    halfLosses: 0,
    voids: 0,
    manualReview: 0,
    totalStake: 0,
    grossPnl: 0,
    rebate: 0,
    netPnl: 0,
    effectiveWinStake: 0,
    effectiveLossStake: 0,
    winRate: null,
    roi: null,
  };
}

function addBet(summary, bet) {
  summary.bets += 1;
  const status = clean(bet?.status).toUpperCase();
  const outcome = clean(bet?.settlement?.outcome).toUpperCase();
  if (status === 'SETTLED') summary.settled += 1;
  else if (status === 'VOID') summary.voids += 1;
  else if (status === 'MANUAL_REVIEW') summary.manualReview += 1;
  else summary.open += 1;

  if (outcome === 'WIN') summary.wins += 1;
  else if (outcome === 'LOSS') summary.losses += 1;
  else if (outcome === 'PUSH') summary.pushes += 1;
  else if (outcome === 'HALF_WIN') summary.halfWins += 1;
  else if (outcome === 'HALF_LOSS') summary.halfLosses += 1;
  else if (outcome === 'VOID') summary.voids += 1;

  if (status !== 'SETTLED') return;
  const stake = Math.max(0, finite(bet?.stake));
  const settlement = bet?.settlement || {};
  const winFraction = Math.max(0, finite(settlement.winFraction));
  const lossFraction = Math.max(0, finite(settlement.lossFraction));
  summary.totalStake += stake;
  summary.grossPnl += finite(settlement.grossWin) + finite(settlement.grossLoss);
  summary.rebate += finite(settlement.rebate);
  summary.netPnl += finite(settlement.netProfit);
  summary.effectiveWinStake += stake * winFraction;
  summary.effectiveLossStake += stake * lossFraction;
}

function finalize(summary) {
  const decided = summary.effectiveWinStake + summary.effectiveLossStake;
  summary.winRate = decided > 0 ? summary.effectiveWinStake / decided : null;
  summary.roi = summary.totalStake > 0 ? summary.netPnl / summary.totalStake : null;
  for (const key of ['totalStake', 'grossPnl', 'rebate', 'netPnl', 'effectiveWinStake', 'effectiveLossStake']) {
    summary[key] = Math.round(summary[key] * 10000) / 10000;
  }
  return summary;
}

export function summarizeBetLedger(values = []) {
  const bets = Array.isArray(values) ? values : [];
  const overall = emptySummary('ALL');
  const groups = new Map();
  for (const bet of bets) {
    addBet(overall, bet);
    const league = clean(bet?.league).toUpperCase() || 'UNKNOWN';
    const market = clean(bet?.market) || '未分類';
    const key = `${league}|||${market}`;
    if (!groups.has(key)) groups.set(key, emptySummary(key));
    addBet(groups.get(key), bet);
  }
  return {
    version: BET_STATS_VERSION,
    overall: finalize(overall),
    groups: [...groups.values()].map(finalize).sort((left, right) => left.key.localeCompare(right.key, 'zh-Hant')),
  };
}
