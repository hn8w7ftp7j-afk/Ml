import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('  async function startIndependentAnalysis('), page.indexOf('  async function oneClickAnalyze('));
const pending = new Map(), jobs = [], saved = [], errors = [];
const noop = () => {};
const context = {
  league: 'NPB', date: '2026-09-22', analysisEnabled: true,
  allLeagueBusyRef: { current: false }, allLeagueRunning: false,
  independentRunsRef: { current: new Map() }, currentLeagueRef: { current: 'NPB' }, currentDateRef: { current: '2026-09-22' },
  analysisGenerationRef: { current: 0 }, manualAnalysisScopesRef: { current: new Set() },
  restoredBoardNeedsValidationRef: {}, operationBusyRef: {}, boardRef: {}, requestedRecoveryScopeRef: {},
  allLeagueBoardsRef: { current: new Map() }, setIndependentRunRevision: noop, setBackgroundJobRevision: noop,
  markAppOperationBusy: noop, setBusy: noop, setError: x => errors.push(x), setProgress: noop, setNotice: noop, setBoard: noop, setSchedule: noop,
  releaseOperation: noop, uid: () => 'request', loadAnalysisBoardCache: () => [],
  mergePreparedLeagueBoard: (old, rows) => [...old, ...rows],
  prepareAllLeagueBatch: (league, date, waiting, selected) => new Promise((resolve, reject) => pending.set(league, { resolve, reject, selected })),
  startBackgroundAnalysisJob: async payload => { jobs.push(payload); return { runId: `${payload.league}-run` }; },
  saveBackgroundJob: job => { saved.push(job); return true; },
};
vm.createContext(context);
const start = vm.runInContext(`(${source.trim()})`, context);
const npb = start(11);
assert.equal(pending.get('NPB').selected, 11);
assert.equal(await start(22), false, 'double click does not overwrite a pending run');
context.league = context.currentLeagueRef.current = 'CPBL';
context.analysisGenerationRef.current++;
const cpbl = start();
assert.equal(pending.size, 2, 'both preparations run concurrently');
function batch(league, gamePk) { const game = { gamePk, leagueId: league }; return { tasks: [{ game }], preparedBoard: [{ game, statusLabel: '等待四聯盟背景分析' }] }; }
pending.get('CPBL').resolve(batch('CPBL', 22));
assert.equal(await cpbl, true);
pending.get('NPB').resolve(batch('NPB', 11));
assert.equal(await npb, true, 'switching away must not abandon preparation');
assert.deepEqual(jobs.map(x => x.league), ['CPBL', 'NPB']);
assert.deepEqual(saved.map(x => [x.league, x.runId]), [['CPBL', 'CPBL-run'], ['NPB', 'NPB-run']]);
assert.equal(context.requestedRecoveryScopeRef.current, 'CPBL:2026-09-22', 'background response cannot attach to another tab');
assert.equal(context.boardRef.current[0].game.leagueId, 'CPBL');
assert.equal(context.independentRunsRef.current.get('NPB:2026-09-22').status, 'running');
context.league = context.currentLeagueRef.current = 'KBO';
const kbo = start();
pending.get('KBO').reject(new Error('Reader unavailable'));
assert.equal(await kbo, false);
assert.equal(context.independentRunsRef.current.get('CPBL:2026-09-22').status, 'running');
assert.equal(context.independentRunsRef.current.get('KBO:2026-09-22').status, 'failed');
console.log('Parallel league preparation, reverse completion order, duplicate guard, single-game scope, independent receipts and failure isolation PASS');
// Execute the actual navigation and recovery effect: a return must reattach,
// not create another job, and completion must release only the selected scope.
Object.assign(context, {
  gamePickerRequestRef: { current: 0 }, setGamePicker: noop, normalizeLeagueId: x => x,
  allLeagueRun: null, allLeagueBoardDate: (_run, _league, fallback) => fallback,
  leagueDatesRef: { current: { NPB: '2026-09-22' } }, queuedAnalysisRef: {}, setQueuedAnalysis: noop,
  setTab: noop, setLeague: value => { context.league = value; }, setDate: noop,
});
const navigation = page.slice(page.indexOf('  function selectLeague('), page.indexOf('  return <main className="appShell">'));
vm.runInContext(navigation, context);
context.selectLeague('NPB');
assert.equal(context.requestedRecoveryScopeRef.current, 'NPB:2026-09-22');
assert.equal(jobs.length, 2, 'returning must not submit a duplicate job');
let effect, attached;
Object.assign(context, {
  storageReady: true, busy: false, backgroundJobRevision: 0,
  completedRecoveryFailuresRef: { current: new Set() },
  loadBackgroundJob: league => saved.find(job => job.league === league),
  useEffect: fn => { effect = fn; },
  pollBackgroundJob: async id => { attached = id; return { total: 1, results: [{ ok: true }] }; },
  analysisFailureState: () => ({ blocked: false }),
});
const marker = page.indexOf('// Restoring a receipt');
vm.runInContext(page.slice(page.lastIndexOf('  useEffect(() => {', marker), page.indexOf('  useEffect(() => {', marker)), context);
effect();
await new Promise(setImmediate);
assert.equal(attached, 'NPB-run');
assert.equal(context.independentRunsRef.current.get('NPB:2026-09-22').status, 'completed');
assert.equal(context.independentRunsRef.current.get('CPBL:2026-09-22').status, 'running');
console.log('Actual league navigation and recovery effect reattach the original job and isolate completion PASS');
