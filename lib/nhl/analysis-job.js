import { analyzeNhlPregame } from './pregame-analysis.js';
import { nhlDate, validNhlDate, validateNhlIdentity } from './identity.js';

function sameTaskGameIdentity(game, expected) {
  if (!validateNhlIdentity(game).ok || !validateNhlIdentity(expected).ok) return false;
  // Official schedule and archived snapshots may serialize the same instant
  // as Z or .000Z. Compare canonical instants without changing saved evidence.
  return validateNhlIdentity({ ...game, startTimeUTC: new Date(game.startTimeUTC).toISOString() },
    { ...expected, startTimeUTC: new Date(expected.startTimeUTC).toISOString() }).ok;
}

export function normalizeNhlAnalysisTasks(tasks, date) {
  if (!validNhlDate(date)) throw new Error('NHL 分析身分或日期無效');
  const seen = new Set();
  return tasks.map(task => {
    const query = task?.nhlQuery;
    const game = task?.game;
    if (query?.date !== date || !/^\d{10}$/.test(String(query?.gameId || '')) || !game
      || game.league !== 'NHL' || game.leagueId !== 'NHL'
      || String(game.gameId) !== String(query.gameId) || game.gamePk !== Number(query.gameId)
      || nhlDate(game.startTimeUTC) !== date || !validateNhlIdentity(game).ok
      || seen.has(String(query.gameId))) throw new Error('NHL 工作場次身分不符');
    seen.add(String(query.gameId));
    const startTimeUTC = new Date(game.startTimeUTC).toISOString();
    // Persist only identity context. Client odds, scores and execution flags
    // never reach either the isolated NHL service or baseball analysis.
    return { league: 'NHL', nhlQuery: { date, gameId: String(query.gameId) }, game: {
      league: 'NHL', leagueId: 'NHL', gameId: String(game.gameId), gamePk: Number(game.gameId),
      gameDate: startTimeUTC, startTimeUTC, taipeiDate: date,
      season: game.season, gameType: game.gameType, awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId,
    } };
  });
}

export async function analyzeNhlJobTask(task, load = analyzeNhlPregame) {
  const payload = await load(task.nhlQuery);
  const identity = payload?.league === 'NHL' && String(payload.gameId) === task.nhlQuery.gameId
    && payload.taipeiDate === task.nhlQuery.date && sameTaskGameIdentity(payload.game, task.game);
  const usable = identity && ['PREGAME_SHADOW', 'SAVED_PREGAME_REPLAY'].includes(payload.mode)
    && Boolean(payload.model) && payload.qa?.status !== 'BLOCK'
    && payload.readiness?.formalRecommendations === false && payload.readiness?.realBetExecutionEnabled === false;
  return { ok: usable, status: usable ? 200 : 422, shadow: usable, saved: usable && payload.persistence?.persisted === true, blocked: !usable,
    code: usable ? 'NHL_SHADOW_ANALYSIS' : identity ? 'NHL_ANALYSIS_UNAVAILABLE' : 'NHL_ANALYSIS_IDENTITY_MISMATCH',
    error: usable ? '' : 'NHL 賽前資料或已保存的分析不足', payload,
    task: { game: identity ? { ...task.game, startTimeUTC: payload.game.startTimeUTC, gameDate: payload.game.startTimeUTC } : task.game,
      league: 'NHL', nhlQuery: task.nhlQuery } };
}
