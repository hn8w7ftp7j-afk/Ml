import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { exhaustedRequestRetryError } from '../lib/request-retry-error.js';

const official = Object.assign(new Error('MLB 官方賽程讀取逾時'), {
  status: 502, code: 'OFFICIAL_SCHEDULE_UNAVAILABLE', retryAfterMs: 4000,
});
const timeout = Object.assign(new Error('請求逾時，請稍後重試'), { code: 'REQUEST_TIMEOUT' });
const invalidJson = Object.assign(new Error('伺服器回傳格式錯誤（504）'), { status: 504, code: 'INVALID_JSON' });
for (const error of [official, timeout, invalidJson]) {
  assert.equal(exhaustedRequestRetryError(error), error, 'server metadata and request timeouts must survive exhaustion intact');
}
const network = new TypeError('Load failed');
const networkResult = exhaustedRequestRetryError(network);
assert.equal(networkResult.code, 'TRANSIENT_BROWSER_LOAD_FAILED');
assert.equal(networkResult.cause, network);

// Run the actual shipped retry loop against successful recovery and exhausted
// HTTP/timeout/browser failures, rather than testing a second copy of the loop.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const start = page.indexOf('async function requestJSONWithTransientRetry(');
const end = page.indexOf('\nfunction analysisFailureState(', start);
assert.ok(start >= 0 && end > start);
const retrySource = page.slice(start, end);
assert.match(retrySource, /throw exhaustedRequestRetryError\(failure\)/);
for (const error of [official, timeout, invalidJson, network]) {
  let calls = 0;
  const context = vm.createContext({ exhaustedRequestRetryError, transientAnalysisError: () => true,
    requestJSON: async () => { calls++; throw error; } });
  const run = vm.runInContext(`${retrySource}; requestJSONWithTransientRetry`, context);
  await assert.rejects(() => run('/api/schedule?league=MLB', {}, 40000, { delaysMs: [0, 0, 0] }), caught => {
    assert.equal(calls, 3);
    if (error === network) return caught.code === 'TRANSIENT_BROWSER_LOAD_FAILED' && caught.cause === network;
    return caught === error;
  });
}
let recoveredCalls = 0;
const context = vm.createContext({ exhaustedRequestRetryError, transientAnalysisError: () => true,
  requestJSON: async () => { if (++recoveredCalls === 1) throw official; return { ok: true, games: [] }; } });
const run = vm.runInContext(`${retrySource}; requestJSONWithTransientRetry`, context);
assert.deepEqual(await run('/api/schedule?league=MLB', {}, 40000, { delaysMs: [0, 0, 0] }), { ok: true, games: [] });
assert.equal(recoveredCalls, 2);
console.log('Request retries preserve official API failures/timeouts, recover empty schedules, and identify browser network exhaustion PASS');
