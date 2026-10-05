import { loadNbaData } from './data.js';
import { loadNbaReaderSnapshot } from './reader-store.js';
import { nbaReaderPublicView } from './reader.js';
import { matchNbaReaderGame, nbaReaderDisplayStatus } from './reader-display.js';
import { validDate } from './identity.js';

export function buildNbaAnalysisBoard(date, schedule, board, now = Date.now()) {
  if (!validDate(date)) throw new Error('NBA 日期無效');
  if (schedule?.league !== 'NBA' || !['ready', 'empty'].includes(schedule.status) || schedule?.qa?.status === 'BLOCK')
    throw new Error('NBA 賽程尚未完成核對');
  const fresh = nbaReaderDisplayStatus(board, now) === 'fresh';
  const games = schedule.data?.games || [];
  const rows = games.map(game => {
    const matches = (board?.games || []).filter(row => matchNbaReaderGame(row, schedule).game?.id === game.id);
    const quote = matches.length === 1 ? matches[0] : null;
    const prestart = game.status === 'scheduled' && !game.completed && game.timeConfirmed === true && Date.parse(game.startTime) > now;
    const available = game.seasonType === 'preseason' ? ['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline'].some(key => quote?.[key]) : Boolean(quote?.fullTotal);
    const canAnalyze = fresh && prestart && quote?.marketStatus === 'open' && available;
    return { game, quote, canAnalyze,
      reason: !prestart ? '已開賽、完賽或開賽時間未確認' : matches.length > 1 ? '盤口場次配對不唯一'
        : !quote ? '等待此場盤口同步' : !fresh ? 'Reader 盤口已過期，請重新同步'
          : quote.marketStatus !== 'open' ? '盤口已鎖定' : !available ? '可分析盤口尚未開盤' : '',
      observedAt: board?.observedAt || null, pageActivityAt: board?.pageActivityAt || null };
  });
  const tasks = rows.filter(row => row.canAnalyze).map(row => ({
    game: { ...row.game, gamePk: Number(row.game.sourceId), gameDate: row.game.startTime, leagueId: 'NBA' },
    nbaQuery: { date, id: row.game.sourceId, observedAt: row.observedAt },
  }));
  return { league: 'NBA', date, rows, tasks, total: tasks.length,
    emptyReason: tasks.length ? null : games.some(game => game.status === 'scheduled' && !game.completed && Date.parse(game.startTime) > now) ? 'no_open_markets' : 'no_games',
    readerStatus: fresh ? 'fresh' : nbaReaderDisplayStatus(board, now),
    observedAt: board?.observedAt || null, sources: schedule.sources || [] };
}

export async function loadNbaAnalysisBoard(date, options = {}) {
  if (!validDate(date)) throw new Error('NBA 日期無效');
  const now = options.now ?? Date.now();
  const [schedule, snapshot] = await Promise.all([
    (options.loadSchedule ?? loadNbaData)({ view: 'schedule', date }),
    (options.loadReader ?? loadNbaReaderSnapshot)(date),
  ]);
  return buildNbaAnalysisBoard(date, schedule, nbaReaderPublicView(snapshot, { now, boardDate: date }), now);
}
