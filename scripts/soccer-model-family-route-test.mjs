import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSessionToken } from '../lib/security.js';

const state = { calls: [], error: null };
globalThis.__MODEL_FAMILY_ROUTE_TEST = state;
const stub = 'data:text/javascript,' + encodeURIComponent(`
async function run(action,scope) { const state=globalThis.__MODEL_FAMILY_ROUTE_TEST; state.calls.push({action,scope}); if(state.error)throw state.error;
 return {league:scope.league,period:scope.period,status:'NOT_STARTED',formalEligible:false,executable:false,W:null,R:null,S:null}; }
export const readSoccerModelFamilyScan=scope=>run('read',scope);
export const continueSoccerModelFamilyScan=scope=>run('replay',scope);
export async function freezeSoccerModelFamilyScan(scope) { return {ok:true,freeze:await run('freeze',scope)}; }
`);
register('./next-route-test-loader.mjs', import.meta.url);
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier,context,next) {
 if(specifier.endsWith('/lib/soccer/model-family-scan.js')&&context.parentURL.includes('/api/soccer/model-family/'))return {url:${JSON.stringify(stub)},shortCircuit:true};
 return next(specifier,context); }`), import.meta.url);
process.env.APP_PASSWORD = 'model-family-route-test-only'; process.env.SESSION_SECRET = 'model-family-route-test-secret-only';
const cookie = `mlb_session=${await createSessionToken()}`, origin = 'https://mlb-positive-ev.vercel.app';
const { GET, POST } = await import('../app/api/soccer/model-family/route.js');
let n = 0;
function request(method, { suffix = '', body, auth = true, cross = false, ip } = {}) {
  return new Request(`${origin}/api/soccer/model-family${suffix}`, { method,
    headers: { origin: cross ? 'https://attacker.invalid' : origin, 'x-forwarded-for': ip || `route-${++n}`,
      ...(auth ? { cookie } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
const cursor = 'a'.repeat(48), scope = { league: 'epl', period: 'FT' };
assert.equal((await GET(request('GET', { suffix: '?league=epl&period=FT', auth: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { action: 'replay', ...scope }, auth: false }))).status, 401);
assert.equal((await POST(request('POST', { body: { action: 'replay', ...scope }, cross: true }))).status, 403);
for (const suffix of ['', '?league=epl', '?league=EPL&period=FT', '?league=nba&period=FT', '?league=epl&period=first',
  '?league=epl&period=FT&league=ucl', '?league=epl&period=FT&period=HT', '?league=epl&period=FT&cursor=',
  '?league=epl&period=FT&cursor=bad', '?league=epl&period=FT&alpha=0.01'])
  assert.equal((await GET(request('GET', { suffix }))).status, 400, suffix);
for (const body of [null, [], '{broken', {}, { action: 'replay', league: 'ucl', period: 'HT', cursor: null },
  { action: 'approve', ...scope }, { action: 'freeze', ...scope }, { action: 'replay', league: 'nba', period: 'FT' },
  ...['observations', 'artifact', 'alpha', 'now', 'sourceRevision', 'testFrom', 'modelHash', 'accepted', 'W', 'R', 'S'].map(key => ({ action: 'replay', ...scope, [key]: 'forged' }))])
  assert.equal((await POST(request('POST', { body }))).status, 400, JSON.stringify(body));
assert.equal((await POST(request('POST', { suffix: '?league=epl', body: { action: 'replay', ...scope } }))).status, 400);
assert.equal((await POST(request('POST', { body: JSON.stringify({ action: 'replay', ...scope, padding: 'x'.repeat(1100) }) }))).status, 413);
assert.equal(state.calls.length, 0, 'auth, origin and scope/input rejection happen before any replay, storage or fitting');
let response = await GET(request('GET', { suffix: '?league=epl&period=FT' }));
assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
assert.deepEqual(state.calls.at(-1), { action: 'read', scope });
response = await POST(request('POST', { body: { action: 'replay', league: 'ucl', period: 'HT', cursor } }));
assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
assert.deepEqual(state.calls.at(-1), { action: 'replay', scope: { league: 'ucl', period: 'HT', cursor } });
response = await POST(request('POST', { body: { action: 'freeze', ...scope, cursor } }));
assert.equal(response.status, 200); assert.deepEqual(state.calls.at(-1), { action: 'freeze', scope: { ...scope, cursor } });
state.error = Object.assign(Error('sensitive database credentials or source body'), { code: 'MODEL_FAMILY_DATA_SOURCE_CHANGED', status: 409 });
response = await POST(request('POST', { body: { action: 'replay', ...scope, cursor } }));
assert.equal(response.status, 409); let body = await response.json();
assert.equal(body.code, 'MODEL_FAMILY_DATA_SOURCE_CHANGED'); assert.doesNotMatch(JSON.stringify(body), /sensitive/);
state.error = Object.assign(Error('sensitive storage error'), { code: 'secret', status: 500 });
response = await GET(request('GET', { suffix: '?league=ucl&period=HT' })); body = await response.json();
assert.equal(response.status, 503); assert.equal(body.code, 'MODEL_FAMILY_UNAVAILABLE'); assert.equal(body.report, undefined);
assert.deepEqual([body.W, body.R, body.S], [null, null, null]); assert.match(body.error, /未知/);
state.error = null;
for (let i = 0; i < 60; i++) assert.equal((await POST(request('POST', { body: { action: 'replay', ...scope }, ip: 'rate-test-only' }))).status, 200);
response = await POST(request('POST', { body: { action: 'replay', ...scope }, ip: 'rate-test-only' }));
assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
assert.match(response.headers.get('cache-control'), /no-store/);
delete globalThis.__MODEL_FAMILY_ROUTE_TEST;
console.log('PASS model-family API: authenticated exact league/period/cursor scope, same-origin mutations, no client evidence or controls, no-store, bounded JSON, resumable conflict codes, unknown-on-outage and rate limits');
