import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadSoccerReaderBoardDates } from '../lib/soccer/reader-store.js';
import { fetchSoccerMarketBoard } from '../lib/soccer/market-board.js';
import { soccerCompleteScheduleAuthorityVerified } from '../lib/soccer/reader-identity-proof.js';

const db = new PGlite();
try {
  await db.exec('CREATE TABLE sports_soccer_reader_observations_v2 (league text, board_date date)');
  await db.exec("INSERT INTO sports_soccer_reader_observations_v2 VALUES ('EPL','2026-11-21'),('EPL','2026-11-22'),('EPL','2026-11-22'),('EPL','2027-03-15'),('UCL','2026-11-24')");
  const query = async (sql, params) => (await db.query(sql, params)).rows;
  assert.deepEqual(await loadSoccerReaderBoardDates('epl', '2026-11-22', { query, ensure: async () => {} }), ['2026-11-22', '2027-03-15']);
  await db.exec('CREATE TABLE sports_soccer_reader_snapshots_v1 (league text, board_date date)');
  await db.exec("INSERT INTO sports_soccer_reader_snapshots_v1 VALUES ('EPL','2026-11-22'),('EPL','2026-12-25'),('UCL','2026-12-26')");
  assert.deepEqual(await loadSoccerReaderBoardDates('EPL', '2026-11-22', { query, ensure: async () => {} }), ['2026-11-22', '2026-12-25', '2027-03-15']);
  assert.deepEqual(await loadSoccerReaderBoardDates('ucl', '2026-11-22', { query, ensure: async () => {} }), ['2026-11-24', '2026-12-26']);
  await assert.rejects(loadSoccerReaderBoardDates('NBA', '2026-11-22', { query, ensure: async () => {} }), /SCOPE_INVALID/);
} finally { await db.close(); }
console.log('PASS Reader future date discovery: real SQL, league separation, legacy absence, deduplication and no 14-day cutoff');

const now = Date.parse('2026-11-22T14:00:00Z');
const key = value => globalThis.Tai888SoccerTeams.key(value);
const game = (date, time, id, status = 'scheduled', league = 'epl') => ({
  id: `soccer:${league}:${id}`, sourceId: String(id), league, date, status,
  startTime: new Date(`${date}T${time}:00+08:00`).toISOString(),
  home: { name: 'Hull City', sourceId: '359' }, away: { name: 'Brighton & Hove Albion', sourceId: '364' },
});
const raw = (g, patch = {}) => ({ league: g.league.toUpperCase(), boardDate: g.date,
  boardTime: new Date(Date.parse(g.startTime) + 8 * 3600000).toISOString().slice(11, 16),
  homeKey: key('Hull City'), awayKey: key('Brighton & Hove Albion'),
  markets: [{ kind: 'HANDICAP', period: 'FT', unit: 'GOALS', line: '1+50', lineSide: 'away', homeWater: 1.37, awayWater: .5 }], ...patch });
const late = game('2026-11-22', '23:30', 1), early = game('2026-11-23', '01:00', 2), far = game('2027-03-15', '03:00', 3);
const ended = game('2026-11-22', '21:00', 4, 'final'), live = game('2026-11-22', '23:00', 5, 'live');
const cancelled = game('2026-11-23', '03:00', 6, 'cancelled'), noOdds = game('2026-11-23', '04:00', 7);
const unknown = raw(game('2026-11-23', '05:00', 8), { homeKey: key('Chelsea') });
const gamesByDate = new Map([
  [late.date, [late, ended, live]], [early.date, [early, cancelled, noOdds]], [far.date, [far]],
]);
const capture = (date, games) => ({ league: 'EPL', boardDate: date, games,
  observedAt: new Date(now - 3600000).toISOString(), executable: false });
const readers = new Map([
  [late.date, capture(late.date, [raw(late), raw(ended), raw(live)])],
  [early.date, capture(early.date, [raw(early), raw(cancelled), raw(noOdds, { markets: [] }), unknown])],
  [far.date, capture(far.date, [raw(far)])],
]);
const original = JSON.stringify([...readers]);
const schedule = async (league, date) => ({ ok: true, league: { id: league }, date, until: date,
  games: gamesByDate.get(date) || [], coverage: { complete: true } });
const options = { now: () => now, listDates: async (league, from) => {
  assert.equal(league, 'epl'); assert.equal(from, '2026-11-22'); return [...readers.keys()];
}, loadReader: async (_, date) => readers.get(date), schedule, storageConfigured: () => true };
const board = await fetchSoccerMarketBoard('epl', '2026-10-01', options);
assert.equal(board.ok, true);
assert.deepEqual(board.games.map(g => g.id), [late.id, early.id, far.id]);
assert.deepEqual(board.readerDates, ['2026-11-22', '2026-11-23', '2027-03-15']);
assert.equal(board.marketCoverage.unmatchedGames, 1);
assert.equal(board.marketCoverage.complete, true);
assert.equal(board.requestedDateIsNavigationOnly, true);
assert.equal(board.cohortGames.length, 7, 'cohort preserves all official rows, including rows not selected by odds');
assert.equal(board.coverage.complete, false, 'a market subset cannot claim complete schedule coverage');
assert.equal(soccerCompleteScheduleAuthorityVerified(board, late), false);
assert.equal(JSON.stringify([...readers]), original, 'display does not rewrite saved observations, freshness or raw markets');
console.log('PASS cross-midnight/far-future market display: exact kickoff order, stale odds visible, independent dates, no completed/cancelled/no-odds games, unmatched raw visibility');

const partial = await fetchSoccerMarketBoard('epl', late.date, { ...options,
  schedule: async (league, date) => date === early.date ? { ok: false } : schedule(league, date),
});
assert.deepEqual(partial.games.map(g => g.id), [late.id, far.id]);
assert.deepEqual(partial.marketCoverage.failedDates, [early.date]);
assert.equal(partial.marketCoverage.complete, false);
assert.ok(partial.readerDates.includes(early.date));
const foreign = await fetchSoccerMarketBoard('epl', late.date, { ...options,
  loadReader: async (_, date) => date === early.date ? { ...readers.get(date), league: 'UCL' } : readers.get(date),
});
assert.deepEqual(foreign.games.map(g => g.id), [late.id, far.id]);
assert.deepEqual(foreign.marketCoverage.failedDates, [early.date]);
const unavailable = await fetchSoccerMarketBoard('epl', late.date, { ...options, storageConfigured: () => false });
assert.equal(unavailable.ok, false); assert.equal(unavailable.code, 'SOCCER_READER_STORAGE_UNAVAILABLE');
console.log('PASS partial/unavailable data stays explicit: failed dates retain raw-board entry, foreign league rejected and deadline omissions disclosed');

let active = 0, maximum = 0;
const manyDates = Array.from({ length: 12 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
await fetchSoccerMarketBoard('epl', late.date, { ...options, listDates: async () => manyDates,
  loadReader: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return null; },
});
assert.equal(maximum, 4);
console.log('PASS bounded cross-date Reader work: at most four dates concurrently');

for (const blocked of ['index', 'reader', 'schedule']) {
  const forever = () => new Promise(() => {}), start = performance.now();
  const slow = await fetchSoccerMarketBoard('epl', late.date, { ...options, timeBudgetMs: 25,
    ...(blocked === 'index' ? { listDates: forever }
      : blocked === 'reader' ? { loadReader: forever }
        : { schedule: async (_league, _date, sourceOptions) => {
          assert.ok(sourceOptions.timeoutMs <= 25 && sourceOptions.timeoutMs > 0);
          return forever();
        } }),
  });
  assert.ok(performance.now() - start < 1000, `${blocked} must return even if the dependency never resolves`);
  if (blocked === 'index') { assert.equal(slow.ok, false); assert.equal(slow.code, 'SOCCER_READER_DATES_UNAVAILABLE'); }
  else { assert.equal(slow.marketCoverage.complete, false); assert.deepEqual(slow.marketCoverage.failedDates, [...readers.keys()]); }
}
const deferred = await fetchSoccerMarketBoard('epl', late.date, { ...options, timeBudgetMs: 25,
  listDates: async () => manyDates, loadReader: () => new Promise(() => {}),
});
assert.deepEqual(deferred.marketCoverage.failedDates, manyDates.slice(0, 4));
assert.deepEqual(deferred.marketCoverage.deferredDates, manyDates.slice(4));
assert.deepEqual(deferred.readerDates, manyDates);
assert.equal(deferred.marketCoverage.complete, false);
console.log('PASS hard end-to-end deadline: unresolved index, Reader, schedule and deferred workers return within budget; source requests receive remaining timeout');
