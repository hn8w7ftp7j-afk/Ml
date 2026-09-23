import { materializeAllLeagueResult } from './all-league-result-board.js';

export function createAnalysisJobProgress(batch, results, runningGamePks = []) {
  return {
    league: batch.league, date: batch.date,
    total: batch.tasks.length,
    gamePks: batch.tasks.map(task => Number(task.game.gamePk)),
    completed: results.filter(row => row.ok === true).length,
    failed: results.filter(row => row.ok !== true).length,
    results, runningGamePks,
    // Every publication is monotonic, including the transition to the next group.
    revision: results.length * 2 + (runningGamePks.length ? 1 : 0),
  };
}

export function applyAnalysisJobProgress(progress, previous, scope, compact = value => value) {
  if (progress?.league !== scope.league || progress?.date !== scope.date) throw new Error('進度聯盟或日期不符');
  const pks = progress.gamePks;
  const rows = progress.results;
  if (!Array.isArray(pks) || pks.length !== progress.total || new Set(pks).size !== pks.length
    || !pks.every(pk => Number.isSafeInteger(pk) && pk > 0)
    || !Array.isArray(rows) || rows.length > pks.length
    || !rows.every(row => pks.includes(Number(row?.task?.game?.gamePk)))) throw new Error('進度場次不完整');
  if (scope.gamePks?.length && (scope.gamePks.length !== pks.length || !pks.every(pk => scope.gamePks.includes(pk)))) throw new Error('進度工作場次不符');
  const settled = new Set(rows.map(row => Number(row.task.game.gamePk)));
  const running = new Set(progress.runningGamePks || []);
  if ([...running].some(pk => !pks.includes(pk) || settled.has(pk))) throw new Error('進度狀態衝突');
  // Partial results are display-only. Existing final Reader/PIT validation still
  // controls execution; a progress update never grants a live price receipt.
  const board = materializeAllLeagueResult({ ...progress, total: rows.length }, previous, compact).map(item => {
    const pk = Number(item.game.gamePk);
    if (!pks.includes(pk) || settled.has(pk)) return item;
    return { ...item, readerPayloadHash: null, pendingReaderAnalysis: true,
      status: running.has(pk) ? 'running' : 'queued',
      statusLabel: running.has(pk) ? '伺服器正在分析此場' : '排隊中｜前面場次完成後接續分析' };
  });
  const completed = rows.filter(row => row.ok === true).length;
  const failed = rows.length - completed;
  return { board, completed, failed, settled: rows.length, running: running.size,
    queued: pks.length - rows.length - running.size, total: pks.length };
}
