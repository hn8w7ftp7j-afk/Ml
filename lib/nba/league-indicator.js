export function nbaLeagueIndicator(date, job, batch, running = false) {
  if (running) return { status: 'running', label: '分析中' };
  if (job?.date === date) {
    if (['starting', 'running'].includes(job.status)) return { status: 'running', label: '分析中' };
    if (job.status === 'completed') return { status: 'done', label: '已完成' };
    if (job.status === 'failed') return { status: 'failed', label: '失敗，可重試' };
  }
  const status = batch?.boardDate === date ? batch.status : 'idle';
  const labels = { preparing: '準備中', queued: '排隊中', running: '分析中', done: '已完成', partial: '部分完成', failed: '失敗，可重試', no_games: '今日無賽事', no_open_markets: '等待開盤', result_pending: '結果待載入' };
  return { status: labels[status] ? status : 'idle', label: labels[status] || '' };
}
