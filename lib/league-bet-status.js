import { betDisplayMatches } from './bet-ledger.js';

// Callers supply their existing candidate list; this summary never changes
// model scores, qualification thresholds, or permission to record a bet.
export function summarizeHighScoreBets(candidates, { isRecorded, ledgerReady = false, analysisReady = true } = {}) {
  if (!analysisReady) return { state: 'analysis_pending', label: '高分狀態待確認', total: null, recorded: null, unbet: null };
  const unique = [...new Map((Array.isArray(candidates) ? candidates : []).map((entry, index) => [
    entry.stableKey || String(index), entry,
  ])).values()];
  const total = unique.length;
  if (!total) return { state: 'none', label: '', total: 0, recorded: 0, unbet: 0 };
  if (!ledgerReady) return { state: 'pending', label: '下注狀態待同步', total, recorded: null, unbet: null };
  const recorded = unique.filter(entry => isRecorded?.(entry) === true).length;
  const unbet = total - recorded;
  return { state: unbet ? 'unbet' : 'all_bet', label: unbet ? '有高分未下注' : '高分已全下注', total, recorded, unbet };
}

export function summarizeBaseballHighScoreBets(candidates, { bets = [], league, date, ledgerReady = false, analysisReady = true } = {}) {
  return summarizeHighScoreBets(candidates, {
    ledgerReady, analysisReady,
    isRecorded: entry => bets.some(bet => bet.status !== 'CANCELLED'
      && betDisplayMatches(bet, date, entry.item.game.gamePk, entry.row, league)),
  });
}

// A newer unfinished run must not inherit the previous board's all-bet label.
export function leagueAnalysisReminderReady(independent, batch, batchStartedAt) {
  const independentAt = Date.parse(independent?.startedAt || '') || 0;
  const batchAt = Date.parse(batchStartedAt || '') || 0;
  if (independent && (!batch || independentAt >= batchAt)) {
    if (['preparing', 'running', 'failed'].includes(independent.status)) return false;
    return independent.resultLoaded !== false && (independent.needsRecovery !== true || independent.resultLoaded === true);
  }
  if (!batch) return true;
  return !['preparing', 'queued', 'running', 'result_pending', 'failed'].includes(batch.status)
    && batch.resultLoaded !== false;
}
