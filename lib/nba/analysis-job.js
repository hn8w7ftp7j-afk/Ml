import { validNbaAnalysisQuery } from './analysis-service.js';
import { loadNbaAnalysis } from './analysis-service.js';
import { loadNbaAnalysisBoard } from './analysis-board.js';

export function normalizeNbaAnalysisTasks(tasks, date) {
  return tasks.map(task => {
    const query = task?.nbaQuery;
    if (!validNbaAnalysisQuery(query || {}) || query.date !== date) throw new Error('NBA 分析身分或盤口時間無效');
    const id = String(query.id).replace(/^nba:espn:game:/, '');
    if (task?.game?.id !== `nba:espn:game:${id}` || Number(task.game.gamePk) !== Number(id) || task.game.league !== 'NBA')
      throw new Error('NBA 工作場次身分不符');
    // No client price, score, features, settings or bet-execution flags survive.
    return { game: task.game, league: 'NBA', nbaQuery: { date, id, observedAt: query.observedAt } };
  });
}

export async function analyzeNbaJobTask(task, load = loadNbaAnalysis, loadBoard = loadNbaAnalysisBoard) {
  // A long baseball preflight must not freeze an obsolete NBA quote. Resolve
  // this same event's latest SERVER quote immediately before its analysis.
  const board = await loadBoard(task.nbaQuery.date);
  const latest = board.tasks.find(value => value.nbaQuery.id === task.nbaQuery.id);
  const query = latest?.nbaQuery || task.nbaQuery;
  const payload = await load(query);
  const game = payload.game ? { ...payload.game, gamePk: Number(payload.game.sourceId), gameDate: payload.game.startTime, leagueId: 'NBA' } : task.game;
  const usable = ['ready', 'reference'].includes(payload.status);
  return { ok: usable, status: usable ? 200 : payload.status === 'insufficient' ? 422 : 409,
    code: payload.status === 'insufficient' ? 'NBA_DATA_INSUFFICIENT' : payload.issues?.[0]?.code || '',
    blocked: !usable, error: usable ? '' : payload.issues?.[0]?.message || (payload.status === 'insufficient' ? '同球季校正樣本不足' : ''),
    payload, task: { game, league: 'NBA', nbaQuery: query } };
}
