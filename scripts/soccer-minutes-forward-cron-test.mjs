import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
const state={calls:[],failLeague:null,partialLeague:null,advance:0};globalThis.__MINUTES_CRON_TEST=state;
const stub='data:text/javascript,'+encodeURIComponent(`
export async function evaluateSoccerMinutesForward(v){const s=globalThis.__MINUTES_CRON_TEST;s.calls.push({kind:'evaluate',...v});
  s.clock+=s.advance;if(v.league===s.failLeague)throw Error('controlled');return {league:v.league,status:'NO_PENDING_CAPTURES',persisted:true,summary:{checked:0,evaluated:0}};}
export async function collectSoccerMinutesForward(v){const s=globalThis.__MINUTES_CRON_TEST;s.calls.push({kind:'collect',...v});
  if(v.league===s.failLeague)throw Error('controlled');return {league:v.league,status:v.league===s.partialLeague?'PARTIAL':'NO_PENDING_GAMES',persisted:true};}
`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if((c.parentURL||'').endsWith('/app/api/cron/soccer-minutes-forward/route.js')
  &&/minutes-forward-(collection|validation)\\.js$/.test(s))return {url:${JSON.stringify(stub)},shortCircuit:true};return n(s,c);}`),import.meta.url);
const {GET}=await import('../app/api/cron/soccer-minutes-forward/route.js');
const request=secret=>new Request('https://mlb-positive-ev.vercel.app/api/cron/soccer-minutes-forward',{headers:secret?{authorization:'Bearer '+secret}:{}});
const oldSecret=process.env.CRON_SECRET,realNow=Date.now;
try{
  delete process.env.CRON_SECRET;assert.equal((await GET(request('anything'))).status,401);
  process.env.CRON_SECRET='test-only-minutes-cron';assert.equal((await GET(request('wrong'))).status,401);assert.equal(state.calls.length,0);
  state.clock=realNow();Date.now=()=>state.clock;
  const response=await GET(request(process.env.CRON_SECRET)),body=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(state.calls.map(x=>[x.kind,x.league]),[['evaluate','epl'],['evaluate','ucl'],['collect','epl'],['collect','ucl']]);
  assert.ok(state.calls.every(x=>x.timeBudgetMs>0&&x.timeBudgetMs<=(x.kind==='evaluate'?18000:50000)));assert.equal(body.formalEligible,false);
  state.calls=[];state.failLeague='epl';assert.equal((await GET(request(process.env.CRON_SECRET))).status,503);
  assert.equal(state.calls.filter(x=>x.league==='ucl').length,2,'one league outage must not stop the other league');
  state.failLeague=null;state.partialLeague='ucl';assert.equal((await GET(request(process.env.CRON_SECRET))).status,503,'partial source cannot be reported as success');
  state.partialLeague=null;state.advance=160000;state.calls=[];
  const deferred=await(await GET(request(process.env.CRON_SECRET))).json();assert.equal(deferred.ok,false);assert.equal(state.calls.length,1);
  assert.ok(deferred.summaries.concat(deferred.collection).some(x=>x.status==='BUDGET_DEFERRED'));
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.equal(config.functions['app/api/cron/soccer-minutes-forward/route.js'].maxDuration,180);
  assert.ok(config.crons.some(x=>x.path==='/api/cron/soccer-minutes-forward'&&x.schedule==='10 * * * *'));
  assert.ok(config.crons.some(x=>x.path==='/api/cron/soccer-calibration'&&x.schedule==='45 * * * *'));
  console.log('PASS independent minutes cron: authenticated only, both-league evaluation before collection, source/error/deadline isolation, no false partial success and separate scheduled budget (synthetic transport only)');
}finally{Date.now=realNow;if(oldSecret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldSecret;}
