import { fetchNhlJson, NHL_SOURCES, normalizeNhlSchedule } from './data.js';
import { nhlDate, validNhlDate, validateNhlIdentity } from './identity.js';

function prestart(game, now) {
  return game?.leagueId === 'NHL' && ['FUT', 'PRE'].includes(game.gameState)
    && game.gameScheduleState === 'OK' && validateNhlIdentity(game).ok
    && Date.parse(game.startTimeUTC) > now;
}

// The official schedule response already contains a week. Discover the next
// Taiwan slate in that single response instead of issuing one request per day.
export function buildNhlAnalysisBoard(date, schedule, { now = Date.now(), upcoming = false } = {}) {
  if (!validNhlDate(date)) throw new Error('NHL 日期無效');
  if (!Number.isFinite(now) || schedule?.ok !== true || !Array.isArray(schedule.games)) {
    throw Object.assign(new Error('NHL 官方賽程尚未完成核對'), { code: schedule?.code || 'NHL_SCHEDULE_UNAVAILABLE' });
  }
  const candidates = schedule.games.filter(game => prestart(game, now) && game.taipeiDate >= date)
    .sort((left, right) => Date.parse(left.startTimeUTC) - Date.parse(right.startTimeUTC));
  const boardDate = upcoming && candidates.length ? candidates[0].taipeiDate : date;
  const games = schedule.games.filter(game => game.taipeiDate === boardDate);
  const rows = games.map(game => ({ game, canAnalyze: prestart(game, now),
    reason: prestart(game, now) ? '' : '已開賽、完賽、延期或賽程尚未核對' }));
  const tasks = rows.filter(row => row.canAnalyze).map(({ game }) => ({
    game: { ...game, gamePk: Number(game.gameId), gameDate: game.startTimeUTC },
    nhlQuery: { date: boardDate, gameId: game.gameId },
  }));
  return { league: 'NHL', date: boardDate, requestedDate: date, rows, tasks,
    total: tasks.length, emptyReason: tasks.length ? null : 'no_games',
    mode: 'PREGAME_SHADOW', executable: false, source: schedule.source || null };
}

export async function loadNhlAnalysisBoard(date, options = {}) {
  if (!validNhlDate(date)) throw new Error('NHL 日期無效');
  const now = options.now ?? Date.now();
  const selected = options.upcoming && date < nhlDate(now) ? nhlDate(now) : date;
  const anchor = new Date(`${selected}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  const source = await (options.fetchJson ?? fetchNhlJson)(`${NHL_SOURCES.schedule.url}${anchor.toISOString().slice(0, 10)}`);
  if (!source.ok) throw Object.assign(new Error('NHL 官方賽程暫時無法取得'), { code: source.code || 'NHL_SCHEDULE_UNAVAILABLE' });
  return buildNhlAnalysisBoard(selected, normalizeNhlSchedule(source.data, source.source), { now, upcoming: options.upcoming === true });
}
