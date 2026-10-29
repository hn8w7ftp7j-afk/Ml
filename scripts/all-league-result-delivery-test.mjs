import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { materializeAllLeagueResult } from '../lib/all-league-result-board.js';
import { ALL_LEAGUE_TERMINAL_STATUSES, allLeagueBoardDate, createAllLeagueAnalysisRun, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague, allLeagueStateForDisplay, allLeaguePreflightFailureState } from '../lib/all-league-analysis-v117.js';
import { ACTIVE_ANALYSIS_LEAGUE_IDS as ANALYSIS_LEAGUE_IDS, analysisLeagueIdsForRun, isSoccerAnalysisLeague } from '../lib/analysis-leagues.js';

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
async function runSummary({ fresh = true, failLeague = '', switchLeague = false, supersedeAt = '' } = {}) {
  const run = { runId: 'test-run-123', state: 'running', date, leagues: Object.fromEntries(ids.map(id => [id, { status: 'running', boardDate: date }])) };
  let effect, published, shown = [], requests = [], caches = new Map(), verifications = [];
  const context = {
    storageReady: true, date, allLeagueRun: run, allLeagueRunRef: { current: run },
    submittedAllLeagueRunRef: { current: fresh ? run.runId : null },
    allLeagueBoardsRef: { current: new Map() }, currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date }, boardRef: { current: [] },
    analysisGenerationRef: { current: 1 }, verifyCompletedBoard: async (board, league) => { verifications.push(league); return board; },
    ALL_LEAGUE_TERMINAL_STATUSES, LEAGUE_IDS: ids, analysisLeagueIdsForRun, isSoccerAnalysisLeague, useEffect: fn => { effect = fn; }, allLeagueBoardDate, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague, allLeagueStateForDisplay, allLeaguePreflightFailureState, materializeAllLeagueResult,
    requestJSON: async url => {
      requests.push(url);
      if (url.includes('summary=1')) {
        if (supersedeAt === 'summary') context.allLeagueRunRef.current = { ...run, runId: 'newer-run-456' };
        return { status: 'completed', result: { batches } };
      }
      const league = new URL(url, 'http://test').searchParams.get('league');
      if (supersedeAt === 'full') context.allLeagueRunRef.current = { ...run, runId: 'newer-run-456' };
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
  return { published, shown, requests, caches, boards: context.allLeagueBoardsRef.current, verifications };
}
let result = await runSummary();
assert.equal(result.requests.length, 5, 'summary must be followed by four full result reads');
assert.equal(result.caches.size, 4, 'all leagues persist without visiting each tab');
assert.equal(result.shown[0].game.league, 'MLB');
assert.deepEqual(result.verifications, ['MLB'], 'an explicitly started run may revalidate its currently selected league');
assert.ok(ids.every(id => result.published.leagues[id].resultLoaded));
result = await runSummary({ failLeague: 'NPB' });
assert.equal(result.published.leagues.NPB.status, 'result_pending');
assert.match(result.published.leagues.NPB.message, /network timeout/);
assert.equal(result.caches.size, 3, 'one unavailable result must not discard other leagues');
result = await runSummary({ fresh: false });
assert.equal(result.requests.length, 5, 'a restored run must read all four immutable completed results after its summary');
assert.equal(result.caches.size, 4);
assert.equal(result.boards.size, 4, 'reload must update every league reminder without visiting each tab');
assert.equal(result.shown[0].game.league, 'MLB', 'restored immutable data may be displayed on the current league');
assert.ok(ids.every(id => result.published.leagues[id].resultLoaded));
assert.equal(result.verifications.length, 0, 'restoring immutable results cannot trigger Reader verification or acquire execution authority');
assert.ok([...result.boards.values()].every(rows => rows.every(item => item.readerPayloadHash === null)));
result = await runSummary({ switchLeague: true });
assert.equal(result.shown[0].game.league, 'NPB', 'late MLB result cannot overwrite selected NPB');
assert.deepEqual(result.verifications, ['NPB'], 'only the selected league may acquire fresh execution evidence');
for (const supersedeAt of ['summary', 'full']) {
  result = await runSummary({ supersedeAt });
  assert.equal(result.published, undefined, `${supersedeAt}: an older response must not finish a newer run`);
  assert.equal(result.boards.size, 0);
  assert.equal(result.caches.size, 0, `${supersedeAt}: stale results must not enter the scoped cache`);
  assert.equal(result.shown.length, 0);
  assert.equal(result.verifications.length, 0);
  assert.equal(result.requests.length, supersedeAt === 'summary' ? 1 : 2);
}
console.log('All-league result delivery: four immutable boards after reload, Reader authority separation, failure isolation and newer-run/selection races PASS');

// Execute both real failure exits. A failure of the shared workflow cannot
// rewrite another league's completed research or missing-Reader prerequisite.
async function failedSummary(mode) {
  const leagues = {
    MLB: { status: 'running', boardDate: date, readerStatus: 'stale' },
    NPB: { status: 'queued', boardDate: date },
    KBO: { status: 'waiting_reader', code: 'READER_NOT_SYNCED', boardDate: date },
    CPBL: { status: 'failed', code: 'READER_SLATE_MISMATCH', boardDate: date, message: '官方場次不符' },
    NBA: { status: 'no_open_markets', readerStatus: 'stale', boardDate: date },
    EPL: { status: 'research', total: 2, completed: 2, boardDate: date },
    UCL: { status: 'insufficient_data', total: 1, blocked: 1, boardDate: date },
  };
  const run = { runId: 'workflow-failure-fixture', state: 'running', date, leagues };
  let effect, published, shownError = '', retryCount = 0;
  const cleared = [];
  const context = vm.createContext({
    storageReady: true, date, allLeagueRun: run, allLeagueRunRef: { current: run },
    ALL_LEAGUE_TERMINAL_STATUSES, analysisLeagueIdsForRun, allLeagueBoardDate, updateAllLeagueAnalysisLeague,
    useEffect: fn => { effect = fn; },
    requestJSON: async () => {
      if (mode === 'missing') throw Object.assign(new Error('Unknown workflow run'), { status: 404 });
      if (mode === 'temporary') throw Object.assign(new Error('temporary unavailable'), { status: 503 });
      return { status: mode };
    },
    loadAllLeagueAnalysisRun: () => run,
    clearBackgroundJob: (...args) => cleared.push(args),
    publishAllLeagueRun: value => { published = value; },
    setProgress() {}, setBackgroundJobRevision() {}, setError: value => { shownError = value; },
    window: { setTimeout: () => { retryCount++; }, clearTimeout() {} },
  });
  const failureStart = page.indexOf('function analysisFailureState(');
  const failureEnd = page.indexOf('\n}\n', failureStart);
  vm.runInContext(page.slice(failureStart, failureEnd + 3), context);
  vm.runInContext(page.slice(start, end), context);
  effect();
  await new Promise(resolve => setImmediate(resolve));
  return { run, published, shownError, cleared, retryCount };
}
for (const mode of ['failed', 'cancelled', 'missing']) {
  const failure = await failedSummary(mode);
  assert.equal(failure.published.state, 'completed');
  assert.equal(failure.published.leagues.MLB.status, 'failed', `${mode}: a real running failure remains failed even with old Reader state`);
  assert.equal(failure.published.leagues.NPB.status, 'failed');
  for (const league of ['KBO', 'CPBL', 'NBA', 'EPL', 'UCL']) {
    assert.deepEqual(failure.published.leagues[league], failure.run.leagues[league], `${mode}: terminal ${league} evidence remains untouched`);
  }
  assert.equal(allLeagueStateForDisplay(failure.published.leagues.CPBL).status, 'failed', 'genuine schedule mismatch cannot become waiting');
  assert.equal(allLeagueStateForDisplay(failure.published.leagues.NBA).status, 'waiting_reader', 'unchanged stale NBA preflight still means waiting for sync');
  assert.equal(failure.cleared.length, 7);
  assert.equal(failure.retryCount, 0);
  if (mode === 'missing') assert.match(failure.shownError, /已失效.*解鎖/);
}
const transient = await failedSummary('temporary');
assert.equal(transient.published, undefined, 'a temporary status-read error cannot declare the durable job failed');
assert.equal(transient.cleared.length, 0);
assert.equal(transient.retryCount, 1);
console.log('PASS actual summary failure exits: full terminal status preservation, genuine failures, 404 unlock and transient reconnect');

// Execute the real all-league click: one failed preflight must not block the
// healthy leagues or leave the visible board polling only the final summary.
const savedJobs = [], submittedJobs = [];
let publishedRun;
const noop = () => {};
const clickContext = {
  date, league: 'MLB', LEAGUE_IDS: ids, ANALYSIS_LEAGUE_IDS, isSoccerAnalysisLeague, nbaRunning: false, soccerRunning: false, nbaDate: date,
  readerPollBusyRef: { current: false }, independentRunsRef: { current: new Map() },
  allLeagueBusyRef: { current: false }, operationBusyRef: { current: false }, allLeagueRunning: false,
  leagueDatesRef: { current: Object.fromEntries(ids.map(id => [id, date])) }, allLeagueRun: null,
  loadAllLeagueAnalysisRun: () => null, clearAllLeagueBackgroundJobs: noop,
  analysisGenerationRef: { current: 1 }, restoredBoardNeedsValidationRef: {}, manualAnalysisScopesRef: { current: new Set() },
  markAppOperationBusy: noop, setAllLeaguePreparing: noop, setError: noop, setNotice: noop,
  createAllLeagueAnalysisRun, updateAllLeagueAnalysisLeague, allLeagueStateForDisplay, allLeaguePreflightFailureState, publishAllLeagueRun: run => { publishedRun = run; },
  allLeagueTargetDate: async (_id, date) => date, clearBackgroundJob: noop,
  prepareSoccerBatch: async (id, date) => ({ league: id, date, tasks: [], preparedBoard: [], emptyReason: 'no_games' }),
  prepareNhlBatch: async date => ({ league: 'NHL', date, tasks: [], preparedBoard: [], emptyReason: 'no_games' }),
  prepareNbaBatch: async date => ({ league: 'NBA', date, tasks: [], preparedBoard: [], emptyReason: 'no_open_markets' }),
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
const clickStart = page.indexOf('  async function oneClickAnalyzeAll(');
const clickEnd = page.indexOf('\n  }\n', clickStart);
assert.ok(clickStart >= 0 && clickEnd > clickStart);
vm.runInContext(page.slice(clickStart, clickEnd + 4), clickContext);
assert.equal(await clickContext.oneClickAnalyzeAll(), true);
assert.equal(submittedJobs[0].batches.length, 6);
assert.equal(savedJobs.length, 3);
assert.equal(clickContext.requestedRecoveryScopeRef.current, `MLB:${date}`, 'visible league must attach to incremental progress immediately');
assert.equal(publishedRun.leagues.NPB.message, '盤口已過期');
assert.equal(publishedRun.leagues.NPB.code, 'READER_STALE', 'diagnostic code remains available without prefixing user text');
assert.equal(publishedRun.leagues.NPB.status, 'waiting_reader', 'an unavailable Reader is a waiting prerequisite while healthy leagues continue');
assert.equal(publishedRun.leagues.MLB.status, 'queued', 'submission alone does not establish running status');
assert.equal(clickContext.allLeagueBusyRef.current, false);
console.log('PASS actual all-league click: failed Reader isolated, healthy jobs submitted, incremental polling attached and preparation lock released');
