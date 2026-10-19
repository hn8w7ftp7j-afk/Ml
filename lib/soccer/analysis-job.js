import { soccerDate, soccerLeague, validSoccerDate } from './contracts.js';
import { soccerCandidatePayloadValid } from './candidate-qualification.js';
import { analyzeSoccerGame, validSoccerAnalysisQuery } from './analysis-service.js';

const sourceId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);

export function normalizeSoccerAnalysisTasks(tasks, date, leagueValue) {
  const league = soccerLeague(leagueValue);
  if (!league || !validSoccerDate(date) || !Array.isArray(tasks) || tasks.length > 20) throw Error('足球 分析身分或日期無效');
  const seen = new Set(), upper = league.id.toUpperCase();
  return tasks.map(task => {
    const query = task?.soccerQuery, game = task?.game;
    const start = game?.startTime || game?.gameDate;
    if (!validSoccerAnalysisQuery(query) || query.league !== league.id || query.date !== date || !game
      || task.league !== undefined && task.league !== upper
      || game.league !== upper || game.leagueId !== upper || game.date !== date
      || game.id !== `soccer:${league.id}:${query.eventId}` || game.sourceId !== query.eventId
      || game.gamePk !== Number(query.eventId) || !Number.isSafeInteger(game.gamePk) || game.gamePk <= 0
      || typeof start !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(start) || soccerDate(start) !== date
      || game.gameDate && Date.parse(game.gameDate) !== Date.parse(start)
      || !sourceId(game.homeTeamId) || !sourceId(game.awayTeamId) || game.homeTeamId === game.awayTeamId
      || seen.has(query.eventId)) throw Error('足球 工作場次身分不符');
    seen.add(query.eventId);
    const startTime = new Date(start).toISOString();
    return { league: upper, soccerQuery: { league: league.id, date, eventId: query.eventId }, game: {
      id: game.id, sourceId: query.eventId, gamePk: game.gamePk, league: upper, leagueId: upper,
      date, startTime, gameDate: startTime, homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId,
    } };
  });
}

export async function analyzeSoccerJobTask(task, load = analyzeSoccerGame) {
  const expected = normalizeSoccerAnalysisTasks([task], task?.soccerQuery?.date, task?.league)[0];
  const response = await load(expected.soccerQuery), payload = response?.payload;
  const game = payload?.evidence?.game;
  const identity = payload?.league === expected.soccerQuery.league && payload?.gameId === expected.game.id
    && payload?.date === expected.soccerQuery.date && game?.id === expected.game.id
    && game?.sourceId === expected.game.sourceId && game?.league === expected.soccerQuery.league
    && game?.date === expected.game.date && Date.parse(game?.startTime) === Date.parse(expected.game.startTime)
    && String(game?.home?.sourceId) === expected.game.homeTeamId && String(game?.away?.sourceId) === expected.game.awayTeamId;
  const researchSafe = identity && soccerCandidatePayloadValid(payload)
    && Array.isArray(payload.directions) && payload.directions.length === 8;
  const completed = response?.status >= 200 && response.status < 300 && payload?.ok === true && researchSafe
    && payload.analysisStatus === 'COMPLETED' && payload.selectionResult === 'RESEARCH_SHADOW';
  const insufficient = payload?.analysisStatus === 'INSUFFICIENT_DATA';
  return {
    ok: completed, status: completed ? 200 : insufficient || payload?.ok === true ? 422 : response?.status || 503,
    research: completed, blocked: insufficient || payload?.ok === true && !researchSafe, shadow: false,
    saved: researchSafe && payload?.persisted === true && payload?.journalPersisted === true,
    analysisStatus: payload?.analysisStatus || 'FAILED', publishedCurrent: completed && payload?.publishedCurrent === true,
    code: completed ? 'SOCCER_RESEARCH_ANALYSIS' : payload?.code || (!identity && payload?.ok === true
      ? 'SOCCER_ANALYSIS_IDENTITY_MISMATCH' : !researchSafe && payload?.ok === true ? 'SOCCER_RESEARCH_BOUNDARY_INVALID' : 'SOCCER_ANALYSIS_UNAVAILABLE'),
    error: completed ? '' : payload?.error || (insufficient ? '足球研究資料不足' : '足球研究結果未通過核對'),
    payload, task: expected,
  };
}
