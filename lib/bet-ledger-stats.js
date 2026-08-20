export const BET_LEDGER_STATS_VERSION = 'BET-LEDGER-STATS-2026-08-v1.0.0';

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const normalize = value => String(value || '').trim().toUpperCase();
const OUTCOMES = Object.freeze(['WIN', 'LOSS', 'PUSH', 'HALF_WIN', 'HALF_LOSS', 'MIXED', 'VOID']);

function emptySummary(key = 'ALL') {
  return {
    key,
    tickets: 0,
    settled: 0,
    open: 0,
    manualReview: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    halfWins: 0,
    halfLosses: 0,
    mixed: 0,
    voids: 0,
    totalStake: 0,
    settledStake: 0,
    grossProfit: 0,
    rebate: 0,
    netProfit: 0,
    roi: null,
    effectiveWinRate: null,
  };
}

function outcomeOf(bet) {
  return normalize(bet?.settlement?.outcome || bet?.outcome || '');
}

function add(summary, bet) {
  summary.tickets += 1;
  const status = normalize(bet?.status || 'OPEN');
  const stake = Math.max(0, finite(bet?.stake));
  const settlement = bet?.settlement || {};
  const outcome = outcomeOf(bet);
  const settled = status === 'SETTLED' || OUTCOMES.includes(outcome);
  if (settled) {
    summary.settled += 1;
    summary.settledStake += stake;
    summary.grossProfit += finite(settlement.grossWin) + finite(settlement.grossLoss);
    summary.rebate += finite(settlement.rebate);
    summary.netProfit += finite(settlement.netProfit ?? settlement.profit);
  } else if (status === 'MANUAL_REVIEW') {
    summary.manualReview += 1;
  } else {
    summary.open += 1;
  }
  summary.totalStake += stake;
  if (outcome === 'WIN') summary.wins += 1;
  else if (outcome === 'LOSS') summary.losses += 1;
  else if (outcome === 'PUSH') summary.pushes += 1;
  else if (outcome === 'HALF_WIN') summary.halfWins += 1;
  else if (outcome === 'HALF_LOSS') summary.halfLosses += 1;
  else if (outcome === 'MIXED') summary.mixed += 1;
  else if (outcome === 'VOID') summary.voids += 1;
  return summary;
}

function finish(summary) {
  const denominator = summary.settledStake;
  summary.roi = denominator > 0 ? summary.netProfit / denominator : null;
  const effectiveWins = summary.wins + summary.halfWins * 0.5;
  const effectiveLosses = summary.losses + summary.halfLosses * 0.5;
  const effectiveDenominator = effectiveWins + effectiveLosses;
  summary.effectiveWinRate = effectiveDenominator > 0 ? effectiveWins / effectiveDenominator : null;
  for (const key of ['totalStake', 'settledStake', 'grossProfit', 'rebate', 'netProfit']) {
    summary[key] = Number(summary[key].toFixed(4));
  }
  return summary;
}

function scoreBand(bet) {
  if (normalize(bet?.scoreStatus) !== 'FORMAL') return null;
  const score = finite(bet?.score, NaN);
  if (!Number.isFinite(score)) return null;
  if (score >= 8.5) return '8.5-8.9';
  if (score >= 8.0) return '8.0-8.4';
  if (score >= 7.5) return '7.5-7.9';
  if (score >= 7.2) return '7.2-7.4';
  return null;
}

export function summarizeBetLedger(values = []) {
  const bets = (Array.isArray(values) ? values : []).filter(value => value && typeof value === 'object');
  const overall = emptySummary();
  const grouped = new Map();
  const scoreGroups = new Map();
  for (const bet of bets) {
    add(overall, bet);
    const league = normalize(bet.league || 'MLB');
    const market = String(bet.market || '未分類').trim() || '未分類';
    const key = `${league}|||${market}`;
    if (!grouped.has(key)) grouped.set(key, emptySummary(key));
    add(grouped.get(key), bet);
    const band = scoreBand(bet);
    if (band) {
      if (!scoreGroups.has(band)) scoreGroups.set(band, emptySummary(band));
      add(scoreGroups.get(band), bet);
    }
  }
  return {
    version: BET_LEDGER_STATS_VERSION,
    overall: finish(overall),
    byLeagueMarket: [...grouped.values()].map(finish).sort((left, right) => left.key.localeCompare(right.key)),
    byFormalScoreBand: [...scoreGroups.values()].map(finish).sort((left, right) => left.key.localeCompare(right.key)),
  };
}
