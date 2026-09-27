import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const source = fs.readFileSync(new URL('../app/api/analysis-jobs/route.js', import.meta.url), 'utf8');
const strip = s => s.replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const expected = { revision: 2, results: [] };
const request = () => new Request('https://site.invalid/api/analysis-jobs?runId=run-test&league=NPB&afterRevision=1');
function setup(code, notification, progress, status = 'running') {
  const logs = [];
  const ctx = vm.createContext({ Request, Response, URL, NextResponse: Response,
    requireApiAuth: async () => null, cleanText: x => String(x || ''), isLeagueId: () => true,
    getRun: () => ({ exists: true, status, returnValue: { results: [], total: 0 } }),
    getNotificationResult: notification, getAnalysisJobProgress: progress,
    console: { info: text => logs.push(JSON.parse(text)) },
  });
  vm.runInContext(strip(code) + '\nthis.get = GET;', ctx);
  return { get: () => ctx.get(request()), logs };
}
let notificationStarted = false, progressStarted = false;
let notification = deferred(), progress = deferred();
let route = setup(source, () => { notificationStarted = true; return notification.promise; }, () => { progressStarted = true; return progress.promise; });
let pending = route.get();
await new Promise(resolve => setImmediate(resolve));
assert(notificationStarted && progressStarted, 'both independent reads start without waiting for either response');
progress.resolve(expected); notification.resolve(null);
assert.deepEqual((await (await pending).json()).progress, expected);
assert(route.logs[0].stages.some(s => s.stage === 'notification_result'));

route = setup(source, async () => { throw Error('notification database unavailable'); }, async () => expected);
let response = await route.get();
assert.equal(response.status, 200, 'notification-store failure cannot suppress progress');
let data = await response.json();
assert.equal(data.status, 'running');
assert.deepEqual(data.progress, expected);
assert(route.logs[0].stages.some(s => s.stage === 'notification_result' && s.outcome === 'failed'));
assert(!JSON.stringify(route.logs).includes('database unavailable'));

route = setup(source, async () => null, async () => { throw Error('progress store unavailable'); });
data = await (await route.get()).json();
assert.equal(data.status, 'running'); assert.equal(data.progress, null);

progress = deferred();
const completed = { results: [], total: 0 };
route = setup(source, async () => completed, () => progress.promise);
response = await Promise.race([route.get(), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('published result blocked by optional progress')), 500); timer.unref(); })]);
assert.equal((await response.json()).status, 'completed', 'published result does not wait for slow progress');
progress.reject(Error('late progress error must already be handled'));
await new Promise(resolve => setImmediate(resolve));

const oldPath = process.argv.find(x => x.startsWith('--baseline='))?.slice(11);
if (oldPath) {
  const baseline = fs.readFileSync(oldPath, 'utf8');
  const sample = async code => {
    const test = setup(code,
      () => new Promise(resolve => setTimeout(() => resolve(null), 80)),
      () => new Promise(resolve => setTimeout(() => resolve(expected), 120)));
    const start = performance.now(); await test.get(); return performance.now() - start;
  };
  const before = [], after = [];
  for (let i = 0; i < 5; i++) { before.push(await sample(baseline)); after.push(await sample(source)); }
  const median = xs => [...xs].sort((a,b) => a-b)[2];
  console.log(JSON.stringify({ environment: 'simulated store delays; NOT production analysis runtime', beforeMedianMs: median(before), afterMedianMs: median(after) }));
  assert(median(after) < median(before) - 40);
}
console.log('PASS concurrent reads, notification failure isolation, progress failure fallback, published completion priority and safe timing logs');
