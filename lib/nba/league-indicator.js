import { parseCreditLine } from './analysis-core/credit-total.js';
import { validDate } from './identity.js';

const coverageVersion = 'nba-opening-market-coverage-v1';
const openingMarkets = { fullTotal: 'fullTotal', fullRunline: 'fullMargin', firstHalfTotal: 'halfTotal', firstHalfRunline: 'halfMargin' };
const validQuote = (quote, market) => {
  const total = market.endsWith('Total');
  return !!quote && !!parseCreditLine(String(quote.line), total ? 'total' : 'spread')
    && (total || ['home', 'away'].includes(quote.lineSide))
    && (total ? [quote.overWater, quote.underWater] : [quote.homeWater, quote.awayWater])
      .every(value => Number.isFinite(value) && value > 0 && value <= 3);
};

// Coverage describes completed, recovered opening-market results, not the
// workflow's success count and not a new scoring/validation authority.
export function nbaOpeningMarketCoverage(rows, date, job) {
  if (!validDate(date) || job?.date !== date || job.status !== 'completed' || typeof job.runId !== 'string' || !job.runId) return null;
  const counts = { games: 0, quoted: 0, ready: 0, validationFailed: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const result = row?.result;
    if (row?.resultRunId !== job.runId || row?.game?.league !== 'NBA' || result?.league !== 'NBA'
      || result.date !== date || result.gameId !== row.game.id || result.modelVersion !== 'nba-regular-cross-season-v1'
      || !result.openingAnalysis) continue;
    counts.games++;
    for (const [key, variable] of Object.entries(openingMarkets)) {
      const quote = result.quotes?.[key], market = result.marketAnalyses?.[key], diagnostic = market?.validationDiagnostics;
      if (!quote) continue;
      counts.quoted++;
      if (!validQuote(quote, key)) continue;
      if (market?.status === 'ready') counts.ready++;
      else if (market?.status === 'insufficient' && diagnostic?.version === 'nba-opening-validation-diagnostics-v1'
        && diagnostic.league === 'NBA' && diagnostic.market === key && diagnostic.variable === variable
        && diagnostic.modelVersion === result.modelVersion && diagnostic.status === 'FAIL' && diagnostic.accepted === false) counts.validationFailed++;
    }
  }
  return { version: coverageVersion, date, runId: job.runId, startedAt: job.startedAt || null, ...counts };
}

export function nbaLeagueIndicator(date, job, batch, running = false, board = null) {
  const boardCurrent = board?.date === date;
  const hasResults = boardCurrent && board.analysisGameCount > 0;
  const labels = { preparing: '準備中', queued: '排隊中', running: '分析中', done: '分析完成', partial: '部分分析完成', failed: '分析失敗，可重試', no_games: '今日無賽事', no_open_markets: '等待開盤', result_pending: '結果待確認', insufficient_data: '資料不足' };
  const display = (outcome, source = null) => {
    let status = outcome?.status === 'done' && !(outcome.total > 0 && outcome.ready === outcome.total)
      ? 'result_pending' : outcome?.status;
    const terminal = ['done', 'partial', 'insufficient_data', 'failed'].includes(status);
    let label = terminal && outcome?.reference > 0 && outcome.reference === outcome.total ? '跨季基準，待校正'
      : terminal && outcome?.verificationBlocked > 0 && outcome.verificationBlocked === outcome.total ? '核對未通過'
      : labels[status];
    const coverage = boardCurrent ? board.openingMarketCoverage : null;
    const scopedCoverage = coverage?.version === coverageVersion && coverage.date === date && coverage.runId
      && coverage.runId === source?.runId && (!coverage.startedAt || !source.startedAt || coverage.startedAt === source.startedAt)
      && ['games', 'quoted', 'ready', 'validationFailed'].every(key => Number.isInteger(coverage[key]) && coverage[key] >= 0)
      && coverage.games > 0 && coverage.quoted > 0 && coverage.validationFailed > 0 && coverage.ready + coverage.validationFailed <= coverage.quoted;
    let marketLabel = false;
    if (scopedCoverage && ['done', 'partial', 'insufficient_data'].includes(status)) {
      if (coverage.ready > 0 || outcome.ready > 0) { status = 'partial'; label = '部分市場已分析'; marketLabel = true; }
      else if (coverage.validationFailed === coverage.quoted) { status = 'insufficient_data'; label = '市場驗證未通過'; marketLabel = true; }
    }
    if (status === 'no_open_markets' && boardCurrent && board.readerStatus === 'stale') label = '盤口待更新';
    if ((hasResults && ['done', 'partial'].includes(status) || marketLabel) && board.readerStatus !== 'fresh') label += '｜盤口待更新';
    return { status: label ? status : 'idle', label: label || '' };
  };
  const currentBatch = batch?.boardDate === date && batch.status !== 'idle';
  const currentJob = job?.date === date;
  const jobTime = Date.parse(job?.startedAt || '');
  const batchTime = Date.parse(batch?.startedAt || '');
  // A new all-league preflight has no run id yet. Its timestamp still fences
  // yesterday's/same-day previous completion, including after reload.
  const newerBatch = currentBatch && (!currentJob || batch.runId !== job.runId
    && (!(jobTime > batchTime) || !Number.isFinite(batchTime)));
  if (newerBatch) {
    // An empty quote preflight does not erase model results still shown below.
    // Only recovered, scoped results can keep the older completion visible.
    if (batch.status === 'no_open_markets' && hasResults && currentJob && job.status === 'completed'
      && job.outcome?.ready > 0 && ['done', 'partial'].includes(job.outcome.status)) return display(job.outcome, job);
    return display(batch, batch);
  }
  if (running && (!job || currentJob)) return display({ status: 'running' });
  if (currentJob) {
    if (['starting', 'running'].includes(job.status)) return { status: 'running', label: '分析中' };
    // Old local-storage handles only prove that a workflow ended. The polling
    // path must recover and validate its results before a green badge returns.
    if (job.status === 'completed') return display(job.outcome || { status: 'result_pending' }, job);
    if (job.status === 'failed') return display({ status: 'failed' });
  }
  return display(currentBatch ? batch : boardCurrent && board.readerStatus === 'stale' ? { status: 'no_open_markets' } : null, currentBatch ? batch : null);
}
