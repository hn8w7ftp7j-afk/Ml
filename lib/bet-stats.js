export const BET_STATS_VERSION = 'BASEBALL-BET-STATS-2026-08-v1.0.0';

export const BET_PERIODS = [
  { id: 'TODAY', label: '今日' },
  { id: 'YESTERDAY', label: '昨日' },
  { id: 'THIS_WEEK', label: '本週' },
  { id: 'LAST_WEEK', label: '上週' },
  { id: 'THIS_MONTH', label: '本月' },
  { id: 'LAST_MONTH', label: '上月' },
  { id: 'ALL', label: '全部' },
];

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clean = value => String(value || '').trim();

function taipeiDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const read = type => Number(parts.find(part => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  return year && month && day ? { year, month, day } : null;
}

function taipeiDayNumber(value) {
  const parts = taipeiDateParts(value);
  return parts ? Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000) : null;
}

function taipeiMonthNumber(value) {
  const parts = taipeiDateParts(value);
  return parts ? parts.year * 12 + parts.month - 1 : null;
}

export function filterBetLedgerByPeriod(values = [], period = 'ALL', now = Date.now()) {
  const bets = Array.isArray(values) ? values : [];
  const selected = clean(period).toUpperCase() || 'ALL';
  if (selected === 'ALL') return bets;
  const today = taipeiDayNumber(now);
  const month = taipeiMonthNumber(now);
  if (today == null || month == null) return [];
  const weekday = new Date(today * 86400000).getUTCDay();
  const thisMonday = today - ((weekday + 6) % 7);
  return bets.filter(bet => {
    const placedDay = taipeiDayNumber(bet?.placedAt);
    const placedMonth = taipeiMonthNumber(bet?.placedAt);
    if (placedDay == null || placedMonth == null) return false;
    if (selected === 'TODAY') return placedDay === today;
    if (selected === 'YESTERDAY') return placedDay === today - 1;
    if (selected === 'THIS_WEEK') return placedDay >= thisMonday && placedDay < thisMonday + 7;
    if (selected === 'LAST_WEEK') return placedDay >= thisMonday - 7 && placedDay < thisMonday;
    if (selected === 'THIS_MONTH') return placedMonth === month;
    if (selected === 'LAST_MONTH') return placedMonth === month - 1;
    return true;
  });
}

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
