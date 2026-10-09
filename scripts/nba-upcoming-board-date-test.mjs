import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadNbaUpcomingBoard } from '../lib/nba/analysis-ui-policy.js';
import { buildNbaAnalysisBoard } from '../lib/nba/analysis-board.js';
import { LEAGUE_IDS } from '../lib/leagues.js';
import { ANALYSIS_LEAGUE_IDS } from '../lib/analysis-leagues.js';
import { createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';

const now = Date.parse('2026-10-08T06:30:00Z'); // Taipei afternoon, UTC still October 8.
const today = '2026-10-08', tomorrow = '2026-10-09';
const game = { id: 'nba:espn:game:401999001', sourceId: '401999001', league: 'NBA',
  startTime: '2026-10-09T00:00:00Z', status: 'scheduled', completed: false, timeConfirmed: true,
  away: { id: 'nba:espn:team:2' }, home: { id: 'nba:espn:team:5' } };
const schedule = { league: 'NBA', status: 'ready', data: { games: [game] } };
const fresh = { status: 'fresh', boardDate: tomorrow, observedAt: new Date(now).toISOString(),
  games: [{ boardDate: tomorrow, boardTime: '08:00', away: game.away, home: game.home,
    marketStatus: 'open', fullTotal: { line: '220平', overWater: .94, underWater: .94 } }] };
const stale = { ...fresh, status: 'stale', observedAt: new Date(now - 180001).toISOString() };
const closed = buildNbaAnalysisBoard(today, { ...schedule, data: { games: [] } }, null, now);
const next = buildNbaAnalysisBoard(tomorrow, schedule, fresh, now);
const waiting = buildNbaAnalysisBoard(tomorrow, schedule, stale, now);

async function resolve({ selectedDate = today, manual = false, reader = stale, boards = { [today]: closed, [tomorrow]: next } } = {}) {
  const requests = [];
  const board = await loadNbaUpcomingBoard({ selectedDate, manual, now,
    loadReader: async () => { requests.push('reader'); return reader; },
    loadBoard: async date => { requests.push(date); if (boards[date] instanceof Error) throw boards[date]; return boards[date]; } });
  return { board, requests };
}
assert.equal((await resolve()).board.date, tomorrow, 'stale Reader must not strand completed today');
assert.deepEqual((await resolve()).requests, ['reader', today, tomorrow]);
assert.deepEqual((await resolve({ reader: fresh })).requests, ['reader', today, tomorrow]);
assert.deepEqual((await resolve({ reader: fresh, boards: { [today]: { ...next, date: today, emptyReason: null } } })).requests, ['reader', today], 'a fresh tomorrow pointer cannot skip today upcoming games');
assert.equal((await resolve({ reader: null })).board.date, tomorrow, 'missing Reader still follows the official upcoming slate');
assert.equal((await resolve({ selectedDate: '2026-10-07', reader: null })).board.date, tomorrow, 'automatic stale tab advances to the current Taipei slate first');
assert.deepEqual((await resolve({ manual: true })).requests, [today], 'manual history date remains authoritative');
assert.equal((await resolve({ boards: { [today]: closed, [tomorrow]: waiting } })).board.tasks.length, 0, 'date discovery cannot revive stale quotes');
assert.equal((await resolve({ boards: { [today]: closed, [tomorrow]: waiting } })).board.date, tomorrow);
assert.deepEqual((await resolve({ boards: { [today]: { ...next, date: today, emptyReason: 'no_open_markets' } } })).requests,
  ['reader', today], 'today with upcoming games stays on today even without prices');
assert.equal((await resolve({ boards: { [today]: closed, [tomorrow]: { ...waiting, rows: [], emptyReason: 'no_games' } } })).board.date, today);
assert.equal((await resolve({ boards: { [today]: closed, [tomorrow]: { ...waiting, rows: [{ game: { ...game, league: 'MLB' } }] } } })).board.date, today);
assert.equal((await resolve({ boards: { [today]: closed, [tomorrow]: { ...waiting, rows: [{ game: { ...game, timeConfirmed: false } }] } } })).board.date, today);
await assert.rejects(resolve({ boards: { [today]: closed, [tomorrow]: Error('schedule unavailable') } }), /schedule unavailable/);
for (const [stamp, date, nextDate] of [
  ['2026-10-08T16:01:00Z', '2026-10-09', '2026-10-10'], // Taipei midnight; do not use the UTC day.
  ['2026-12-31T06:30:00Z', '2026-12-31', '2027-01-01'],
  ['2028-02-28T06:30:00Z', '2028-02-28', '2028-02-29'],
]) {
  const board = await loadNbaUpcomingBoard({ selectedDate: date, now: Date.parse(stamp), loadReader: async () => null,
    loadBoard: async value => value === date ? { date, emptyReason: 'no_games' } : {
      date: value, rows: [{ game: { ...game, startTime: `${nextDate}T01:00:00Z` } }], tasks: [] } });
  assert.equal(board.date, nextDate);
}

// Execute the actual entry-point functions, with the same date-bound task used
// by the real board builder; no live analysis or ledger writes.
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function extract(source, name) {
  const start = source.indexOf(`  async function ${name}(`), end = source.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end + 4);
}
const calls = [], submissions = [], screen = [], saved = [];
const base = {
  Date, encodeURIComponent, crypto: globalThis.crypto,
  loadNbaUpcomingBoard: options => loadNbaUpcomingBoard({ ...options, now }),
  api: async (url, options) => {
    calls.push(url);
    if (url === '/api/nba/reader') return stale;
    if (url.includes('analysis-board')) return url.endsWith(today) ? closed : next;
    submissions.push(JSON.parse(options.body)); return { runId: 'test-nba-date' };
  },
  requestRevision: { current: 0 }, dateRef: { current: today }, jobRef: { current: null },
  explicitDate: { current: false }, operation: { current: false }, notification: { current: null }, busy: false,
  setDate: date => screen.push(date), onDateChange: date => screen.push(date), setRows: () => {}, setSelected: () => {},
  setReaderStatus: () => {}, setLoading: () => {}, setError: value => { if (value) throw Error(value); },
  setProgress: () => {}, setStarting: () => {}, setMessage: () => {}, setJob: value => saved.push(value),
  store: value => { saved.push(value); return true; }, prepareNbaNotification: () => {},
};
const single = vm.createContext(base), workspace = read('app/nba/main-workspace.js');
vm.runInContext(extract(workspace, 'load') + '\n' + extract(workspace, 'start'), single);
await single.start();
assert.equal(submissions[0].date, tomorrow); assert.equal(submissions[0].tasks[0].nbaQuery.date, tomorrow);
assert.equal(single.dateRef.current, tomorrow); assert.ok(screen.includes(tomorrow));
assert.equal(saved.at(-1).date, tomorrow);

const page = read('app/page.js');
const scopes = [];
const batch = vm.createContext({ ...base, requestJSON: base.api, nbaExplicitDateRef: { current: false },
  setNbaDate: date => screen.push(date), setNbaPreparedScope: scope => scopes.push(scope) });
vm.runInContext(extract(page, 'prepareNbaBatch'), batch);
const prepared = await batch.prepareNbaBatch(today);
assert.equal(prepared.date, tomorrow); assert.equal(prepared.tasks[0].nbaQuery.date, tomorrow);
assert.equal(scopes.at(-1).date, tomorrow, 'all-league preflight updates the NBA screen even with no analyzable prices');
const allSubmissions = [];
Object.assign(batch, {
  LEAGUE_IDS, ANALYSIS_LEAGUE_IDS, createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague,
  nbaDate: today, nbaRunning: false, league: 'MLB', date: today, allLeagueRun: null, allLeagueRunning: false,
  independentRunsRef: { current: new Map() }, manualDateSelectionRef: { current: new Set() },
  leagueDatesRef: { current: Object.fromEntries(LEAGUE_IDS.map(id => [id, today])) },
  currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: today }, requestedRecoveryScopeRef: {},
  readerPollBusyRef: { current: false }, allLeagueBusyRef: { current: false }, operationBusyRef: { current: false },
  analysisGenerationRef: { current: 1 }, restoredBoardNeedsValidationRef: { current: false },
  manualAnalysisScopesRef: { current: new Set() }, submittedAllLeagueRunRef: { current: null },
  requestJSONWithTransientRetry: async () => ({ fresh: false }), loadAllLeagueAnalysisRun: () => null,
  clearAllLeagueBackgroundJobs: () => {}, clearBackgroundJob: () => {}, markAppOperationBusy: () => {},
  setAllLeaguePreparing: () => {}, setNotice: () => {}, setBackgroundJobRevision: () => {},
  publishAllLeagueRun: value => { batch.allLeagueRun = value; },
  prepareAllLeagueBatch: async (league, date) => ({ league, date, tasks: [], preparedBoard: [], emptyReason: 'no_games' }),
  startBackgroundAnalysisJob: async payload => { allSubmissions.push(payload); return { runId: 'test-all-date' }; },
  saveBackgroundJob: () => true,
});
vm.runInContext(extract(page, 'allLeagueTargetDate') + '\n' + extract(page, 'oneClickAnalyzeAll'), batch);
assert.equal(await batch.oneClickAnalyzeAll(), true);
assert.equal(allSubmissions[0].batches.find(row => row.league === 'NBA').date, tomorrow);
assert.equal(allSubmissions[0].batches.find(row => row.league === 'NBA').tasks[0].nbaQuery.date, tomorrow);
assert.equal(batch.allLeagueRun.leagues.NBA.boardDate, tomorrow);
assert.equal(batch.leagueDatesRef.current.NBA, tomorrow);
assert.ok(batch.manualAnalysisScopesRef.current.has(`NBA:${tomorrow}`));
assert.ok(allSubmissions[0].batches.filter(row => row.league !== 'NBA').every(row => row.date === today));
assert.ok(workspace.includes("load(dateRef.current, { followLatest: !id })"), 'single-game selection stays on its own date');
console.log('NBA upcoming board date PASS: stale/missing/fresh Reader, official next-day slate, manual dates, midnight/year/leap boundaries, freshness and league isolation, real single-league submission and all-league preflight');
