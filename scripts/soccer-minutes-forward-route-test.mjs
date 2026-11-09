import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSessionToken } from '../lib/security.js';

const state = { reads: [], writes: [], fail: false, changed: false };
globalThis.__MINUTES_ROUTE_TEST = state;
const stub = 'data:text/javascript,' + encodeURIComponent(`
export async function readSoccerMinutesForwardReport(...args) {
  const s=globalThis.__MINUTES_ROUTE_TEST;s.reads.push(args);
  if(s.changed)throw Object.assign(Error('private details'),{status:409});
  if(s.fail)throw Error('private database details');return {league:args[0],marker:'server-only',accepted:false,formalEligible:false};
}
export async function evaluateSoccerMinutesForward(args) {
  const s=globalThis.__MINUTES_ROUTE_TEST;s.writes.push(args);
  if(s.fail)throw Error('private provider details');return {summary:{league:args.league,status:'NO_PENDING_CAPTURES',persisted:true},accepted:false,formalEligible:false};
}`);
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){
  if((c.parentURL||'').endsWith('/app/api/soccer/minutes-forward/route.js')&&s.endsWith('/minutes-forward-validation.js'))return {url:${JSON.stringify(stub)},shortCircuit:true};
  return n(s,c);
}`), import.meta.url);
const { GET, POST } = await import('../app/api/soccer/minutes-forward/route.js');
process.env.APP_PASSWORD='test-only-minutes-password';process.env.SESSION_SECRET='test-only-minutes-session';
const token=await createSessionToken(),origin='https://mlb-positive-ev.vercel.app';let ip=0;
const request=(method,{suffix='',auth=true,from=origin,body}={})=>new Request(origin+'/api/soccer/minutes-forward'+suffix,
  {method,headers:{origin:from,'x-forwarded-for':`192.0.2.${++ip}`,...(auth?{cookie:`mlb_session=${token}`}:{})},
  ...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
assert.equal((await GET(request('GET',{auth:false,suffix:'?league=epl'}))).status,401);
assert.equal((await POST(request('POST',{auth:false,body:{league:'epl',action:'evaluate'}}))).status,401);
assert.equal((await POST(request('POST',{from:'https://invalid.example',body:{league:'epl',action:'evaluate'}}))).status,403);
for(const suffix of ['?league=nba','?league=epl&league=ucl','?league=epl&result=3','?league=epl&afterSequence=-1',
  '?league=epl&afterSequence=1','?league=epl&revision=forged','?league=epl&afterSequence=01'])
  assert.equal((await GET(request('GET',{suffix}))).status,400);
for(const extra of [{result:1},{source:'https://invalid.example'},{accepted:true},{modelHash:'a'.repeat(64)},{cutoff:'2026-01-01'}])
  assert.equal((await POST(request('POST',{body:{league:'epl',action:'evaluate',...extra}}))).status,400);
assert.equal((await POST(request('POST',{body:'{bad'}))).status,400);
assert.equal((await POST(request('POST',{body:{league:'epl',action:'collect'}}))).status,400);
assert.equal((await POST(request('POST',{body:'x'.repeat(1100)}))).status,413);
assert.equal(state.reads.length+state.writes.length,0,'all guards run before storage/provider work');
const read=await GET(request('GET',{suffix:'?league=epl'}));assert.equal(read.status,200);
assert.equal(read.headers.get('cache-control'),'no-store');assert.deepEqual(state.reads[0],['epl',{afterSequence:'0',revision:null}]);
assert.equal((await read.json()).report.marker,'server-only');
const write=await POST(request('POST',{body:{league:'ucl',action:'evaluate'}}));assert.equal(write.status,200);
assert.deepEqual(state.writes,[{league:'ucl',limit:2,timeBudgetMs:18000}]);assert.equal((await write.json()).formalEligible,false);
state.changed=true;assert.equal((await GET(request('GET',{suffix:'?league=epl'}))).status,409);state.changed=false;
state.fail=true;
for(const r of [await GET(request('GET',{suffix:'?league=epl'})),await POST(request('POST',{body:{league:'epl',action:'evaluate'}}))]){
  assert.equal(r.status,503);const b=await r.json();assert.equal(b.ok,false);assert.match(b.error,/未知/);assert.equal(b.report,undefined);
  assert.ok(!JSON.stringify(b).includes('private'));
}
console.log('PASS minutes-forward authenticated transport: server-only scope, cursor/revision, body/origin/auth guards, no-store, unknown on failure and safe history restart (synthetic route transport only)');
