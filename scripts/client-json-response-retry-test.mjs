import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const direct = page.slice(page.indexOf('async function requestJSONDirect('), page.indexOf('async function requestJSONWithTransientRetry('));
const retry = page.slice(page.indexOf('async function requestJSONWithTransientRetry('), page.indexOf('function analysisFailureState('));
const transient = page.slice(page.indexOf('function transientAnalysisError('), page.indexOf('async function startBackgroundAnalysisJob('));

function client(responses) {
  const calls = [];
  const redirects = [];
  const context = {
    Response, AbortController, setTimeout, clearTimeout, authRedirectStarted: false,
    window: {
      setTimeout,
      location: { pathname: '/', search: '?analysisRun=existing', replace: value => redirects.push(value) },
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected extra request');
      return response;
    },
  };
  vm.createContext(context);
  vm.runInContext(`${direct}\n${transient}\n${retry}`, context);
  context.requestJSON = context.requestJSONDirect;
  return { context, calls, redirects };
}

const temporary = client([new Response('<html>upstream unavailable</html>', {
  status: 503, headers: { 'retry-after': '3' },
})]);
await assert.rejects(temporary.context.requestJSONDirect('/api/credit-lines', {}, 1000), error => {
  assert.equal(error.status, 503);
  assert.equal(error.code, 'INVALID_JSON');
  assert.equal(error.retryAfterMs, 3000);
  assert.equal(temporary.context.transientAnalysisError(error), true);
  assert.doesNotMatch(error.message, /html|upstream unavailable/);
  return true;
});

const recovered = client([
  new Response('<html>gateway unavailable</html>', { status: 502 }),
  Response.json({ ok: true, runId: 'existing-job' }, { status: 202 }),
]);
const options = { method: 'POST', headers: { 'Idempotency-Key': 'same-request' }, body: '{"league":"MLB"}' };
const result = await recovered.context.requestJSONWithTransientRetry('/api/analysis-jobs', options, 1000, { delaysMs: [0, 0] });
assert.equal(result.runId, 'existing-job');
assert.equal(recovered.calls.length, 2);
assert.equal(recovered.calls[0].options.headers['Idempotency-Key'], recovered.calls[1].options.headers['Idempotency-Key']);
assert.equal(recovered.calls[0].options.body, recovered.calls[1].options.body);

const malformedSuccess = client([new Response('<html>unexpected page</html>', { status: 200 })]);
await assert.rejects(malformedSuccess.context.requestJSONWithTransientRetry('/api/credit-lines', {}, 1000, { delaysMs: [0, 0] }), error => {
  assert.equal(error.status, 200);
  assert.equal(error.code, 'INVALID_JSON');
  assert.equal(malformedSuccess.context.transientAnalysisError(error), false);
  return true;
});
assert.equal(malformedSuccess.calls.length, 1, 'an invalid successful response is not a transient HTTP outage');

const unauthorized = client([new Response('<html>sign in</html>', { status: 401 })]);
await assert.rejects(unauthorized.context.requestJSONWithTransientRetry('/api/credit-lines', {}, 1000, { delaysMs: [0, 0] }), error => {
  assert.equal(error.status, 401);
  assert.equal(unauthorized.context.transientAnalysisError(error), false);
  return true;
});
assert.equal(unauthorized.calls.length, 1);
assert.deepEqual(unauthorized.redirects, ['/login?next=%2F%3FanalysisRun%3Dexisting']);

const invalidInput = client([Response.json({ ok: false, code: 'INVALID_BACKGROUND_JOB', error: 'invalid job' }, { status: 400 })]);
await assert.rejects(invalidInput.context.requestJSONWithTransientRetry('/api/analysis-jobs', {}, 1000, { delaysMs: [0, 0] }), error => error.status === 400 && error.code === 'INVALID_BACKGROUND_JOB');
assert.equal(invalidInput.calls.length, 1);

console.log('PASS: actual client HTTP error parsing preserves transient status, retry evidence, request identity and auth handling without exposing raw pages');
