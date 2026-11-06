import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

const previous = process.env.CRON_SECRET,previousDateNow=Date.now;
process.env.CRON_SECRET = 'synthetic-calibration-cron-secret';
const state = { timeline: [], calls: [], collections: [], lifecycle: [], failLeague: null, failCollection: null, failLifecycle: null };
globalThis.__SOCCER_CALIBRATION_CRON_TEST = state;
Date.now=()=>state.clock ?? previousDateNow();
const stub = 'data:text/javascript,' + encodeURIComponent(`
function spend(state,phase,options){state.timeline.push({phase,...options});if(state.clock!==undefined)state.clock+=state.advance?.[phase]||0;}
export async function evaluateSoccerCalibrationShadow(options) {
  const state = globalThis.__SOCCER_CALIBRATION_CRON_TEST;
  state.calls.push(options);spend(state,'evaluate',options);
  if (options.league === state.failLeague) throw Error('controlled storage failure');
  return { summary: { league: options.league, status: state.partialLeague === options.league ? 'PARTIAL_HISTORY_READ' : 'NO_PENDING_CAPTURES',
    persisted: true, checkedGames: 0, formalEligible: false, executable: false } };
}
export async function runSoccerReturnErrorLifecycle(options) {
  const state = globalThis.__SOCCER_CALIBRATION_CRON_TEST;
  state.lifecycle.push(options);spend(state,'lifecycle',options);
  if (options.league === state.failLifecycle) throw Error('controlled lifecycle failure');
  return { league: options.league, status: 'NOT_CONFIGURED', persisted: true, protocols: [],
    accepted: false, formalEligible: false, executable: false };
}
export async function collectSoccerCalibrationPredictions(options) {
  const state = globalThis.__SOCCER_CALIBRATION_CRON_TEST;
  state.collections.push(options);spend(state,'collection',options);
  if (options.league === state.failCollection) throw Error('controlled collection failure');
  return { league: options.league, status: 'NO_PENDING_GAMES', persisted: true, formalEligible: false, executable: false };
}`);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((context.parentURL || '').endsWith('/app/api/cron/soccer-calibration/route.js')
    && (specifier.endsWith('/calibration-shadow-validation.js') || specifier.endsWith('/calibration-collection.js') || specifier.endsWith('/return-error-lifecycle.js')))
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
  assert.equal(state.collections.length, 0);
  assert.equal(state.lifecycle.length, 0);
  const response = await GET(request(process.env.CRON_SECRET));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(state.calls, [{ league: 'epl', limit: 3, timeBudgetMs:18000 }, { league: 'ucl', limit: 3, timeBudgetMs:18000 }]);
  assert.deepEqual(state.collections, ['epl','ucl'].map(league => ({league,limit:2,timeBudgetMs:50000})));
  assert.deepEqual(state.lifecycle, ['epl','ucl'].map(league => ({league,limit:1,timeBudgetMs:9000})));
  assert.deepEqual(body.returnErrorLifecycle.map(value => value.status), ['NOT_CONFIGURED','NOT_CONFIGURED']);
  assert.deepEqual(state.timeline.map(value=>`${value.phase}:${value.league}`),['lifecycle:epl','lifecycle:ucl','collection:epl','collection:ucl','evaluate:epl','evaluate:ucl'],'each stage gives both leagues a turn before moving on');
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

  state.calls = []; state.collections = []; state.failLeague = null; state.failCollection = 'epl';
  const collectionFailure = await GET(request(process.env.CRON_SECRET));
  assert.equal(collectionFailure.status, 503);
  const collectionBody = await collectionFailure.json();
  assert.equal(collectionBody.collection[0].status, 'STORAGE_UNAVAILABLE');
  assert.equal(collectionBody.collection[1].persisted, true);
  assert.deepEqual(state.calls.map(call => call.league), ['epl','ucl'], 'failed collection must not stop existing result checks');

  state.failCollection=null;state.partialLeague='epl';state.calls=[];
  const partial=await GET(request(process.env.CRON_SECRET)),partialBody=await partial.json();
  assert.equal(partial.status,503,'a saved receipt with unfinished post-save replay is not a successful validation');
  assert.equal(partialBody.ok,false);assert.equal(partialBody.summaries[0].persisted,true);
  assert.equal(partialBody.summaries[0].status,'PARTIAL_HISTORY_READ');
  assert.equal(partialBody.summaries[1].status,'NO_PENDING_CAPTURES');

  state.calls=[];state.collections=[];state.lifecycle=[];state.partialLeague=null;state.failLifecycle='epl';
  const lifecycleFailure=await GET(request(process.env.CRON_SECRET));
  const lifecycleBody=await lifecycleFailure.json();
  assert.equal(lifecycleFailure.status,503);
  assert.equal(lifecycleBody.ok,false);
  assert.equal(lifecycleBody.returnErrorLifecycle[0].status,'STORAGE_UNAVAILABLE');
  assert.equal(lifecycleBody.returnErrorLifecycle[1].status,'NOT_CONFIGURED');
  assert.deepEqual(state.calls.map(call=>call.league),['epl','ucl'],'one failed return-error job cannot stop existing result checks');
  assert.deepEqual(state.collections.map(call=>call.league),['epl','ucl']);
  assert.deepEqual(state.lifecycle.map(call=>call.league),['epl','ucl']);

  state.calls=[];state.collections=[];state.lifecycle=[];state.timeline=[];state.failLifecycle=null;
  state.clock=1000000;state.advance={lifecycle:9000,collection:60000,evaluate:18000};
  const dynamic=await GET(request(process.env.CRON_SECRET));
  assert.equal(dynamic.status,200);
  assert.deepEqual(state.collections.map(value=>value.timeBudgetMs),[50000,46000],'slow source/DB overhead shrinks the second league collection budget');
  assert.deepEqual(state.calls.map(value=>value.timeBudgetMs),[11000,4000],'the final stage receives only its remaining fair share');
  assert.ok(state.clock-1000000<maxDuration*1000,'global scheduling leaves the handler within the platform duration in the slow-overhead counterexample');

  state.calls=[];state.collections=[];state.lifecycle=[];state.timeline=[];
  state.clock=2000000;state.advance={lifecycle:170000};
  const exhausted=await GET(request(process.env.CRON_SECRET)),exhaustedBody=await exhausted.json();
  assert.equal(exhausted.status,503);assert.equal(exhaustedBody.ok,false);
  assert.equal(state.lifecycle.length,1);assert.equal(state.collections.length,0);assert.equal(state.calls.length,0,'no new source work starts after the global deadline');
  assert.equal(exhaustedBody.returnErrorLifecycle[1].status,'BUDGET_DEFERRED');
  assert.deepEqual(exhaustedBody.collection.map(value=>value.status),['BUDGET_DEFERRED','BUDGET_DEFERRED']);
  assert.deepEqual(exhaustedBody.summaries.map(value=>value.status),['BUDGET_DEFERRED','BUDGET_DEFERRED']);
  assert.ok(exhaustedBody.collection.every(value=>value.checkedGames===undefined),'deferred work must not invent a zero result count');

  state.clock=undefined;state.advance=undefined;
  state.calls = [];state.collections=[];state.lifecycle=[];
  process.env.CRON_SECRET = '';
  assert.equal((await GET(request('synthetic-calibration-cron-secret'))).status, 401);
  assert.equal(state.calls.length, 0, 'a missing server secret fails closed');
  assert.equal(state.collections.length,0);assert.equal(state.lifecycle.length,0);
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.equal(config.crons.filter(cron => cron.path === '/api/cron/soccer-calibration').length, 1);
  assert.equal(config.functions['app/api/cron/soccer-calibration/route.js'].maxDuration, maxDuration);
  console.log('PASS calibration shadow cron: actual secret-authenticated handler, fixed EPL/UCL scope, bounded batches, separate settlement budget, unknown storage failure and isolated league continuation.');
} finally {
  if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  Date.now=previousDateNow;
  delete globalThis.__SOCCER_CALIBRATION_CRON_TEST;
}
