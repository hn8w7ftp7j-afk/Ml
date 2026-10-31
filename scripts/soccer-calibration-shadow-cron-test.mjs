import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

const previous = process.env.CRON_SECRET;
process.env.CRON_SECRET = 'synthetic-calibration-cron-secret';
const state = { calls: [], failLeague: null };
globalThis.__SOCCER_CALIBRATION_CRON_TEST = state;
const stub = 'data:text/javascript,' + encodeURIComponent(`
export async function evaluateSoccerCalibrationShadow(options) {
  const state = globalThis.__SOCCER_CALIBRATION_CRON_TEST;
  state.calls.push(options);
  if (options.league === state.failLeague) throw Error('controlled storage failure');
  return { summary: { league: options.league, status: 'NO_PENDING_CAPTURES',
    persisted: true, checkedGames: 0, formalEligible: false, executable: false } };
}`);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((context.parentURL || '').endsWith('/app/api/cron/soccer-calibration/route.js')
    && specifier.endsWith('/calibration-shadow-validation.js'))
    return { url: ${JSON.stringify(stub)}, shortCircuit: true };
  return next(specifier, context);
}`), import.meta.url);

try {
  const { GET, maxDuration } = await import('../app/api/cron/soccer-calibration/route.js');
  const { middleware } = await import('../middleware.js');
  const cronRequest = new Request('http://localhost/api/cron/soccer-calibration');
  cronRequest.nextUrl = new URL(cronRequest.url);
  const middlewareResponse = await middleware(cronRequest);
  assert.equal(middlewareResponse.headers.get('x-middleware-next'), '1', 'the exact cron endpoint reaches its own secret guard without a browser login');
  const request = token => new Request('http://localhost/api/cron/soccer-calibration?league=nba&result=999', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal((await GET(request())).status, 401);
  assert.equal((await GET(request('wrong-secret'))).status, 401);
  assert.equal(state.calls.length, 0, 'unauthorized requests cannot read, write or fetch results');
  const response = await GET(request(process.env.CRON_SECRET));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(state.calls, [{ league: 'epl', limit: 3 }, { league: 'ucl', limit: 3 }]);
  assert.equal(body.ok, true);
  assert.equal(body.formalEligible, false);
  assert.equal(body.executable, false);
  assert.ok(2 * 18000 < maxDuration * 1000, 'both bounded batches leave time for database and route overhead');

  state.calls = [];
  state.failLeague = 'epl';
  const failed = await GET(request(process.env.CRON_SECRET));
  const failure = await failed.json();
  assert.equal(failed.status, 503);
  assert.equal(failure.ok, false);
  assert.equal(failure.summaries[0].status, 'STORAGE_UNAVAILABLE');
  assert.equal(failure.summaries[0].checkedGames, undefined, 'a storage failure must not fabricate a zero');
  assert.equal(failure.summaries[1].persisted, true, 'one failed league cannot prevent the other check');
  assert.deepEqual(state.calls.map(call => call.league), ['epl', 'ucl']);

  state.calls = [];
  process.env.CRON_SECRET = '';
  assert.equal((await GET(request('synthetic-calibration-cron-secret'))).status, 401);
  assert.equal(state.calls.length, 0, 'a missing server secret fails closed');
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.equal(config.crons.filter(cron => cron.path === '/api/cron/soccer-calibration').length, 1);
  assert.equal(config.functions['app/api/cron/soccer-calibration/route.js'].maxDuration, maxDuration);
  console.log('PASS calibration shadow cron: actual secret-authenticated handler, fixed EPL/UCL scope, bounded batches, separate settlement budget, unknown storage failure and isolated league continuation.');
} finally {
  if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  delete globalThis.__SOCCER_CALIBRATION_CRON_TEST;
}
