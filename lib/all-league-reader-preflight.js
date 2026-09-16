// A successful HTTP response may still mean Reader is between captures.
// Reacquire BOTH the official schedule and signed credit lines on each attempt.
// Never turn blocked/stale prices into executable analysis tasks.
export async function prepareLeagueReaderPreflight({
  loadSchedule, loadCredit, onWaiting = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  delaysMs = [5000, 10000, 20000],
}) {
  for (let attempt = 0; ; attempt += 1) {
    const games = await loadSchedule();
    if (!games.length) return { games, credit: null, emptyReason: 'no_games' };
    const credit = await loadCredit(games);
    if (credit?.code === 'NO_PRESTART_GAMES') return { games: [], credit, emptyReason: 'no_games' };
    if (credit?.blocked !== true) return { games, credit, emptyReason: null };
    const error = new Error(credit.message || 'Reader資料驗證未通過');
    error.code = credit.code || 'READER_PRECHECK_BLOCKED';
    error.stage = 'reader_preflight';
    if (attempt >= delaysMs.length) throw error;
    onWaiting({ attempt: attempt + 1, delayMs: delaysMs[attempt], code: error.code, message: error.message });
    await wait(delaysMs[attempt]);
  }
}
