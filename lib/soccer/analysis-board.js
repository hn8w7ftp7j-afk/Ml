import { soccerDate, soccerLeague, validSoccerDate, shiftSoccerDate } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { loadSoccerReaderSnapshot } from './reader-store.js';
import { matchSoccerReaderGames } from './reader.js';
import { ensureSoccerJournal, soccerJournalConfigured, soccerJournalQuery } from './journal.js';
import { normalizeSoccerAnalysisTasks } from './analysis-job.js';

function prestart(game, league, date, now) {
  return game?.league === league && game.date === date && game.status === 'scheduled'
    && game.id === `soccer:${league}:${game.sourceId}` && typeof game.sourceId === 'string'
    && /^[1-9]\d{0,15}$/.test(game.sourceId) && Number.isSafeInteger(Number(game.sourceId))
    && soccerDate(game.startTime) === date && Date.parse(game.startTime) > now;
}

export function buildSoccerAnalysisBoard(leagueValue, date, schedule, { now = Date.now(), requestedDate = date } = {}) {
  const league = soccerLeague(leagueValue);
  if (!league || !validSoccerDate(date) || !Number.isFinite(now)) throw Object.assign(Error('足球日期或聯盟無效'), { code: 'SOCCER_INVALID_BOARD_SCOPE' });
  if (schedule?.ok !== true || schedule?.league?.id !== league.id || !Array.isArray(schedule.games))
    throw Object.assign(Error('足球官方賽程暫時無法核對'), { code: schedule?.code || 'SOCCER_SCHEDULE_UNAVAILABLE' });
  const games = schedule.games.filter(game => game.league === league.id && game.date === date);
  const rows = games.map(game => ({ game, canAnalyze: prestart(game, league.id, date, now),
    reason: prestart(game, league.id, date, now) ? '' : '已開賽、完賽或賽程身分尚未核對' }));
  const tasks = normalizeSoccerAnalysisTasks(rows.filter(row => row.canAnalyze).map(({ game }) => ({
    league: league.id.toUpperCase(), soccerQuery: { league: league.id, date, eventId: game.sourceId },
    game: { id: game.id, sourceId: game.sourceId, gamePk: Number(game.sourceId), league: league.id.toUpperCase(),
      leagueId: league.id.toUpperCase(), date, startTime: game.startTime, gameDate: game.startTime,
      homeTeamId: String(game.home?.sourceId || ''), awayTeamId: String(game.away?.sourceId || '') },
  })), date, league.id);
  return { league: league.id.toUpperCase(), date, requestedDate, rows, tasks, total: tasks.length,
    emptyReason: tasks.length ? null : 'no_games', mode: 'RESEARCH_ONLY',
    formalScoringEnabled: false, executable: false, sources: schedule.sources || [], source: schedule.source || null };
}

export async function loadSoccerReaderBoardDates(leagueValue, date) {
  const league = soccerLeague(leagueValue);
  if (!league || !validSoccerDate(date) || !soccerJournalConfigured()) return [];
  await ensureSoccerJournal();
  const rows = await soccerJournalQuery(`SELECT DISTINCT board_date::text AS date
    FROM sports_soccer_reader_period_heads_v2 WHERE league=$1 AND board_date>=$2::date
      AND board_date<=$3::date ORDER BY date LIMIT 3`, [league.id, date, shiftSoccerDate(date, 14)]);
  return rows.map(row => row.date).filter(validSoccerDate);
}

export async function loadSoccerAnalysisBoard(leagueValue, date, options = {}) {
  const league = soccerLeague(leagueValue), now = options.now ?? Date.now();
  if (!league || !validSoccerDate(date) || !Number.isFinite(now)) throw Object.assign(Error('足球日期或聯盟無效'), { code: 'SOCCER_INVALID_BOARD_SCOPE' });
  const loadSchedule = options.loadSchedule || fetchSoccerSchedule;
  const selectedDate = options.upcoming === true && date < soccerDate(now) ? soccerDate(now) : date;
  const selected = await loadSchedule(league.id, selectedDate);
  const selectedBoard = buildSoccerAnalysisBoard(league.id, selectedDate, selected, { now, requestedDate: date });
  if (options.upcoming !== true) return selectedBoard;
  // Reader dates are hints only. A date is adopted only after an open fresh
  // goal market matches the same league's official future identity/time/teams.
  // game.fresh is per market; an old sibling period cannot hide a current one.
  let readerDates = [];
  try { readerDates = await (options.loadReaderDates || loadSoccerReaderBoardDates)(league.id, selectedDate); } catch {}
  for (const candidate of [...new Set([selectedDate, ...readerDates])].filter(value => validSoccerDate(value) && value >= selectedDate).sort().slice(0, 4)) {
    const [schedule, reader] = await Promise.all([
      candidate === selectedDate ? selected : loadSchedule(league.id, candidate),
      Promise.resolve().then(() => (options.loadReader || loadSoccerReaderSnapshot)(league.id, candidate)).catch(() => null),
    ]);
    if (schedule?.ok !== true) continue;
    const candidateBoard = buildSoccerAnalysisBoard(league.id, candidate, schedule, { now, requestedDate: date });
    const matched = reader ? matchSoccerReaderGames(reader, schedule.games, now) : [];
    if (candidateBoard.tasks.length && matched.some(game => game.matchStatus === 'MATCHED' && game.fresh === true && game.prestart === true
      && candidateBoard.tasks.some(task => task.game.id === game.officialGameId))) return candidateBoard;
  }
  if (selectedBoard.tasks.length) return selectedBoard;
  // Reuse the soccer provider's attributed single-day snapshots. No baseball
  // schedule adapter or client quote/settings can select a football date.
  const upcoming = await loadSchedule(league.id, selectedDate, { windowDays: 8 });
  if (upcoming?.ok !== true) throw Object.assign(Error('足球近期官方賽程暫時無法核對'), { code: upcoming?.code || 'SOCCER_SCHEDULE_UNAVAILABLE' });
  const candidates = upcoming.games.filter(game => prestart(game, league.id, game.date, now) && game.date >= selectedDate)
    .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime));
  return candidates.length
    ? buildSoccerAnalysisBoard(league.id, candidates[0].date, upcoming, { now, requestedDate: date })
    : selectedBoard;
}
