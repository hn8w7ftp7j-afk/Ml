import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { backgroundStartWasDefinitivelyRejected, createBackgroundStartRequestJournal } from '../lib/background-start-request-journal.js';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('async function startBackgroundAnalysisJob('), page.indexOf('async function requestAnalysisWithResume('));
const payload = (changes = {}) => ({ league: 'NPB', date: '2026-10-01',
  tasks: [{ game: { gamePk: 88 }, requestId: 'initial-task-request', actualMarkets: [{ market: '全場大小', water: 0.95 }] }], ...changes });
let clock = 0;
let ids = 0;
const calls = [];
let post = async (_body, key) => ({ requestId: key, status: 'starting' });
let lookup = async key => ({ requestId: key, status: 'starting' });
const context = vm.createContext({
  uid: () => `request-${++ids}`, backgroundStartRequests: createBackgroundStartRequestJournal({ now: () => clock }),
  backgroundStartWasDefinitivelyRejected,
  BACKGROUND_JOB_START_TIMEOUT_MS: 75000, BACKGROUND_JOB_RECOVERY_TIMEOUT_MS: 45000,
  ANALYSIS_TRANSIENT_RETRY_DELAYS_MS: [0, 0], Date: { now: () => clock },
  window: { setTimeout: (callback, ms) => { clock += ms; callback(); } },
  requestJSONWithTransientRetry: async (_url, options) => {
    calls.push({ key: options.headers['Idempotency-Key'], body: options.body });
    return post(JSON.parse(options.body), options.headers['Idempotency-Key']);
  },
  requestJSON: async url => lookup(new URL(url, 'https://site.invalid').searchParams.get('requestId')),
});
vm.runInContext(source, context);

const first = payload();
await assert.rejects(context.startBackgroundAnalysisJob(first), error => error.code === 'BACKGROUND_JOB_RECOVERY_PENDING');
assert.equal(clock, 45000, 'actual 45-second recovery loop is exercised with a fake clock');
post = async (_body, key) => ({ requestId: key, status: 'starting' });
lookup = async key => ({ requestId: key, runId: 'original-run', status: 'running' });
const second = payload({ tasks: [{ ...first.tasks[0], requestId: 'later-generated-task-request', generation: 55 }] });
assert.equal((await context.startBackgroundAnalysisJob(second)).runId, 'original-run');
assert.equal(calls[0].key, calls[1].key, 'uncertain start retry keeps its original workflow claim');
assert.equal(calls[0].body, calls[1].body, 'original task request identities are also retained');
post = async (_body, key) => ({ runId: `new-${key}` });
await context.startBackgroundAnalysisJob(first);
assert.notEqual(calls[2].key, calls[1].key, 'successful receipt releases the key for an explicit future analysis');

// Starts with changed scope or actual input must remain independent while all
// their earlier requests still have an unknown outcome.
post = async () => { throw Object.assign(new Error('network timeout'), { code: 'REQUEST_TIMEOUT' }); };
const independent = [
  payload(), payload({ league: 'KBO' }), payload({ date: '2026-10-02' }),
  payload({ tasks: [{ ...first.tasks[0], actualMarkets: [{ market: '全場大小', water: 0.9 }] }] }),
  { mode: 'all-leagues', date: first.date, batches: [{ league: first.league, date: first.date, tasks: first.tasks }] },
];
const offset = calls.length;
for (const input of independent) await assert.rejects(context.startBackgroundAnalysisJob(input), error => error.code === 'REQUEST_TIMEOUT');
const keys = calls.slice(offset).map(call => call.key);
assert.equal(new Set(keys).size, independent.length);
for (let index = 0; index < independent.length; index++) {
  await assert.rejects(context.startBackgroundAnalysisJob(independent[index]), error => error.code === 'REQUEST_TIMEOUT');
  assert.equal(calls.at(-1).key, keys[index]);
}
const wrapped = payload({ date: '2026-10-06' });
post = async () => { throw Object.assign(new Error('transport unavailable'), {
  code: 'TRANSIENT_BROWSER_LOAD_FAILED', cause: Object.assign(new Error('gateway unavailable'), { status: 503 }),
}); };
await assert.rejects(context.startBackgroundAnalysisJob(wrapped), error => error.code === 'TRANSIENT_BROWSER_LOAD_FAILED');
const wrappedKey = calls.at(-1).key;
await assert.rejects(context.startBackgroundAnalysisJob(wrapped), error => error.code === 'TRANSIENT_BROWSER_LOAD_FAILED');
assert.equal(calls.at(-1).key, wrappedKey, 'the transient wrapper and its cause retain the uncertain request');
const limited = payload({ date: '2026-10-07' });
await assert.rejects(context.startBackgroundAnalysisJob(limited), error => error.code === 'TRANSIENT_BROWSER_LOAD_FAILED');
const limitedKey = calls.at(-1).key;
post = async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); };
await assert.rejects(context.startBackgroundAnalysisJob(limited), error => error.status === 429);
assert.equal(calls.at(-1).key, limitedKey);
post = async (_body, key) => ({ runId: `accepted-${key}` });
await context.startBackgroundAnalysisJob(limited);
assert.equal(calls.at(-1).key, limitedKey, 'rate limit on a later attempt cannot prove that an earlier start was rejected');

const wrappedRejected = payload({ date: '2026-10-08' });
post = async () => { throw Object.assign(new Error('transport wrapper'), {
  code: 'TRANSIENT_BROWSER_LOAD_FAILED', cause: Object.assign(new Error('durable start failed'), { status: 503, code: 'BACKGROUND_JOB_START_FAILED' }),
}); };
await assert.rejects(context.startBackgroundAnalysisJob(wrappedRejected), error => error.code === 'TRANSIENT_BROWSER_LOAD_FAILED');
const wrappedRejectedKey = calls.at(-1).key;
post = async (_body, key) => ({ runId: `accepted-${key}` });
await context.startBackgroundAnalysisJob(wrappedRejected);
assert.notEqual(calls.at(-1).key, wrappedRejectedKey, 'the known FAILED claim under a retry wrapper releases its rejected key');

// A definitive HTTP rejection and an explicit FAILED request-state permit a
// new claim. A failure to read an already-starting request remains uncertain.
const rejected = payload({ date: '2026-10-03' });
post = async () => { throw Object.assign(new Error('invalid request'), { status: 400 }); };
await assert.rejects(context.startBackgroundAnalysisJob(rejected), error => error.status === 400);
const rejectedKey = calls.at(-1).key;
post = async (_body, key) => ({ runId: `accepted-${key}` });
await context.startBackgroundAnalysisJob(rejected);
assert.notEqual(calls.at(-1).key, rejectedKey);

const failed = payload({ date: '2026-10-04' });
post = async (_body, key) => ({ requestId: key, status: 'starting' });
lookup = async key => ({ requestId: key, status: 'failed', error: 'server rejected start' });
await assert.rejects(context.startBackgroundAnalysisJob(failed), error => error.definitiveStartRejected === true);
const failedKey = calls.at(-1).key;
post = async (_body, key) => ({ runId: `accepted-${key}` });
await context.startBackgroundAnalysisJob(failed);
assert.notEqual(calls.at(-1).key, failedKey);

const unknownLookup = payload({ date: '2026-10-05' });
post = async (_body, key) => ({ requestId: key, status: 'starting' });
lookup = async () => { throw Object.assign(new Error('mapping unavailable'), { status: 404 }); };
await assert.rejects(context.startBackgroundAnalysisJob(unknownLookup), error => error.status === 404);
const uncertainKey = calls.at(-1).key;
lookup = async key => ({ requestId: key, runId: 'recovered-original', status: 'running' });
await context.startBackgroundAnalysisJob(unknownLookup);
assert.equal(calls.at(-1).key, uncertainKey, 'failed recovery lookup is not proof that the start was rejected');

const journal = createBackgroundStartRequestJournal({ now: () => clock, maxEntries: 2, maxAgeMs: 100 });
const a = journal.claim(payload(), () => 'a');
const b = journal.claim(payload({ league: 'KBO' }), () => 'b');
journal.claim(payload(), () => 'ignored');
journal.claim(payload({ league: 'CPBL' }), () => 'c');
const newerB = journal.claim(payload({ league: 'KBO' }), () => 'b-new');
assert.equal(newerB.requestId, 'b-new', 'journal has a bounded LRU');
journal.release(b);
assert.equal(journal.claim(payload({ league: 'KBO' }), () => 'ignored').requestId, newerB.requestId, 'an old receipt cannot release a newer owner');
clock += 101;
assert.notEqual(journal.claim(payload(), () => 'a-new').requestId, a.requestId, 'stale uncertain starts expire');

// The server's actual task normalizer does not return client generation values,
// so retaining an original body cannot make recovery reject a later generation.
const routeSource = fs.readFileSync(new URL('../app/api/analysis-jobs/route.js', import.meta.url), 'utf8');
const normalizerSource = routeSource.slice(routeSource.indexOf('function normalizeTasks('), routeSource.indexOf('export async function POST('));
const normalizer = vm.createContext({ REQUEST_ID: /^[a-zA-Z0-9-]{16,100}$/,
  crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789012' }, cleanText: value => String(value || '') });
vm.runInContext(normalizerSource, normalizer);
const normalized = normalizer.normalizeTasks([{ ...JSON.parse(calls[0].body).tasks[0], generation: -99 }], 'NPB');
assert.equal(normalized[0].generation, undefined);
assert.equal(normalized[0].body.generation, undefined);

assert.equal(backgroundStartWasDefinitivelyRejected({ status: 500, code: 'BACKGROUND_JOB_START_FAILED' }), false);
assert.equal(backgroundStartWasDefinitivelyRejected({ status: 503, code: 'BACKGROUND_JOB_START_FAILED' }), true);
assert.equal(backgroundStartWasDefinitivelyRejected({ status: 408 }), false);
assert.equal(backgroundStartWasDefinitivelyRejected({ status: 429 }), false);
console.log('PASS: uncertain 45-second workflow start retries preserve request/body identity, isolate inputs, release confirmed outcomes and stay bounded');
