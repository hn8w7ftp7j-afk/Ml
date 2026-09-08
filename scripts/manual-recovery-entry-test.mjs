import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const marker = page.indexOf('// Restoring a receipt');
const start = page.lastIndexOf('  useEffect(() => {', marker);
const end = page.indexOf('  useEffect(() => {', marker);
const source = page.slice(start, end);
const saved = { runId: 'previous-completed', completedReceipt: true, total: 3, gamePks: [1, 2, 3] };
let effect, polls = 0, locks = 0, releases = 0;
const context = {
  storageReady: true, league: 'MLB', date: '2026-09-08', busy: false, backgroundJobRevision: 0,
  requestedRecoveryScopeRef: { current: null }, boardRef: { current: [] },
  completedRecoveryFailuresRef: { current: new Set() }, operationBusyRef: { current: false },
  analysisGenerationRef: { current: 1 }, currentDateRef: { current: '2026-09-08' },
  useEffect: fn => { effect = fn; }, loadBackgroundJob: () => saved,
  markAppOperationBusy: value => { if (value) locks++; }, setBusy: () => {}, setProgress: () => {},
  setNotice: () => {}, setError: () => {},
  pollBackgroundJob: () => { polls++; return Promise.reject(new Error('network timeout')); },
  releaseOperation: () => { releases++; context.operationBusyRef.current = false; },
};
vm.runInNewContext(source, context);
effect();
assert.equal(polls, 0, 'entry must not fetch old jobs');
assert.equal(locks, 0, 'empty cache plus completed receipt must not disable manual controls');
context.requestedRecoveryScopeRef.current = 'NPB:2026-09-08';
effect();
assert.equal(polls, 0, 'another league cannot consume a recovery request');
context.requestedRecoveryScopeRef.current = 'MLB:2026-09-08';
effect();
await new Promise(resolve => setImmediate(resolve));
assert.equal(polls, 1);
assert.equal(releases, 1, 'failed manual recovery releases the foreground');
assert.equal(context.requestedRecoveryScopeRef.current, null);
effect();
assert.equal(polls, 1, 'busy=false rerender must not restart failed recovery');

const pollStart = page.indexOf('  function pollBackgroundJob(');
const pollEnd = page.indexOf('  async function runDurableAnalysisTasks(', pollStart);
const pollSource = page.slice(pollStart, pollEnd);
let requests = 0;
const retryContext = {
  league: 'MLB', backgroundJobPollsRef: { current: new Map() }, analysisGenerationRef: { current: 1 },
  currentDateRef: { current: '2026-09-08' },
  requestJSON: async () => { requests++; throw new Error('timeout'); },
};
vm.runInNewContext(pollSource, retryContext);
await assert.rejects(retryContext.pollBackgroundJob('saved', 1, '2026-09-08', [], { completedReceipt: saved }), /已保留紀錄/);
assert.equal(requests, 1, 'completed receipt transient failures do not loop');
assert.equal(retryContext.backgroundJobPollsRef.current.size, 0);
console.log('Manual receipt recovery: idle entry unlocked, league isolation, single explicit attempt, timeout release and no retry loop PASS');
