import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createJobStatusReader } from '../lib/job-status-reader.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let calls = 0;
let gate = deferred();
const shared = createJobStatusReader(() => { calls++; return gate.promise; });
const first = shared('/api/analysis-jobs?runId=run-test&league=NPB&t=1', 30000);
const second = shared('/api/analysis-jobs?t=2&league=NPB&runId=run-test', 30000);
await Promise.resolve();
assert.equal(calls, 1, 'concurrent identical status reads make one network request');
gate.resolve({ status: 'running', progress: { revision: 1 } });
const [one, two] = await Promise.all([first, second]);
one.progress.revision = 100;
assert.equal(two.progress.revision, 1, 'each consumer receives an independent JSON value');
gate = deferred();
const next = shared('/api/analysis-jobs?runId=run-test&league=NPB&t=3', 30000);
await Promise.resolve();
assert.equal(calls, 2, 'settled results are not reused on the next poll');
gate.reject(new Error('offline'));
await assert.rejects(next, /offline/);
gate = deferred();
const retried = shared('/api/analysis-jobs?runId=run-test&league=NPB', 30000);
await Promise.resolve();
assert.equal(calls, 3, 'failed requests do not poison subsequent retries');
gate.resolve({ status: 'completed' });
assert.equal((await retried).status, 'completed');

let isolatedCalls = 0;
const isolationGate = deferred();
const scoped = createJobStatusReader(() => { isolatedCalls++; return isolationGate.promise; });
const queries = [
  ['runId=run-test&league=NPB', 30000], ['runId=run-test&league=KBO', 30000],
  ['runId=run-other&league=NPB', 30000], ['runId=run-test&summary=1', 30000],
  ['runId=run-test&league=NPB&afterRevision=1', 30000],
  ['runId=run-test&league=NPB&afterRevision=2', 30000],
  ['runId=run-test&league=NPB', 15000], ['requestId=request-test', 30000],
];
const scopedReads = queries.map(([query, timeout]) => scoped(`/api/analysis-jobs?${query}`, timeout));
await Promise.resolve();
assert.equal(isolatedCalls, queries.length, 'run, league, summary, revision, recovery and timeout stay isolated');
isolationGate.resolve({ ok: true });
await Promise.all(scopedReads);

// Execute the real progress reader with a tagged-SQL stub, including the exact
// nullable integer cursor sent to PostgreSQL. Only equal revisions are skipped.
const storedProgress = { league: 'NPB', date: '2026-09-23', revision: 3,
  results: [{ payload: { display: 'x'.repeat(150000) } }] };
const queriesSeen = [];
const sql = async (strings, ...values) => {
  const query = strings.join('?');
  if (query.includes('CREATE TABLE')) return [];
  queriesSeen.push(values);
  assert.match(query, /revision <> \?::integer/);
  assert.equal(values[2], values[3]);
  return values[0] === 'run-test' && values[1] === 'NPB'
    && values[2] !== storedProgress.revision ? [{ payload: storedProgress }] : [];
};
const storeContext = vm.createContext({ neon: () => sql, durableDatabaseConfigured: () => true,
  durableDatabaseUrl: () => 'test-only' });
vm.runInContext(strip(read('lib/analysis-job-progress-store.js')) + '\nthis.get = getAnalysisJobProgress;', storeContext);
assert.equal(await storeContext.get('run-test', 'NPB', '3'), null);
assert.equal(await storeContext.get('run-test', 'NPB', '2'), storedProgress);
assert.equal(await storeContext.get('run-test', 'NPB', '4'), storedProgress, 'a mismatched cursor cannot hide current data');
for (const cursor of [null, undefined, '', '-1', 'x', '3.0', '2147483648', '9007199254740993']) {
  assert.equal(await storeContext.get('run-test', 'NPB', cursor), storedProgress);
  assert.equal(queriesSeen.at(-1)[2], null);
}
assert.equal(await storeContext.get('run-test', 'KBO', '2'), null);
assert.equal(await storeContext.get('run-other', 'NPB', '2'), null);

let authorized = true, exists = true, status = 'running', published = null;
let progressReads = 0;
const completed = { league: 'NPB', date: '2026-09-23', total: 1, results: [] };
const route = vm.createContext({ Request, Response, URL, NextResponse: Response,
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }),
  cleanText: v => String(v || ''), isLeagueId: v => ['NPB', 'KBO'].includes(v),
  getRun: () => ({ exists, status, returnValue: completed }),
  getNotificationResult: async () => published,
  getAnalysisJobProgress: async (...args) => { progressReads++; return storeContext.get(...args); },
});
vm.runInContext(strip(read('app/api/analysis-jobs/route.js')) + '\nthis.get = GET;', route);
const get = async query => route.get(new Request(`https://example.test/api/analysis-jobs?runId=run-test&league=NPB${query}`));
const full = await (await get('')).json();
const unchanged = await (await get('&afterRevision=3')).json();
assert.equal(full.progress.revision, 3);
assert.equal(unchanged.status, 'running');
assert.equal(unchanged.progress, null);
assert.equal((await (await get('&afterRevision=2')).json()).progress.revision, 3);
authorized = false;
const beforeUnauthorized = progressReads;
assert.equal((await get('&afterRevision=3')).status, 401);
assert.equal(progressReads, beforeUnauthorized, 'authentication precedes database reads');
authorized = true; exists = false;
assert.equal((await get('')).status, 404);
exists = true;
for (const terminal of ['failed', 'cancelled']) {
  status = terminal;
  const before = progressReads;
  assert.equal((await (await get('&afterRevision=3')).json()).status, terminal);
  assert.equal(progressReads, before);
}
status = 'completed';
assert.deepEqual((await (await get('&afterRevision=3')).json()).result, completed,
  'completion always returns the authoritative result regardless of progress cursor');
status = 'running'; published = completed;
assert.equal((await (await get('&afterRevision=3')).json()).status, 'completed',
  'notification result remains available before workflow completion');

// Exercise the page's actual transport dispatcher, with its normal HTTP parser.
const page = read('app/page.js');
const start = page.indexOf('async function requestJSON(');
const end = page.indexOf('async function requestJSONWithTransientRetry(', start);
const transportGate = deferred();
let httpCalls = 0;
const pageContext = vm.createContext({ createJobStatusReader, AbortController, setTimeout, clearTimeout,
  authRedirectStarted: false, fetch: async () => { httpCalls++; await transportGate.promise;
    return Response.json({ ok: true, status: 'running' }); } });
vm.runInContext(page.slice(start, end) + '\nthis.request = requestJSON;', pageContext);
const reads = [pageContext.request('/api/analysis-jobs?runId=run-test&t=1', {}, 30000),
  pageContext.request('/api/analysis-jobs?runId=run-test&t=2', {}, 30000)];
await Promise.resolve();
assert.equal(httpCalls, 1);
reads.push(pageContext.request('/api/analysis-jobs', { method: 'POST', body: '{}' }, 30000));
reads.push(pageContext.request('/api/analysis-jobs', { method: 'POST', body: '{}' }, 30000));
assert.equal(httpCalls, 3, 'writes are never combined with reads or other writes');
transportGate.resolve();
await Promise.all(reads);
assert.match(page, /afterRevision=\$\{lastProgressRevision\}/);
const fullBytes = Buffer.byteLength(JSON.stringify(full));
const unchangedBytes = Buffer.byteLength(JSON.stringify(unchanged));
assert.ok(unchangedBytes < 200 && fullBytes > 150000);
console.log(`PASS status transport: deduplication, fresh polls, retries, scope isolation, auth, terminal/notification results, cursor fallback and POST isolation. Synthetic unchanged payload: ${fullBytes} -> ${unchangedBytes} bytes.`);
