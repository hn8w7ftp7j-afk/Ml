import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerDate, shiftSoccerDate } from '../lib/soccer/contracts.js';
const previous=process.env.CRON_SECRET,originalFetch=globalThis.fetch;
process.env.CRON_SECRET='synthetic-forward-cron-secret';
const state={calls:[],forwardFails:false};globalThis.__SOCCER_FORWARD_CRON_TEST=state;
globalThis.fetch=async()=>{throw Error('Cron fixture must not fetch external providers');};
const exportsByFile={
  'cloud-bet-store.js':{name:'settleOpenCloudBets',kind:'baseball',value:[{status:'SETTLED'},{status:'OPEN'}]},
  'manual-bet-settlement-service.js':{name:'settleOpenNbaManualRecords',kind:'nba',value:{settled:1}},
  'manual-settlement-service.js':{name:'settleOpenSoccerManualRecords',kind:'soccer',value:{settled:0,pending:2}},
  'forward-validation-scan.js':{name:'continueSoccerForwardBacklog',kind:'forward',value:{summary:{evaluated:0,pending:0,formalEligible:false}}},
};
const routes=Object.fromEntries(Object.entries(exportsByFile).map(([file,{name,kind,value}])=>[file,'data:text/javascript,'+encodeURIComponent(`
export async function ${name}(...args){const state=globalThis.__SOCCER_FORWARD_CRON_TEST;state.calls.push({kind:${JSON.stringify(kind)},args});
if(${JSON.stringify(kind)}==='forward'&&state.forwardFails)throw Error('controlled forward source/DB failure');return ${JSON.stringify(value)};}`)]));
register('data:text/javascript,'+encodeURIComponent(`const routes=${JSON.stringify(routes)};
export async function resolve(s,c,n){if((c.parentURL||'').endsWith('/app/api/cron/bet-settlements/route.js')){
const file=s.split('/').at(-1);if(routes[file])return {url:routes[file],shortCircuit:true};}return n(s,c);}`),import.meta.url);
try {
  const {GET,maxDuration}=await import('../app/api/cron/bet-settlements/route.js');
  const req=authorized=>new Request('http://localhost/api/cron/bet-settlements?result=999',{headers:authorized?{authorization:'Bearer '+process.env.CRON_SECRET}:{}});
  assert.equal((await GET(req(false))).status,401);assert.equal(state.calls.length,0,'unauthorized cron cannot read/write/fetch any data');
  const response=await GET(req(true));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const payload=await response.json();assert.deepEqual(payload.summary,{SETTLED:1,OPEN:1});assert.equal(payload.soccerForward.formalEligible,false);
  assert.deepEqual(state.calls.map(row=>row.kind),['nba','soccer','forward','baseball']);
  const forward=state.calls.find(row=>row.kind==='forward');
  assert.deepEqual(forward.args[0],{from:shiftSoccerDate(soccerDate(),-7),through:soccerDate()});
  assert.deepEqual(forward.args[1],{gameLimit:5,timeBudgetMs:8000});
  assert.equal(state.calls.reduce((total,row)=>total+(row.kind==='forward'?row.args[1].timeBudgetMs:row.args[0].timeBudgetMs),0),278000);
  assert.ok(278000<maxDuration*1000,'combined declared budgets leave overhead within the actual 300 s cron duration');
  state.calls=[];state.forwardFails=true;
  const failed=await GET(req(true));assert.equal(failed.status,200);const limited=await failed.json();
  assert.deepEqual(limited.soccerForward,{status:'unavailable',evaluated:0,formalEligible:false});
  assert.equal(state.calls.at(-1).kind,'baseball','a forward evidence failure cannot stop existing settlement work');
  assert.deepEqual(limited.summary,{SETTLED:1,OPEN:1});
  console.log('PASS soccer forward cron: secret-authenticated actual handler, last-seven-day server scope, 5-game/8-second result budget, total 278/300 seconds, isolated evidence failure and unchanged existing settlement flow.');
}finally{
  if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous;
  globalThis.fetch=originalFetch;delete globalThis.__SOCCER_FORWARD_CRON_TEST;
}
