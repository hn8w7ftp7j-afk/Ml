import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const results = new Map();
let status = 'running';
let returned;
let authorized = true;
const route = vm.createContext({
  Request, Response, URL, NextResponse: Response,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }),
  cleanText: v => String(v || ''), isLeagueId: v => ['NPB', 'CPBL', 'MLB', 'KBO'].includes(v),
  getRun: () => ({ exists: true, status, get returnValue() { assert.equal(status, 'completed'); return returned; } }),
  getNotificationResult: async id => results.get(id),
});
vm.runInContext(strip(read('app/api/analysis-jobs/route.js')) + '\nthis.get = GET;', route);
const get = async (query = '') => route.get(new Request(`https://example.test/api/analysis-jobs?runId=run-test${query}`));
let pushes = 0;
let storageFails = false;
let pushFails = false;
const workflow = vm.createContext({
  Request, FatalError: Error, RetryableError: Error,
  getWorkflowMetadata: () => ({ workflowRunId: 'run-test' }),
  createBackgroundAnalysisAuthorization: async () => ({ timestamp: '1', signature: 'test' }),
  analyzeRequest: async () => Response.json({ ok: true }),
  completionMessage: (id, result) => ({ id, result }),
  saveNotificationResult: async (id, result) => {
    if (storageFails) throw Error('database unavailable');
    results.set(id, JSON.parse(JSON.stringify(result)));
  },
  sendPush: async (device, message) => {
    pushes++;
    // Reproduce tapping the notification before the original workflow returns.
    assert.equal(status, 'running');
    const response = await get();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'completed');
    assert.deepEqual(body.result, JSON.parse(JSON.stringify(message.result)));
    if (pushFails) throw Error('push unavailable');
    return { status: 'sent' };
  },
});
vm.runInContext(strip(read('workflows/analyze-board.js')) + '\nthis.board=analyzeBoardWorkflow; this.all=analyzeAllLeaguesWorkflow;', workflow);
const batch = { league: 'NPB', date: '2026-09-23', tasks: [{ body: {}, requestId: 'test', game: { gamePk: 1 } }] };
await workflow.board({ ...batch, pushDevice: 'device' });
assert.equal(pushes, 1);
results.clear();
returned = await workflow.all({ date: batch.date, pushDevice: 'device', batches: [batch, { ...batch, league: 'CPBL' }] });
assert.equal(pushes, 2);
assert.equal((await (await get('&league=CPBL')).json()).result.league, 'CPBL');
assert.equal((await (await get('&summary=1')).json()).result.batches.length, 2);
assert.equal((await get('&league=KBO')).status, 404);
authorized = false;
assert.equal((await get()).status, 401);
authorized = true;
results.clear(); storageFails = true;
assert.equal((await workflow.board({ ...batch, pushDevice: 'device' })).notification.status, 'failed');
assert.equal(pushes, 2, 'never announce completion when result persistence failed');
assert.equal((await (await get()).json()).status, 'running');
storageFails = false; pushFails = true;
assert.equal((await workflow.board({ ...batch, pushDevice: 'device' })).completed, 1);
assert.equal((await (await get()).json()).status, 'completed', 'push retry cannot hide a ready result');
status = 'completed'; results.clear();
assert.equal((await (await get()).json()).result.batches.length, 2, 'legacy completed runs retain workflow fallback');

const page = read('app/page.js');
const start = page.indexOf('        const batches = state.result?.batches || [state.result];');
const end = page.indexOf('\n      } catch (error)', start);
const handler = page.slice(start, end);
assert.ok(start > 0 && end > start);
function restore({ newer = false, unrelated = false, empty = false, all = false } = {}) {
  const id = 'run-test';
  const scope = 'NPB:2026-09-23';
  const session = { runId: newer ? 'run-newer' : id, status: 'running' };
  const other = { runId: 'run-other', status: 'running' };
  let released = false;
  let selected = false;
  let progress;
  const pending = new Map([[scope, { runId: session.runId }]]);
  const context = vm.createContext({
    state: { result: { ...batch, total: empty ? 0 : 1, completed: empty ? 0 : 1, ok: true } }, runId: id,
    LEAGUE_IDS: ['NPB', 'CPBL'], compactAnalysisData: x => x,
    materializeAllLeagueResult: () => empty ? [] : [{ game: { gamePk: 1 } }], analysisItemMatchesScope: () => true,
    independentRunsRef: { current: new Map([[scope, session], ['CPBL:2026-09-23', other]]) },
    currentLeagueRef: { current: unrelated ? 'CPBL' : 'NPB' }, currentDateRef: { current: batch.date },
    boardRef: { current: [] }, allLeagueBoardsRef: { current: new Map() },
    allLeagueRunRef: { current: all ? { runId: id, state: 'running' } : null },
    loadBackgroundJob: (league, date) => pending.get(`${league}:${date}`),
    saveCompletedAnalysisReceipt: () => ({ completed: true, stored: true }),
    clearBackgroundJob: (league, date, runId) => { assert.equal(pending.get(`${league}:${date}`)?.runId, runId); pending.delete(`${league}:${date}`); },
    saveAnalysisBoardCache() {}, requestedRecoveryScopeRef: { current: scope },
    updateAllLeagueAnalysisLeague: run => run, summarizeAllLeagueBatchResult: () => ({ status: 'completed' }),
    leagueDatesRef: { current: {} }, manualDateSelectionRef: { current: new Set() },
    publishAllLeagueRun: run => { context.allLeagueRunRef.current = run; }, setIndependentRunRevision() {},
    operationBusyRef: { current: true }, allLeagueBusyRef: { current: false }, analysisGenerationRef: { current: 1 },
    releaseOperation: () => { released = true; }, setProgress: v => { progress = v; },
    setLeague: () => { selected = true; }, setDate() {}, setBoard() {}, setSchedule() {}, setTab() {}, setNotificationResultNotice() {},
  });
  vm.runInContext(handler, context);
  assert.equal(other.status, 'running', 'another league remains running');
  assert.equal(released, !newer && !unrelated);
  assert.equal(selected, !newer && !unrelated);
  assert.equal(session.status, newer ? 'running' : 'completed');
  if (newer) assert.equal(pending.get(scope).runId, 'run-newer');
  if (released) { assert.equal(progress.active, false); assert.equal(progress.running, 0); assert.equal(context.analysisGenerationRef.current, 2); }
  if (all) assert.equal(context.allLeagueRunRef.current.state, 'completed');
}
restore(); restore({ newer: true }); restore({ unrelated: true }); restore({ empty: true }); restore({ all: true });
console.log('PASS notification readiness: immediate click, all-league/summary API, auth, storage/push failures, legacy fallback, scoped UI unlock and newer-run isolation');
