import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { materializeAllLeagueResult } from '../lib/all-league-result-board.js';
import { allLeagueBoardDate, createAllLeagueAnalysisRun, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';

const ids = ['MLB', 'NPB', 'KBO', 'CPBL'];
const date = '2026-09-10';
const batches = ids.map((league, i) => {
  const game = { gamePk: i + 1, league, gameDate: `${date}T10:00:00Z`, awayTeamId: 10, homeTeamId: 20 };
  return { league, date, total: 1, results: [{ ok: true, task: { game, readerPayloadHash: 'old' }, payload: { game, analysis: { results: [{ score: 7.4 }] } } }] };
});
const board = materializeAllLeagueResult(batches[0]);
assert.equal(board.length, 1);
assert.equal(board[0].customData.analysis.results[0].score, 7.4);
assert.equal(board[0].readerPayloadHash, null, 'display cannot grant current market authority');
assert.throws(() => materializeAllLeagueResult({ ...batches[0], results: [] }), /筆數/);
assert.throws(() => materializeAllLeagueResult({ ...batches[0], total: 2, results: [batches[0].results[0], batches[0].results[0]] }), /重複/);
assert.throws(() => materializeAllLeagueResult({ ...batches[0], results: [{ ...batches[0].results[0], payload: { game: batches[1].results[0].task.game, analysis: {} } }] }), /身分/);
const blocked = materializeAllLeagueResult({ ...batches[0], results: [{ ok: false, status: 422, code: 'CORE_DATA_MISSING', error: 'homeSeasonPitching', task: batches[0].results[0].task }] });
assert.equal(blocked[0].status, 'blocked');
assert.equal(blocked[0].error, 'homeSeasonPitching');

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const marker = page.indexOf('const pollSummary = async');
const start = page.lastIndexOf('  useEffect(() => {', marker);
const end = page.indexOf('  useEffect(() => {', marker);
async function runSummary({ fresh = true, failLeague = '', switchLeague = false } = {}) {
  const run = { runId: 'test-run-123', state: 'running', date, leagues: Object.fromEntries(ids.map(id => [id, { status: 'running', boardDate: date }])) };
  let effect, published, shown = [], requests = [], caches = new Map();
  const context = {
    storageReady: true, date, allLeagueRun: run, allLeagueRunRef: { current: run },
    submittedAllLeagueRunRef: { current: fresh ? run.runId : null },
    allLeagueBoardsRef: { current: new Map() }, currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date }, boardRef: { current: [] },
    analysisGenerationRef: { current: 1 }, verifyCompletedBoard: async board => board,
    LEAGUE_IDS: ids, useEffect: fn => { effect = fn; }, allLeagueBoardDate, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague, materializeAllLeagueResult,
    requestJSON: async url => {
      requests.push(url);
      if (url.includes('summary=1')) return { status: 'completed', result: { batches } };
      const league = new URL(url, 'http://test').searchParams.get('league');
      if (switchLeague) context.currentLeagueRef.current = 'NPB';
      if (league === failLeague) throw new Error('network timeout');
      return { status: 'completed', result: batches.find(batch => batch.league === league) };
    },
    loadAllLeagueAnalysisRun: () => run, loadAnalysisBoardCache: () => [], compactAnalysisData: value => value,
    analysisItemMatchesScope: (item, scope) => item.game.league === scope.league,
    saveCompletedAnalysisReceipt: () => ({ completed: 1, stored: true }),
    saveAnalysisBoardCache: (league, date, rows) => caches.set(league, rows), clearBackgroundJob: () => {},
    publishAllLeagueRun: value => { published = value; }, setBoard: value => { shown = value; }, setSchedule: () => {}, setProgress: () => {}, setBackgroundJobRevision: () => {},
    window: { setTimeout: () => { throw new Error('unexpected retry'); }, clearTimeout: () => {} },
  };
  vm.runInNewContext(page.slice(start, end), context);
  effect();
  await new Promise(resolve => setImmediate(resolve));
  return { published, shown, requests, caches };
}
let result = await runSummary();
assert.equal(result.requests.length, 5, 'summary must be followed by four full result reads');
assert.equal(result.caches.size, 4, 'all leagues persist without visiting each tab');
assert.equal(result.shown[0].game.league, 'MLB');
assert.ok(ids.every(id => result.published.leagues[id].resultLoaded));
result = await runSummary({ failLeague: 'NPB' });
assert.equal(result.published.leagues.NPB.status, 'result_pending');
assert.match(result.published.leagues.NPB.message, /network timeout/);
assert.equal(result.caches.size, 3, 'one unavailable result must not discard other leagues');
result = await runSummary({ fresh: false });
assert.equal(result.requests.length, 1, 'entry cannot automatically recover previous full results');
assert.equal(result.shown.length, 0);
assert.equal(result.published.leagues.MLB.status, 'result_pending');
result = await runSummary({ switchLeague: true });
assert.equal(result.shown[0].game.league, 'NPB', 'late MLB result cannot overwrite selected NPB');
console.log('All-league result delivery: actual summary effect, four boards, failure isolation, manual entry and league switching PASS');

// Execute the real all-league click: one failed preflight must not block the
// healthy leagues or leave the visible board polling only the final summary.
const savedJobs = [], submittedJobs = [];
let publishedRun;
const noop = () => {};
const clickContext = {
  date, league: 'MLB', LEAGUE_IDS: ids,
  readerPollBusyRef: { current: false }, independentRunsRef: { current: new Map() },
  allLeagueBusyRef: { current: false }, operationBusyRef: { current: false }, allLeagueRunning: false,
  leagueDatesRef: { current: Object.fromEntries(ids.map(id => [id, date])) }, allLeagueRun: null,
  loadAllLeagueAnalysisRun: () => null, clearAllLeagueBackgroundJobs: noop,
  analysisGenerationRef: { current: 1 }, restoredBoardNeedsValidationRef: {}, manualAnalysisScopesRef: { current: new Set() },
  markAppOperationBusy: noop, setAllLeaguePreparing: noop, setError: noop, setNotice: noop,
  createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, publishAllLeagueRun: run => { publishedRun = run; },
  allLeagueTargetDate: async (_id, date) => date, clearBackgroundJob: noop,
  prepareAllLeagueBatch: async id => {
    if (id === 'NPB') throw Object.assign(new Error('盤口已過期'), { code: 'READER_STALE' });
    const result = batches.find(batch => batch.league === id);
    return { league: id, date, tasks: result.results.map(row => row.task), preparedBoard: [], emptyReason: null };
  },
  startBackgroundAnalysisJob: async input => { submittedJobs.push(input); return { runId: 'submitted-all-run' }; },
  submittedAllLeagueRunRef: {}, saveBackgroundJob: job => { savedJobs.push(job); return true; },
  currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date }, requestedRecoveryScopeRef: {},
  setBackgroundJobRevision: noop,
};
vm.createContext(clickContext);
vm.runInContext(page.slice(page.indexOf('  async function oneClickAnalyzeAll('), page.indexOf('  function recheckReaderItem(')), clickContext);
assert.equal(await clickContext.oneClickAnalyzeAll(), true);
assert.equal(submittedJobs[0].batches.length, 3);
assert.equal(savedJobs.length, 3);
assert.equal(clickContext.requestedRecoveryScopeRef.current, `MLB:${date}`, 'visible league must attach to incremental progress immediately');
assert.equal(publishedRun.leagues.NPB.message, '盤口已過期');
assert.equal(publishedRun.leagues.NPB.code, 'READER_STALE', 'diagnostic code remains available without prefixing user text');
assert.equal(publishedRun.leagues.MLB.status, 'running');
assert.equal(clickContext.allLeagueBusyRef.current, false);
console.log('PASS actual all-league click: failed Reader isolated, healthy jobs submitted, incremental polling attached and preparation lock released');
