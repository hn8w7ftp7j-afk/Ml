import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { reconcileInactiveIndependentRuns } from '../lib/independent-analysis-status.js';

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

// Execute the current all-league entry guard: finished inactive jobs stop
// blocking a new explicit all-league action, without starting any analysis here.
const start = page.indexOf('  async function oneClickAnalyzeAll()');
const guard = page.slice(start, page.indexOf('    const targetDate = ', start));
const run = job('NPB');
const runMap = new Map([[scope('NPB'), run]]);
const guardContext = vm.createContext({
  readerPollBusyRef: { current: false }, independentRunsRef: { current: runMap },
  allLeagueBusyRef: { current: false }, operationBusyRef: { current: false }, allLeagueRunning: false,
  nbaRunning: false,
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
  cleanText: value => String(value || ''), isLeagueId: value => ['MLB', 'NPB', 'KBO', 'CPBL'].includes(value),
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
  const owner = job('NPB');
  const calls = [];
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
    reconcileInactiveIndependentRuns, document,
    window: { setTimeout: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimeout: id => timers.delete(id) },
    requestJSON: (url, options, timeout) => { calls.push({ url, options, timeout }); return response.promise; },
    setIndependentRunRevision: () => renders++,
    setBoard: () => { throw new Error('summary effect must not write boards'); },
  });
  vm.runInContext(effectSource, context);
  return { cleanup: effect(), response, calls, owner, timers, listeners, document, renders: () => renders };
}
const foreground = effectHarness();
assert.equal(foreground.calls.length, 1);
assert.match(foreground.calls[0].url, /runId=run-NPB&summary=1/);
foreground.response.resolve(completed('NPB'));
await new Promise(setImmediate);
assert.equal(foreground.owner.status, 'completed');
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
hidden.cleanup();
console.log('PASS: inactive job completion/failure, owner and scope races, all-league unlocking, original recovery and compact single-league API summaries');
