import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerDate, shiftSoccerDate } from '../lib/soccer/contracts.js';
const previous=process.env.CRON_SECRET,originalFetch=globalThis.fetch,originalNow=Date.now;
process.env.CRON_SECRET='synthetic-forward-cron-secret';
const state={calls:[],forwardFails:false,readerFails:false,elapsed:0,readerMs:10000};globalThis.__SOCCER_FORWARD_CRON_TEST=state;
Date.now=()=>originalNow()+state.elapsed;
globalThis.fetch=async()=>{throw Error('Cron fixture must not fetch external providers');};
const exportsByFile={
  'cloud-bet-store.js':{name:'settleOpenCloudBets',kind:'baseball',value:[{status:'SETTLED'},{status:'OPEN'}]},
  'manual-bet-settlement-service.js':{name:'settleOpenNbaManualRecords',kind:'nba',value:{settled:1}},
  'manual-settlement-service.js':{name:'settleOpenSoccerManualRecords',kind:'soccer',value:{settled:0,pending:2}},
  'forward-validation-scan.js':{name:'continueSoccerForwardBacklog',kind:'forward',value:{summary:{evaluated:0,pending:0,formalEligible:false}}},
  'reader-auto-analysis.js':{name:'drainSoccerReaderAnalysis',kind:'reader',value:{captured:1,executable:false}},
};
const routes=Object.fromEntries(Object.entries(exportsByFile).map(([file,{name,kind,value}])=>[file,'data:text/javascript,'+encodeURIComponent(`
export async function ${name}(...args){const state=globalThis.__SOCCER_FORWARD_CRON_TEST;state.calls.push({kind:${JSON.stringify(kind)},args});
const kind=${JSON.stringify(kind)};
if(kind!=='baseball')state.elapsed+=kind==='reader'?state.readerMs:kind==='forward'?args[1].timeBudgetMs:args[0].timeBudgetMs;
if(kind==='forward'&&state.forwardFails)throw Error('controlled forward source/DB failure');
if(kind==='reader'&&state.readerFails)throw Error('controlled reader source/DB failure');return ${JSON.stringify(value)};}`)]));
register('data:text/javascript,'+encodeURIComponent(`const routes=${JSON.stringify(routes)};
export async function resolve(s,c,n){if((c.parentURL||'').endsWith('/app/api/cron/bet-settlements/route.js')){
const file=s.split('/').at(-1);if(routes[file])return {url:routes[file],shortCircuit:true};}return n(s,c);}`),import.meta.url);
try {
  const {GET,maxDuration}=await import('../app/api/cron/bet-settlements/route.js');
  const req=authorized=>new Request('http://localhost/api/cron/bet-settlements?result=999',{headers:authorized?{authorization:'Bearer '+process.env.CRON_SECRET}:{}});
  assert.equal((await GET(req(false))).status,401);assert.equal(state.calls.length,0,'unauthorized cron cannot read/write/fetch any data');
  const response=await GET(req(true));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const payload=await response.json();assert.deepEqual(payload.summary,{SETTLED:1,OPEN:1});assert.equal(payload.soccerForward.formalEligible,false);
  assert.deepEqual(state.calls.map(row=>row.kind),['nba','soccer','forward','reader','baseball']);
  const forward=state.calls.find(row=>row.kind==='forward');
  assert.deepEqual(forward.args[0],{from:shiftSoccerDate(soccerDate(),-7),through:soccerDate()});
  assert.deepEqual(forward.args[1],{gameLimit:5,timeBudgetMs:8000});
  assert.deepEqual(state.calls.find(row=>row.kind==='reader').args[0],{timeBudgetMs:10000,maxGames:1});
  const remaining=state.calls.at(-1).args[0].timeBudgetMs;
  assert.ok(remaining>229000&&remaining<=230000,'remaining settlement budget deducts all work actually elapsed');
  assert.ok(state.elapsed+remaining<=278000&&278000<maxDuration*1000,'at least 22 s remains for route overhead');
  assert.equal(payload.settlementDeferred,false);assert.equal(payload.soccerReaderCapture.captured,1);
  state.calls=[];state.forwardFails=true;state.readerFails=true;state.elapsed=0;
  const failed=await GET(req(true));assert.equal(failed.status,200);const limited=await failed.json();
  assert.deepEqual(limited.soccerForward,{status:'unavailable',evaluated:0,formalEligible:false});
  assert.deepEqual(limited.soccerReaderCapture,{status:'unavailable',captured:0,executable:false});
  assert.equal(state.calls.at(-1).kind,'baseball','a forward evidence failure cannot stop existing settlement work');
  assert.deepEqual(limited.summary,{SETTLED:1,OPEN:1});
  // A slow external request can overrun its soft budget. Never pass zero into
  // the ledger API, where zero intentionally means the default 240-second run.
  state.calls=[];state.elapsed=0;state.readerMs=250000;
  const exhausted=await (await GET(req(true))).json();
  assert.equal(exhausted.settlementDeferred,true);assert.deepEqual(exhausted.summary,{});
  assert.ok(state.calls.every(row=>row.kind!=='baseball'),'expired route explicitly defers settlement instead of resetting its budget');
  console.log('PASS soccer forward/Reader cron: actual authenticated handler, bounded isolated background work, remaining-time settlement budget, explicit exhaustion deferral, and source/DB failure recovery.');
}finally{
  if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous;
  globalThis.fetch=originalFetch;Date.now=originalNow;delete globalThis.__SOCCER_FORWARD_CRON_TEST;
}
