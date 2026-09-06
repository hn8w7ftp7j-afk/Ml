import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual page function with deferred, isolated transport responses.
// These scenarios stop at schedule/Reader loading; no analysis or wager API,
// browser account, persistent storage, or Production endpoint is contacted.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const start = page.indexOf('  async function oneClickAnalyze(');
const end = page.indexOf('\n  }\n', start);
assert.ok(start >= 0 && end > start);
const source = page.slice(start, end + 4);
let groups = 0;
const test = async (name, run) => { await run(); groups += 1; console.log(`PASS ${name}`); };
const DATE = '2026-08-30';
const game = { gamePk: 501001, league: 'NPB', leagueId: 'NPB', gameDate: `${DATE}T10:00:00Z` };
const card = (tag = 'original') => ({ game, status: 'running', statusLabel: tag,
  actualSource: { provider: 'TAI888_READER_AUTO' },
  customData: { analysis: { snapshotId: tag, results: [] } }, readerPayloadHash: tag });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(stage = 'schedule') {
  const gate = deferred();
  const state = { board: [card()], error: '', notice: '', progress: {}, releases: 0,
    scheduleRequests: 0, creditRequests: 0, busy: false };
  const set = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const context = vm.createContext({
    Map, Set, Number, String, Boolean, Date, JSON, console,
    league: 'NPB', date: DATE, activeLeague: { id: 'NPB', label: '日本職棒', shortLabel: '日棒' },
    allLeagueRunning: false, analysisEnabled: true,
    readerPollBusyRef: { current: false }, queuedAnalysisRef: { current: null },
    boardRef: { current: state.board }, manualAnalysisScopesRef: { current: new Set() },
    restoredBoardNeedsValidationRef: { current: false }, analysisGenerationRef: { current: 1 },
    currentDateRef: { current: DATE },
    setQueuedAnalysis: () => {}, setTab: () => {},
    setError: set('error'), setNotice: set('notice'), setBoard: set('board'), setProgress: set('progress'),
    loadBackgroundJob: () => null,
    acquireOperation: () => { if (state.busy) return false; state.busy = true; return true; },
    releaseOperation: () => { state.busy = false; state.releases += 1; },
    fetchSchedule: () => { state.scheduleRequests += 1; return stage === 'schedule' ? gate.promise : Promise.resolve([game]); },
    requestJSONWithTransientRetry: () => { state.creditRequests += 1; return gate.promise; },
    uid: () => 'isolated-request-id', ANALYSIS_TRANSIENT_RETRY_DELAYS_MS: [],
  });
  vm.runInContext(source, context);
  return { context, state, gate };
}

function switchBoard(harness, type) {
  if (type === 'generation') harness.context.analysisGenerationRef.current += 1;
  else harness.context.currentDateRef.current = '2026-08-31';
  const replacement = [card('newly-selected-board')];
  harness.state.board = replacement;
  harness.context.boardRef.current = replacement;
  harness.state.error = 'new-board-message';
  harness.state.notice = 'new-board-notice';
  harness.state.progress = { active: true, running: 1, label: 'new-board-work' };
  return JSON.stringify(harness.state);
}

for (const stage of ['schedule', 'credit']) {
  for (const scope of ['generation', 'date']) {
    await test(`late ${stage} failure after ${scope} change cannot overwrite or unlock the active board`, async () => {
      const h = harness(stage);
      const pending = h.context.oneClickAnalyze();
      await new Promise(setImmediate);
      assert.equal(stage === 'credit' ? h.state.creditRequests : h.state.scheduleRequests, 1);
      const activeState = switchBoard(h, scope);
      h.gate.reject(new Error('old request timed out'));
      assert.equal(await pending, false);
      assert.equal(JSON.stringify(h.state), activeState);
    });
  }
}

await test('a successful old schedule response detaches before sending a Reader request', async () => {
  const h = harness();
  const pending = h.context.oneClickAnalyze();
  const activeState = switchBoard(h, 'generation');
  h.gate.resolve([game]);
  assert.equal(await pending, false);
  assert.equal(JSON.stringify(h.state), activeState);
  assert.equal(h.state.creditRequests, 0);
});

await test('a current request failure remains visible and releases controls for retry', async () => {
  const h = harness();
  const pending = h.context.oneClickAnalyze();
  h.gate.reject(new Error('current schedule temporarily unavailable'));
  assert.equal(await pending, false);
  assert.match(h.state.error, /current schedule temporarily unavailable/);
  assert.equal(h.state.board[0].status, 'failed');
  assert.equal(h.state.board[0].customData.analysis.snapshotId, 'original');
  assert.equal(h.state.releases, 1);
  assert.equal(h.state.busy, false);
  assert.equal(h.state.progress.active, false);
});

await test('two fast analyze clicks create one request while the first request owns the operation', async () => {
  const h = harness();
  const first = h.context.oneClickAnalyze();
  assert.equal(await h.context.oneClickAnalyze(), false);
  assert.equal(h.state.scheduleRequests, 1);
  h.gate.reject(new Error('isolated expected failure'));
  await first;
  assert.equal(h.state.releases, 1);
});

await test('a detached Reader poll releases its lock without consuming another league\'s queued analyze click', async () => {
  const at = page.indexOf('  async function pollReaderAndReprice(');
  const to = page.indexOf('\n  }\n', at);
  assert.ok(at >= 0 && to > at);
  const gate = deferred();
  const queue = { league: 'CPBL', date: DATE };
  const state = { readerPolling: false, queue, launches: 0 };
  const context = vm.createContext({
    date: DATE, league: 'NPB', allLeagueRunning: false,
    operationBusyRef: { current: false }, readerPollBusyRef: { current: false },
    allLeagueBusyRef: { current: false }, boardRef: { current: [card()] },
    analysisGenerationRef: { current: 1 }, currentDateRef: { current: DATE },
    currentLeagueRef: { current: 'NPB' }, queuedAnalysisRef: { current: queue },
    markAppOperationBusy: () => {},
    setReaderPolling: value => { state.readerPolling = value; },
    setQueuedAnalysis: value => { state.queue = value; },
    oneClickAnalyze: () => { state.launches += 1; },
    requestJSON: () => gate.promise, encodeURIComponent, Date,
  });
  vm.runInContext(page.slice(at, to + 4), context);
  const pending = context.pollReaderAndReprice();
  context.analysisGenerationRef.current = 2;
  context.currentLeagueRef.current = 'CPBL';
  gate.resolve({ fresh: false });
  await pending;
  assert.equal(context.readerPollBusyRef.current, false);
  assert.equal(state.readerPolling, false);
  assert.deepEqual(context.queuedAnalysisRef.current, queue,
    'the active render must retain and drain its own queued request; the detached poll cannot discard it');
  assert.deepEqual(state.queue, queue);
  assert.equal(state.launches, 0, 'the old league closure must never execute the new league request');
});

await test('the active render waits for the Reader lock, then drains its queued click exactly once', async () => {
  const anchor = page.indexOf('// A previous league\'s poll');
  const from = page.lastIndexOf('useEffect(() => {', anchor) + 'useEffect(() => {'.length;
  const to = page.indexOf('\n  }, [queuedAnalysis,', from);
  assert.ok(anchor >= 0 && to > from);
  const queue = { league: 'CPBL', date: DATE };
  const launches = [];
  const context = vm.createContext({
    queuedAnalysis: queue, queuedAnalysisRef: { current: queue },
    readerPolling: true, readerPollBusyRef: { current: true }, busy: false,
    operationBusyRef: { current: false }, allLeaguePreparing: false, allLeagueRunning: false,
    analysisEnabled: true, league: 'CPBL', date: DATE,
    setQueuedAnalysis: () => {},
    oneClickAnalyze: () => { launches.push('CPBL'); },
  });
  vm.runInContext(`function drainQueuedAnalysis() {${page.slice(from, to)}\n}`, context);
  context.drainQueuedAnalysis();
  assert.equal(launches.length, 0);
  context.readerPolling = false;
  context.readerPollBusyRef.current = false;
  context.drainQueuedAnalysis();
  assert.deepEqual(launches, ['CPBL']);
  assert.equal(context.queuedAnalysisRef.current, null);
  context.drainQueuedAnalysis();
  assert.equal(launches.length, 1, 'the same queued click cannot be consumed twice');
});

await test('server-required core refresh queues one rebuild only while the request still owns the current Reader evidence', async () => {
  const at = page.indexOf('        } catch (cause) {', page.indexOf("requestJSON('/api/reprice'"));
  const from = at + '        } catch (cause) {'.length;
  const to = page.indexOf('\n        }\n      });', from);
  assert.ok(at >= 0 && to > from);
  for (const scenario of [
    { name: 'expired or incompatible core', current: true, evidence: true, status: 409, code: 'CORE_REFRESH_REQUIRED', rebuild: true },
    { name: 'detached old request', current: false, evidence: true, status: 409, code: 'CORE_REFRESH_REQUIRED', rebuild: false },
    { name: 'changed Reader evidence', current: true, evidence: false, status: 409, code: 'CORE_REFRESH_REQUIRED', rebuild: false },
    { name: 'other conflict', current: true, evidence: true, status: 409, code: 'OTHER_CONFLICT', rebuild: false },
    { name: 'different status', current: true, evidence: true, status: 422, code: 'CORE_REFRESH_REQUIRED', rebuild: false },
  ]) {
    const original = card('immutable-previous');
    const rebuildTask = { game, readerPayloadHash: 'current-reader', actualMarkets: [] };
    const boardRef = { current: [original] };
    const snapshots = { current: new Map([[game.gamePk, { signature: 'previous-signed-core' }]]) };
    const rebuildTasks = [];
    const context = vm.createContext({
      item: original, rebuildTask, boardRef, snapshots, rebuildTasks, Number,
      failed: 0, blocked: 0,
      stillCurrent: () => scenario.current,
      taskReaderStateIsStale: () => !scenario.evidence,
      directRepriceAuthorityMatches: () => scenario.evidence,
      updateBoard: (pk, updater) => { boardRef.current = boardRef.current.map(item => item.game.gamePk === pk ? updater(item) : item); },
      analysisFailureState: () => ({ blocked: false }), commitAnalysisFailure: () => {},
    });
    vm.runInContext(`function handleRepriceFailure(cause) {${page.slice(from, to)}\n}`, context);
    context.handleRepriceFailure(Object.assign(new Error(scenario.name), { status: scenario.status, code: scenario.code }));
    assert.equal(rebuildTasks.length, scenario.rebuild ? 1 : 0, scenario.name);
    assert.equal(snapshots.current.has(game.gamePk), !scenario.rebuild, scenario.name);
    assert.equal(boardRef.current[0].customData, original.customData, 'the prior immutable display is never rewritten by refresh scheduling');
    if (scenario.rebuild) {
      assert.equal(rebuildTasks[0], rebuildTask);
      assert.equal(boardRef.current[0].readerPayloadHash, null);
      assert.equal(boardRef.current[0].pendingReaderAnalysis, true);
      assert.match(boardRef.current[0].statusLabel, /重新取得資料/);
    }
  }
});

console.log(`Analysis request scope: ${groups} executable failure/success/navigation/double-click groups PASS.`);
