export function nbaLeagueIndicator(date, job, batch, running = false) {
  const labels = { preparing: '準備中', queued: '排隊中', running: '分析中', done: '分析完成', partial: '部分分析完成', failed: '分析失敗，可重試', no_games: '今日無賽事', no_open_markets: '等待開盤', result_pending: '結果待確認', insufficient_data: '資料不足' };
  const display = outcome => {
    const status = outcome?.status === 'done' && !(outcome.total > 0 && outcome.ready === outcome.total)
      ? 'result_pending' : outcome?.status;
    const terminal = ['done', 'partial', 'insufficient_data', 'failed'].includes(status);
    const label = terminal && outcome?.reference > 0 && outcome.reference === outcome.total ? '跨季基準，待校正'
      : terminal && outcome?.verificationBlocked > 0 && outcome.verificationBlocked === outcome.total ? '核對未通過'
      : labels[status];
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
  if (newerBatch) return display(batch);
  if (running && (!job || currentJob)) return display({ status: 'running' });
  if (currentJob) {
    if (['starting', 'running'].includes(job.status)) return { status: 'running', label: '分析中' };
    // Old local-storage handles only prove that a workflow ended. The polling
    // path must recover and validate its results before a green badge returns.
    if (job.status === 'completed') return display(job.outcome || { status: 'result_pending' });
    if (job.status === 'failed') return display({ status: 'failed' });
  }
  return display(currentBatch ? batch : null);
}
