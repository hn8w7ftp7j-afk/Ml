import { isAnalysisLeagueId } from '../lib/analysis-leagues.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reconcileInactiveIndependentRuns } from '../lib/independent-analysis-status.js';
import { materializeAllLeagueResult } from '../lib/all-league-result-board.js';
import { analysisItemMatchesScope } from '../lib/analysis-completed-receipt-v1.js';

const date = '2026-10-01';
const scope = league => `${league}:${date}`;
const job = league => ({ runId: `run-${league}`, status: 'running', message: '分析中' });
const completed = league => ({ runId: `run-${league}`, status: 'completed', result: { league, date, total: 1, completed: 1 } });
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

const jobs = new Map([['MLB', job('MLB')], ['NPB', job('NPB')], ['KBO', job('KBO')], ['CPBL', job('CPBL')]].map(([league, run]) => [scope(league), run]));
const visibleBoard = [{ game: { gamePk: 99, leagueId: 'MLB' }, status: 'done' }];
const originalBoard = structuredClone(visibleBoard);
const reads = [];
const changed = await reconcileInactiveIndependentRuns(jobs, {
  getVisibleScope: () => scope('MLB'),
  readStatus: async runId => {
    reads.push(runId);
    if (runId === 'run-NPB') return completed('NPB');
    if (runId === 'run-KBO') return { runId, status: 'failed' };
    return { runId, status: 'running' };
  },
});
assert.equal(changed, 2);
assert.deepEqual(reads.sort(), ['run-CPBL', 'run-KBO', 'run-NPB']);
assert.equal(jobs.get(scope('MLB')).status, 'running', 'selected league keeps its foreground owner');
assert.equal(jobs.get(scope('NPB')).status, 'completed');
assert.equal(jobs.get(scope('NPB')).needsRecovery, true, 'completion alone cannot claim that results or prices were loaded');
assert.equal(jobs.get(scope('KBO')).status, 'failed');
assert.equal(jobs.get(scope('CPBL')).status, 'running');
assert.deepEqual(visibleBoard, originalBoard, 'summary reconciliation does not write any board');

function deferred() { let resolve; return { promise: new Promise(value => { resolve = value; }), resolve: value => resolve(value) }; }
for (const race of ['replaced-owner', 'changed-run', 'became-visible', 'effect-disposed']) {
  const owner = job('NPB');
  const runs = new Map([[scope('NPB'), owner]]);
  let visible = scope('MLB');
  let active = true;
  const response = deferred();
  const pending = reconcileInactiveIndependentRuns(runs, {
    getVisibleScope: () => visible,
    isActive: () => active,
    readStatus: () => response.promise,
  });
  if (race === 'replaced-owner') runs.set(scope('NPB'), { ...owner });
  if (race === 'changed-run') owner.runId = 'run-newer';
  if (race === 'became-visible') visible = scope('NPB');
  if (race === 'effect-disposed') active = false;
  response.resolve(completed('NPB'));
  assert.equal(await pending, 0, race);
  assert.equal(runs.get(scope('NPB')).status, 'running', race);
}

for (const wrong of [
  { ...completed('NPB'), runId: 'run-other' },
  { ...completed('NPB'), result: { ...completed('NPB').result, league: 'KBO' } },
  { ...completed('NPB'), result: { ...completed('NPB').result, date: '2026-09-30' } },
]) {
  const runs = new Map([[scope('NPB'), job('NPB')]]);
  assert.equal(await reconcileInactiveIndependentRuns(runs, { getVisibleScope: () => scope('MLB'), readStatus: async () => wrong }), 0);
  assert.equal(runs.get(scope('NPB')).status, 'running');
}
for (const status of ['cancelled', 404, 503]) {
  const runs = new Map([[scope('NPB'), job('NPB')]]);
  const count = await reconcileInactiveIndependentRuns(runs, {
    getVisibleScope: () => scope('MLB'),
    readStatus: async runId => {
      if (typeof status === 'number') throw Object.assign(new Error('unavailable'), { status });
      return { runId, status };
    },
  });
  assert.equal(count, status === 503 ? 0 : 1);
  assert.equal(runs.get(scope('NPB')).status, status === 503 ? 'running' : 'failed');
}

// A finished inactive job may install immutable display results without ever
// granting the selected league's Reader execution authority.
const fullCompleted = league => ({
  ...completed(league),
  result: { ...completed(league).result, results: [{ ok: true, payload: { analysis: { marker: 'new-result' } } }] },
});
{
  const owner = job('NPB');
  const runs = new Map([[scope('NPB'), owner]]);
  const displayBoards = new Map([[scope('NPB'), [{ marker: 'earlier-board', readerPayloadHash: null }]]]);
  const calls = [];
  const count = await reconcileInactiveIndependentRuns(runs, {
    getVisibleScope: () => scope('MLB'), readStatus: async () => completed('NPB'),
    readCompletedResult: async (...args) => { calls.push(args); return fullCompleted('NPB'); },
    onCompleted: value => {
      assert.equal(value.scope, scope('NPB'));
      assert.equal(value.runId, owner.runId);
      assert.equal(value.league, 'NPB');
      assert.equal(value.date, date);
      assert.equal(value.owner, owner);
      assert.deepEqual(value.result, fullCompleted('NPB').result);
      displayBoards.set(value.scope, value.result.results);
    },
  });
  assert.equal(count, 1);
  assert.deepEqual(calls, [['run-NPB', 'NPB', date]]);
  assert.equal(owner.status, 'completed');
  assert.equal(owner.resultLoaded, true);
  assert.equal(owner.message, '分析完成');
  assert.equal(owner.needsRecovery, true, 'display result loading must still require foreground Reader revalidation');
  assert.equal(displayBoards.get(scope('NPB'))[0].payload.analysis.marker, 'new-result');
  await reconcileInactiveIndependentRuns(runs, {
    getVisibleScope: () => scope('MLB'),
    readStatus: () => { throw Error('already-loaded completion must not be repolled'); },
    readCompletedResult: () => { throw Error('already-loaded results must not be downloaded twice'); },
    onCompleted: () => { throw Error('already-loaded display board must not be overwritten'); },
  });
}

for (const race of ['newer-owner', 'newer-run', 'became-visible', 'effect-disposed']) {
  const owner = job('NPB');
  const runs = new Map([[scope('NPB'), owner]]);
  const earlierBoard = [{ marker: 'earlier-board' }];
  let displayBoard = earlierBoard;
  let visible = scope('MLB'), active = true;
  const downloaded = deferred();
  let fullReads = 0, installations = 0;
  const pending = reconcileInactiveIndependentRuns(runs, {
    getVisibleScope: () => visible, isActive: () => active,
    readStatus: async () => completed('NPB'),
    readCompletedResult: () => { fullReads++; return downloaded.promise; },
    onCompleted: ({ result }) => { installations++; displayBoard = result.results; },
  });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(fullReads, 1, 'completed summary must start immutable result retrieval');
  assert.equal(owner.status, 'completed');
  assert.equal(owner.resultLoaded, false);
  assert.equal(displayBoard, earlierBoard, 'an unresolved result cannot replace the earlier board');
  if (race === 'newer-owner') runs.set(scope('NPB'), { ...job('NPB'), runId: 'new-owner' });
  if (race === 'newer-run') owner.runId = 'new-run';
  if (race === 'became-visible') visible = scope('NPB');
  if (race === 'effect-disposed') active = false;
  downloaded.resolve(fullCompleted('NPB'));
  assert.equal(await pending, 0, race);
  assert.equal(installations, 0, `${race} must discard a late full-result response`);
  assert.equal(displayBoard, earlierBoard);
  assert.notEqual(owner.resultLoaded, true);
}

for (const failedResult of [
  null,
  { ...fullCompleted('NPB'), runId: 'other-run' },
  { ...fullCompleted('NPB'), status: 'running' },
  { ...fullCompleted('NPB'), result: { ...fullCompleted('NPB').result, league: 'KBO' } },
  { ...fullCompleted('NPB'), result: { ...fullCompleted('NPB').result, date: '2026-09-30' } },
  { ...fullCompleted('NPB'), result: { league: 'NPB', date } },
]) {
  const owner = job('NPB');
  const runs = new Map([[scope('NPB'), owner]]);
  let installed = false;
  const options = {
    getVisibleScope: () => scope('MLB'), readStatus: async () => completed('NPB'),
    readCompletedResult: async () => {
      if (failedResult === null) throw Error('temporary download failure');
      return failedResult;
    },
    onCompleted: () => { installed = true; },
  };
  assert.equal(await reconcileInactiveIndependentRuns(runs, options), 1);
  assert.equal(installed, false, 'failed or mismatched result must not replace an earlier board');
  assert.equal(owner.status, 'completed', 'a result-download failure is not an analysis failure');
  assert.equal(owner.needsRecovery, true);
  assert.equal(owner.resultLoaded, false);
  assert.equal(owner.message, '分析完成｜結果待載入');
  assert.equal(await reconcileInactiveIndependentRuns(runs, options), 0,
    'an unchanged pending download failure must wait for the normal timer instead of triggering an immediate revision retry loop');
  assert.equal(await reconcileInactiveIndependentRuns(runs, {
    ...options,
    readStatus: () => { throw Error('a known completed job retries the result without repeating summary discovery'); },
    readCompletedResult: async () => fullCompleted('NPB'),
  }), 1);
  assert.equal(installed, true, 'a later successful immutable result fetch must recover without reanalysis');
  assert.equal(owner.resultLoaded, true);
  assert.equal(owner.needsRecovery, true);
}

// Execute the current all-league entry guard: finished inactive jobs stop
// blocking a new explicit all-league action, without starting any analysis here.
const start = page.indexOf('  async function oneClickAnalyzeAll(');
assert.ok(start >= 0, 'actual all-league guard must be extracted');
const guard = page.slice(start, page.indexOf('    const targetDate = ', start));
const run = job('NPB');
const runMap = new Map([[scope('NPB'), run]]);
const guardContext = vm.createContext({
  readerPollBusyRef: { current: false }, independentRunsRef: { current: runMap },
  allLeagueBusyRef: { current: false }, operationBusyRef: { current: false }, allLeagueRunning: false,
  nbaRunning: false, soccerRunning: false,
  setNotice() {},
});
vm.runInContext(`${guard}\nreturn true; }`, guardContext);
assert.equal(await guardContext.oneClickAnalyzeAll(), false);
await reconcileInactiveIndependentRuns(runMap, { getVisibleScope: () => scope('MLB'), readStatus: async () => completed('NPB') });
assert.equal(await guardContext.oneClickAnalyzeAll(), true, 'completed server jobs cannot leave the all-league guard stuck');

const noop = () => {};
const navigationContext = vm.createContext({
  league: 'MLB', date, gamePickerRequestRef: { current: 0 }, setGamePicker: noop,
  normalizeLeagueId: value => value, allLeagueRun: null,
  allLeagueBoardDate: (_run, _league, fallback) => fallback,
  leagueDatesRef: { current: { NPB: date } }, independentRunsRef: { current: runMap },
  operationBusyRef: { current: false }, markAppOperationBusy: noop, setBusy: noop, setProgress: noop,
  queuedAnalysisRef: {}, setQueuedAnalysis: noop, requestedRecoveryScopeRef: {},
  currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date },
  analysisGenerationRef: { current: 0 }, boardRef: { current: originalBoard },
  setBoard: noop, setSchedule: noop, setError: noop, setNotice: noop, setTab: noop, setLeague: noop, setDate: noop,
});
vm.runInContext(page.slice(page.indexOf('  function selectLeague('), page.indexOf('  return <main className="appShell">')), navigationContext);
navigationContext.selectLeague('NPB');
assert.equal(navigationContext.requestedRecoveryScopeRef.current, scope('NPB'), 'returning to a completed inactive job still attaches its original result');
assert.equal(runMap.get(scope('NPB')).runId, 'run-NPB');

// Run the actual API handler to check that a single-league summary is compact,
// while the normal foreground response retains the original immutable result.
const routeSource = fs.readFileSync(new URL('../app/api/analysis-jobs/route.js', import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const full = { ok: true, league: 'NPB', date, total: 1, completed: 1,
  results: [{ ok: true, status: 200, task: { game: { gamePk: 88 } }, payload: { analysis: { proof: 'x'.repeat(100_000) } } }] };
const route = vm.createContext({
  Request, Response, URL, NextResponse: Response, requireApiAuth: async () => null,
  cleanText: value => String(value || ''), isAnalysisLeagueId,
  getRun: () => ({ exists: true, status: 'completed', returnValue: full }),
  console: { info() {} },
});
vm.runInContext(strip(routeSource), route);
const summaryResponse = await route.GET(new Request('https://site.invalid/api/analysis-jobs?runId=run-test&summary=1'));
assert.equal(summaryResponse.status, 200);
const summaryText = await summaryResponse.text();
assert.ok(summaryText.length < 1000, 'inactive polling omits the large analysis payload');
const summary = JSON.parse(summaryText);
assert.equal(summary.result.league, 'NPB');
assert.equal(summary.result.date, date);
assert.equal(summary.result.results[0].payload, undefined);
const normal = await (await route.GET(new Request('https://site.invalid/api/analysis-jobs?runId=run-test&league=NPB'))).json();
assert.deepEqual(normal.result, full);

// Execute the actual React effect body with controlled visibility, timer and
// lifecycle boundaries; an old request cannot update state after cleanup.
const marker = page.indexOf('await reconcileInactiveIndependentRuns(independentRunsRef.current');
const effectSource = page.slice(page.lastIndexOf('  useEffect(() => {', marker), page.indexOf('  useEffect(() => {', marker));
function effectHarness(visibility = 'visible') {
  let effect;
  let timerId = 0;
  let renders = 0;
  const timers = new Map();
  const listeners = new Map();
  const response = deferred();
  const fullResponse = deferred();
  const owner = job('NPB');
  const calls = [];
  const cacheWrites = [], receipts = [];
  const game = { gamePk: 88, league: 'NPB', date, gameDate: `${date}T10:00:00Z`, awayTeamId: 10, homeTeamId: 20 };
  const earlierBoard = [{ game, customData: { game, analysis: { results: [{ marker: 'earlier' }] } }, readerPayloadHash: null }];
  const boards = new Map([[scope('NPB'), earlierBoard]]);
  const full = { ...completed('NPB'), result: { ...completed('NPB').result,
    results: [{ ok: true, task: { game, readerPayloadHash: 'historical-source' },
      payload: { game, analysis: { results: [{ marker: 'newest', score: 8 }] } } }],
  } };
  const document = {
    visibilityState: visibility,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
  };
  const context = vm.createContext({
    useEffect: callback => { effect = callback; }, storageReady: true,
    league: 'MLB', date, independentRunRevision: 0,
    independentRunsRef: { current: new Map([[scope('NPB'), owner]]) },
    currentLeagueRef: { current: 'MLB' }, currentDateRef: { current: date },
    reconcileInactiveIndependentRuns, document, allLeagueBoardsRef: { current: boards },
    loadAnalysisBoardCache: () => [], materializeAllLeagueResult, compactAnalysisData: value => value,
    analysisItemMatchesScope,
    saveCompletedAnalysisReceipt: (...args) => { receipts.push(args); return { completed: 1, stored: true }; },
    saveAnalysisBoardCache: (...args) => cacheWrites.push(args),
    window: { setTimeout: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimeout: id => timers.delete(id) },
    requestJSON: (url, options, timeout) => { calls.push({ url, options, timeout }); return url.includes('summary=1') ? response.promise : fullResponse.promise; },
    setIndependentRunRevision: () => renders++,
    setBoard: () => { throw new Error('summary effect must not write boards'); },
  });
  vm.runInContext(effectSource, context);
  return { cleanup: effect(), response, fullResponse, full, context, boards, earlierBoard,
    cacheWrites, receipts, calls, owner, timers, listeners, document, renders: () => renders };
}
const foreground = effectHarness();
assert.equal(foreground.calls.length, 1);
assert.match(foreground.calls[0].url, /runId=run-NPB&summary=1/);
foreground.response.resolve(completed('NPB'));
await new Promise(setImmediate);
assert.equal(foreground.owner.status, 'completed');
assert.equal(foreground.calls.length, 2, 'the actual inactive effect must download the completed immutable result');
assert.match(foreground.calls[1].url, /runId=run-NPB&league=NPB$/);
assert.equal(foreground.boards.get(scope('NPB')), foreground.earlierBoard, 'unfinished result download must retain the earlier board');
assert.equal(foreground.renders(), 0, 'completion notification waits for the display result installation');
foreground.fullResponse.resolve(foreground.full);
await new Promise(setImmediate);
assert.equal(foreground.owner.resultLoaded, true);
assert.equal(foreground.owner.needsRecovery, true);
assert.equal(foreground.boards.get(scope('NPB'))[0].customData.analysis.results[0].marker, 'newest');
assert.equal(foreground.boards.get(scope('NPB'))[0].readerPayloadHash, null, 'inactive result installation cannot grant live Reader authority');
assert.equal(foreground.cacheWrites.length, 1);
assert.equal(foreground.receipts[0][0].runId, 'run-NPB');
assert.equal(foreground.renders(), 1);
assert.equal([...foreground.timers.values()][0].ms, 15000);
foreground.cleanup();
assert.equal(foreground.timers.size, 0);

const disposed = effectHarness();
disposed.cleanup();
disposed.response.resolve(completed('NPB'));
await new Promise(setImmediate);
assert.equal(disposed.owner.status, 'running');
assert.equal(disposed.renders(), 0);
assert.equal(disposed.timers.size, 0);

const hidden = effectHarness('hidden');
assert.equal(hidden.calls.length, 0, 'hidden app does not poll inactive jobs');
hidden.document.visibilityState = 'visible';
hidden.listeners.get('visibilitychange')();
assert.equal(hidden.calls.length, 1, 'returning to the app checks inactive status immediately');
hidden.response.resolve(completed('NPB'));
await new Promise(setImmediate);
assert.equal(hidden.owner.status, 'completed');
hidden.fullResponse.resolve(hidden.full);
await new Promise(setImmediate);
assert.equal(hidden.owner.resultLoaded, true);
hidden.cleanup();

for (const race of ['newer-owner', 'newer-run', 'became-visible', 'effect-disposed']) {
  const late = effectHarness();
  late.response.resolve(completed('NPB'));
  await new Promise(setImmediate);
  assert.equal(late.calls.length, 2);
  if (race === 'newer-owner') late.context.independentRunsRef.current.set(scope('NPB'), { ...job('NPB'), runId: 'new-owner' });
  if (race === 'newer-run') late.owner.runId = 'new-run';
  if (race === 'became-visible') late.context.currentLeagueRef.current = 'NPB';
  if (race === 'effect-disposed') late.cleanup();
  late.fullResponse.resolve(late.full);
  await new Promise(setImmediate);
  assert.equal(late.boards.get(scope('NPB')), late.earlierBoard, `${race} must prevent the actual callback from installing a late board`);
  assert.equal(late.cacheWrites.length, 0);
  assert.equal(late.receipts.length, 0);
  assert.notEqual(late.owner.resultLoaded, true);
  if (race !== 'effect-disposed') late.cleanup();
}
const failedDownload = effectHarness();
failedDownload.response.resolve(completed('NPB'));
await new Promise(setImmediate);
failedDownload.fullResponse.resolve({ ...failedDownload.full, result: { ...failedDownload.full.result, date: '2026-09-30' } });
await new Promise(setImmediate);
assert.equal(failedDownload.owner.resultLoaded, false);
assert.equal(failedDownload.owner.status, 'completed');
assert.equal(failedDownload.boards.get(scope('NPB')), failedDownload.earlierBoard);
assert.equal(failedDownload.cacheWrites.length, 0);
failedDownload.cleanup();
console.log('PASS: inactive result delivery, immutable board cache/receipt loading, late owner/scope protections, failed-fetch recovery, all-league unlocking and compact summaries');
