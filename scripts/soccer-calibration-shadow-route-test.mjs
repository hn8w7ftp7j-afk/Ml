import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSessionToken } from '../lib/security.js';

const state = { bootstrap: [], collections: [], registered: new Set(), bootstrapStatus: null, throwBootstrap: false, failCollection: false };
globalThis.__SOCCER_CALIBRATION_ROUTE_TEST = state;
const stub = 'data:text/javascript,' + encodeURIComponent(`
export async function bootstrapSoccerReturnErrorProtocol(options) {
  const state=globalThis.__SOCCER_CALIBRATION_ROUTE_TEST;
  state.bootstrap.push(options);
  if(state.throwBootstrap)throw Error('controlled unexpected bootstrap failure');
  const existing=state.registered.has(options.league),status=state.bootstrapStatus||(existing?'ALREADY_REGISTERED_RESEARCH_ONLY':'REGISTERED_RESEARCH_ONLY');
  const configured=['REGISTERED_RESEARCH_ONLY','ALREADY_REGISTERED_RESEARCH_ONLY'].includes(status);
  if(configured)state.registered.add(options.league);
  return {league:options.league,status,configured,persisted:configured||status==='PROTOCOL_CONFLICT',
    protocolId:configured?'a'.repeat(64):null,registeredAt:configured?'2026-11-08T08:00:00.000Z':null,
    manifestHash:'b'.repeat(64),planHash:'c'.repeat(64),accepted:false,formalEligible:false,executable:false,W:null,R:null,S:null};
}
export async function collectSoccerCalibrationPredictions(options) {
  const state=globalThis.__SOCCER_CALIBRATION_ROUTE_TEST;
  state.collections.push(options);
  if(state.failCollection)throw Error('CALIBRATION_COLLECTION_SOURCE_UNAVAILABLE');
  return {league:options.league,status:'NO_PENDING_GAMES',persisted:true,formalEligible:false,executable:false};
}`);
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier,context,next) {
  if((context.parentURL||'').endsWith('/app/api/soccer/calibration-shadow/route.js')
    &&(specifier.endsWith('/return-error-bootstrap.js')||specifier.endsWith('/calibration-collection.js')))
    return {url:${JSON.stringify(stub)},shortCircuit:true};
  return next(specifier,context);
}`), import.meta.url);
const { GET, POST } = await import('../app/api/soccer/calibration-shadow/route.js');

process.env.APP_PASSWORD = 'test-only-shadow-password';
process.env.SESSION_SECRET = 'test-only-shadow-site-secret';
for (const key of ['DATABASE_V2_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) delete process.env[key];
const siteToken = await createSessionToken(), origin = 'https://mlb-positive-ev.vercel.app';
let requestSequence = 0;
const request = (method, { suffix = '', authenticated = true, requestOrigin = origin, body } = {}) => new Request(`${origin}/api/soccer/calibration-shadow${suffix}`, {
  method, headers: { origin: requestOrigin, 'x-forwarded-for': `192.0.2.${++requestSequence}`, ...(authenticated ? { Cookie: `mlb_session=${siteToken}` } : {}),
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
assert.equal((await GET(request('GET', { suffix: '?league=epl', authenticated: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate' }, authenticated: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate' }, requestOrigin: 'https://attacker.invalid' }))).status, 403);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'collect' }, authenticated: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'collect' }, requestOrigin: 'https://attacker.invalid' }))).status, 403);
for (const suffix of ['?league=nba', '?league=epl&league=ucl', '?league=epl&candidateHash=forged',
  '?league=epl&page=2','?league=epl&afterSequence=1','?league=epl&page=1&afterSequence=1',
  '?league=epl&page=1&afterSequence=-1','?league=epl&page=1&revision=forged'])
  assert.equal((await GET(request('GET', { suffix }))).status, 400);
assert.equal((await POST(request('POST', { body: { league: 'epl', action: 'evaluate', result: { home: 3, away: 0 } } }))).status, 400,
  'a signed-in caller still cannot supply a prediction, result, source URL or candidate approval');
assert.equal((await POST(request('POST', { body: '{bad json' }))).status, 400);
const unavailableRead = await GET(request('GET', { suffix: '?league=epl' }));
assert.equal(unavailableRead.status, 503); assert.equal(unavailableRead.headers.get('cache-control'), 'no-store');
const missing = await unavailableRead.json(); assert.equal(missing.ok, false); assert.match(missing.error, /未知/);
assert.equal(missing.report, undefined, 'database failure must not appear as a genuine zero-game report');
const unavailableWrite = await POST(request('POST', { body: { league: 'ucl', action: 'evaluate' } }));
assert.equal(unavailableWrite.status, 503); assert.equal((await unavailableWrite.json()).ok, false);
assert.equal((await POST(request('POST', { body: JSON.stringify({ league: 'epl', action: 'evaluate', padding: 'x'.repeat(1100) }) }))).status, 413);
for (const field of ['from','trainingBefore','calibrationBefore','testBefore','miscoverage','protocolId'])
  assert.equal((await POST(request('POST', { body: { league:'epl',action:'collect',[field]:'caller-chosen' } }))).status,400,
    'calendar boundaries, parameters and protocol identities come only from the frozen server manifest');
assert.equal((await POST(request('POST', { body:{league:'nba',action:'collect'} }))).status,400);
assert.equal(state.bootstrap.length,0,'login, origin, body and league guards run before research registration');
assert.equal(state.collections.length,0);
const collect = await POST(request('POST',{body:{league:'epl',action:'collect'}})),first=await collect.json();
assert.equal(collect.status,200);assert.equal(collect.headers.get('cache-control'),'no-store');assert.equal(first.ok,true);
assert.deepEqual(state.bootstrap,[{league:'epl',timeBudgetMs:5000}]);
assert.deepEqual(state.collections,[{league:'epl',limit:2,timeBudgetMs:50000}]);
assert.equal(first.returnErrorBootstrap.status,'REGISTERED_RESEARCH_ONLY');
assert.equal(first.returnErrorBootstrap.configured,true);assert.equal(first.returnErrorBootstrap.persisted,true);
assert.equal(first.returnErrorBootstrap.accepted,false);assert.equal(first.returnErrorBootstrap.formalEligible,false);
assert.equal(first.returnErrorBootstrap.executable,false);
assert.deepEqual([first.returnErrorBootstrap.W,first.returnErrorBootstrap.R,first.returnErrorBootstrap.S],[null,null,null]);
const repeated=await (await POST(request('POST',{body:{league:'epl',action:'collect'}}))).json();
assert.equal(repeated.returnErrorBootstrap.status,'ALREADY_REGISTERED_RESEARCH_ONLY');
assert.equal(repeated.returnErrorBootstrap.protocolId,first.returnErrorBootstrap.protocolId);
for(const status of ['NOT_VERIFIED','PROTOCOL_CONFLICT','REGISTRATION_CLOSED']) {
  state.bootstrapStatus=status;
  const before=state.collections.length;
  const failed=await POST(request('POST',{body:{league:'ucl',action:'collect'}})),body=await failed.json();
  assert.equal(failed.status,200);assert.equal(body.ok,true,'research registration failure cannot block independent calibration collection');
  assert.equal(body.returnErrorBootstrap.status,status);assert.equal(body.returnErrorBootstrap.configured,false);
  assert.equal(state.collections.length,before+1);
  assert.equal(body.summary.persisted,true);
}
state.bootstrapStatus=null;state.throwBootstrap=true;
const unexpected=await (await POST(request('POST',{body:{league:'ucl',action:'collect'}}))).json();
assert.equal(unexpected.ok,true);assert.equal(unexpected.summary.persisted,true);
assert.equal(unexpected.returnErrorBootstrap.status,'NOT_VERIFIED');assert.equal(unexpected.returnErrorBootstrap.configured,false);
assert.equal(unexpected.returnErrorBootstrap.persisted,false);assert.equal(unexpected.returnErrorBootstrap.reason,'RETURN_ERROR_BOOTSTRAP_UNAVAILABLE');
state.throwBootstrap=false;state.failCollection=true;
const sourceFailure=await POST(request('POST',{body:{league:'epl',action:'collect'}})),sourceFailureBody=await sourceFailure.json();
assert.equal(sourceFailure.status,503);assert.equal(sourceFailureBody.ok,false);assert.match(sourceFailureBody.error,/未知/);
assert.equal(sourceFailureBody.returnErrorBootstrap.status,'ALREADY_REGISTERED_RESEARCH_ONLY');
assert.equal(sourceFailureBody.returnErrorBootstrap.configured,true);assert.equal(sourceFailureBody.returnErrorBootstrap.persisted,true,
  'a later source collection failure must retain the independent durable research registration receipt');
assert.equal(sourceFailureBody.summary,undefined);assert.equal(sourceFailureBody.checkedGames,undefined);
assert.equal(sourceFailureBody.capturedGames,undefined,'source failure must not fabricate empty or successful collection counts');
assert.equal(state.bootstrap.length,state.collections.length,'every valid collect has exactly one bootstrap attempt and still reaches collection');
delete globalThis.__SOCCER_CALIBRATION_ROUTE_TEST;
console.log('PASS calibration shadow routes: login, same-origin, fixed league scope, caller result rejection, body limits, no-store and explicit unknown on database failure');
console.log('PASS existing authenticated collect performs bounded server-only research bootstrap, preserves repeat receipts and collection on typed/unexpected registration failure; no calendar input or formal acceptance');
