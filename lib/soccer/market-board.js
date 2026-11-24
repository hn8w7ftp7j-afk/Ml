import { SOCCER_DATA_VERSION, SOCCER_TIME_ZONE, SOCCER_CAPABILITIES, soccerLeague, soccerDate, validSoccerDate, soccerCacheKey } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { loadSoccerReaderBoardDates, loadSoccerReaderSnapshot, soccerReaderStorageConfigured } from './reader-store.js';
import { matchSoccerReaderGames } from './reader.js';

// A display projection of current Reader heads across dates, not a complete
// schedule authority. Analysis still obtains each game's full single-day board.
export async function fetchSoccerMarketBoard(leagueValue, date, {
  now = Date.now, listDates = loadSoccerReaderBoardDates, loadReader = loadSoccerReaderSnapshot,
  schedule = fetchSoccerSchedule, storageConfigured = soccerReaderStorageConfigured,
  timeBudgetMs = 35000,
} = {}) {
  const wallStartedAt = performance.now();
  const league = soccerLeague(leagueValue), startedAt = now(), from = soccerDate(startedAt);
  if (!league || !validSoccerDate(date) || !Number.isFinite(startedAt)
    || !Number.isInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 40000) throw Error('SOCCER_MARKET_BOARD_SCOPE_INVALID');
  let deadlineExpired = false;
  const remainingMs = () => deadlineExpired ? 0 : Math.max(0, timeBudgetMs - (performance.now() - wallStartedAt));
  async function withinDeadline(operation) {
    const remaining = remainingMs();
    if (remaining < 1) throw Error('SOCCER_MARKET_BOARD_DEADLINE');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => {
          // A fractional timer delay can round down. Its deadline signal is
          // terminal even if the monotonic clock still has a fraction left.
          deadlineExpired = true;
          reject(Error('SOCCER_MARKET_BOARD_DEADLINE'));
        }, remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  const base = { version: SOCCER_DATA_VERSION, league, date, timeZone: SOCCER_TIME_ZONE,
    capabilities: SOCCER_CAPABILITIES, cacheNamespace: soccerCacheKey(league.id, 'markets', from), requestedDateIsNavigationOnly: true };
  if (!storageConfigured()) return { ...base, ok: false, code: 'SOCCER_READER_STORAGE_UNAVAILABLE' };
  let dates;
  try { dates = await withinDeadline(() => listDates(league.id, from)); }
  catch { return { ...base, ok: false, code: 'SOCCER_READER_DATES_UNAVAILABLE' }; }
  if (!Array.isArray(dates) || dates.some(value => !validSoccerDate(value) || value < from)
    || new Set(dates).size !== dates.length) throw Error('SOCCER_READER_DATES_INVALID');
  dates.sort();
  const output = Array(dates.length); let cursor = 0;
  async function worker() {
    while (cursor < dates.length && remainingMs() >= 1) {
      const index = cursor++, boardDate = dates[index];
      const row = output[index] = { date: boardDate, games: [], cohortGames: [], reader: false, unmatchedGames: 0 };
      try {
        const capture = await withinDeadline(() => loadReader(league.id, boardDate));
        if (!capture) continue;
        if (soccerLeague(capture.league)?.id !== league.id || capture.boardDate !== boardDate || !Array.isArray(capture.games)) throw Error('SOCCER_READER_SCOPE_INVALID');
        // Display saved odds even after their freshness expires. The original
        // per-market observations remain unchanged and ranking still rechecks them.
        const open = capture.games.filter(game => game.boardDate === boardDate && Array.isArray(game.markets) && game.markets.length
          && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime || '')
          && Date.parse(`${boardDate}T${game.boardTime}:00+08:00`) > startedAt);
        if (!open.length) continue;
        row.reader = true;
        // Pass the remaining budget into source requests so their own fetch
        // controllers abort too. The outer deadline also bounds shared cached
        // in-flight requests and storage transports without a cancellation API.
        const board = await withinDeadline(() => schedule(league.id, boardDate, { timeoutMs: Math.max(1, Math.min(8000, Math.floor(remainingMs()))) }));
        if (!board?.ok || board.league?.id !== league.id || board.date !== boardDate || board.until !== boardDate
          || board.coverage?.complete !== true || !Array.isArray(board.games)) throw Error('SOCCER_MARKET_SCHEDULE_UNAVAILABLE');
        if (board.games.some(game => game.league !== league.id || game.date !== boardDate
          || game.id !== `soccer:${league.id}:${game.sourceId}`)
          || new Set(board.games.map(game => game.id)).size !== board.games.length) throw Error('SOCCER_MARKET_SCHEDULE_INVALID');
        row.cohortGames = board.games;
        const openTimes = new Set(open.map(game => game.boardTime));
        const matched = matchSoccerReaderGames(capture, board.games, startedAt)
          .filter(game => game.boardDate === boardDate && openTimes.has(game.boardTime) && game.markets.length);
        row.unmatchedGames = matched.filter(game => game.matchStatus !== 'MATCHED').length;
        const ids = new Set(matched.filter(game => game.prestart && game.markets.length && game.officialGameId).map(game => game.officialGameId));
        row.games = board.games.filter(game => ids.has(game.id) && game.status === 'scheduled' && Date.parse(game.startTime) > startedAt);
      } catch { row.reader = true; row.failed = true; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, dates.length) }, worker));
  const rows = output.filter(Boolean), deferredDates = dates.filter((_, index) => !output[index]);
  const failedDates = rows.filter(row => row.failed).map(row => row.date);
  const readerDates = rows.filter(row => row.reader).map(row => row.date).concat(deferredDates).sort();
  const games = rows.flatMap(row => row.games).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  // A provider ID moving between days is ambiguous until the source agrees.
  const counts = new Map(); for (const game of games) counts.set(game.id, (counts.get(game.id) || 0) + 1);
  const conflicts = games.filter(game => counts.get(game.id) > 1);
  const unique = games.filter(game => counts.get(game.id) === 1);
  return { ...base, ok: true, games: unique, cohortGames: rows.flatMap(row => row.cohortGames), readerDates,
    until: readerDates.at(-1) || from, availableDates: [...new Set(unique.map(game => game.date))],
    source: { provider: 'Tai888 Reader／ESPN', fetchedAt: new Date(startedAt).toISOString(), scope: 'CROSS_DATE_MARKET_DISPLAY' },
    coverage: { complete: false, scope: 'SAVED_READER_MARKET_SUBSET', completeScheduleAuthority: false },
    marketCoverage: { scope: 'ALL_SAVED_FUTURE_READER_DATES', from, indexedDates: dates,
      complete: !failedDates.length && !deferredDates.length && !conflicts.length,
      failedDates, deferredDates, unmatchedGames: rows.reduce((sum, row) => sum + row.unmatchedGames, 0),
      conflictingGames: [...new Set(conflicts.map(game => game.id))].length },
  };
}
