import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../app/api/cron/bet-settlements/route.js',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const stages=['NBA','SOCCER','FORWARD','READER_ANALYSIS','CLOUD'];
const countKeys={
  NBA:['checked','settled','pending','deferred'],SOCCER:['checked','resultVerified','settled','pending','deferred'],
  FORWARD:['checkedCaptureReceipts','evaluatedCaptureReceipts','pendingCaptureReceipts','failedCaptureReceipts','sourceRequests'],
  READER_ANALYSIS:['checked','captured','refreshed','duplicate','retryable','deferred'],CLOUD:['returnedTickets','deferred'],
};
const privateMarker='PRIVATE_SENTINEL_ACCOUNT_TOKEN_123456789';
const values={
  NBA:{checked:4,settled:2,pending:2,deferred:0,records:[privateMarker]},
  SOCCER:{checked:2,resultVerified:1,settled:1,pending:1,deferred:0,reasons:{[privateMarker]:1}},
  FORWARD:{checkedCaptureReceipts:3,pendingCaptureReceipts:2,failedCaptureReceipts:0,formalEligible:false,source:privateMarker},
  READER_ANALYSIS:{checked:1,captured:1,refreshed:0,duplicate:0,retryable:0,deferred:0,executable:false,gameId:privateMarker},
  CLOUD:[{status:'SETTLED',stake:123456,id:privateMarker},{status:'OPEN',contract:privateMarker}],
};
const clone=value=>JSON.parse(JSON.stringify(value));
function harness({failures={},durations={},heldStage=null,throwLogger=false}={}) {
  let clock=1000000,release;
  const gate=new Promise(resolve=>{release=resolve;}),calls=[],logs=[];
  const task=stage=>async options=>{
    calls.push({stage,options:clone(options)});
    clock+=durations[stage]??({NBA:15000,SOCCER:15000,FORWARD:8000,READER_ANALYSIS:10000,CLOUD:1000}[stage]);
    if(stage===heldStage)await gate;
    if(failures[stage])throw failures[stage];
    return clone(values[stage]);
  };
  const context=vm.createContext({
    NextResponse:{json:(body,options)=>Response.json(body,options)},Date:{now:()=>clock},
    process:{env:{CRON_SECRET:'synthetic-secret'}},
    console:{info:(tag,json)=>{if(throwLogger)throw Error('logger unavailable');logs.push({tag,...JSON.parse(json)});}},
    settleOpenNbaManualRecords:task('NBA'),settleOpenSoccerManualRecords:task('SOCCER'),
    collectSoccerForwardBacklog:task('FORWARD'),drainSoccerReaderAnalysis:task('READER_ANALYSIS'),settleOpenCloudBets:task('CLOUD'),
  });
  vm.runInContext(source+'\nglobalThis.handler=GET;',context);
  return {calls,logs,release,advance:milliseconds=>{clock+=milliseconds;},
    run:(authorized=true)=>context.handler(new Request('https://fixture.invalid/api/cron/bet-settlements',{
      headers:authorized?{authorization:'Bearer synthetic-secret'}:{}}))};
}
function checkSafeLogs(logs) {
  assert.equal(JSON.stringify(logs).includes(privateMarker),false,'logs contain no account/result/error content');
  for(const entry of logs) {
    assert.equal(entry.tag,'[BET_SETTLEMENT_CRON_STAGE]');
    assert.ok([...stages,'ROUTE'].includes(entry.stage));
    assert.ok(['START','COMPLETE','ERROR'].includes(entry.event));
    assert.ok(Number.isSafeInteger(entry.elapsedMs)&&entry.elapsedMs>=0);
    assert.ok(Object.keys(entry).every(key=>['tag','stage','event','elapsedMs','routeElapsedMs','counts','errorClass'].includes(key)));
    if(entry.counts){
      assert.ok(Object.keys(entry.counts).every(key=>countKeys[entry.stage]?.includes(key)),'only stage-specific count keys are logged');
      assert.ok(Object.values(entry.counts).every(value=>Number.isSafeInteger(value)&&value>=0));
    }
  }
}
const expected={ok:true,summary:{SETTLED:1,OPEN:1},nba:values.NBA,soccer:values.SOCCER,
  soccerForward:values.FORWARD,soccerReaderCapture:values.READER_ANALYSIS,settlementDeferred:false};
const normal=harness();
assert.equal((await normal.run(false)).status,401);assert.deepEqual(normal.calls,[]);assert.deepEqual(normal.logs,[]);
const response=await normal.run();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
assert.deepEqual(await response.json(),expected,'observation must not change existing successful response fields');
assert.deepEqual(normal.calls.map(call=>call.stage),stages);
assert.deepEqual(normal.calls.map(call=>call.options),[
  {limit:100,timeBudgetMs:15000},{limit:100,timeBudgetMs:15000},{receiptLimit:12,timeBudgetMs:8000},
  {timeBudgetMs:10000,maxGames:1},{limit:500,timeBudgetMs:230000},
]);
assert.deepEqual(normal.logs.map(log=>[log.stage,log.event]),[...stages.flatMap(stage=>[[stage,'START'],[stage,'COMPLETE']]),['ROUTE','COMPLETE']]);
assert.equal(normal.logs.at(-1).elapsedMs,49000);checkSafeLogs(normal.logs);

const failures={NBA:Object.assign(Error(privateMarker),{name:'NeonDbError'}),
  SOCCER:Object.assign(Error(privateMarker),{code:'55P03'}),FORWARD:Object.assign(Error(privateMarker),{status:429}),
  READER_ANALYSIS:Object.assign(Error(privateMarker),{name:'TimeoutError'})};
const limited=harness({failures});const limitedResponse=await limited.run();assert.equal(limitedResponse.status,200);
assert.deepEqual(await limitedResponse.json(),{...expected,nba:{status:'unavailable',settled:0},soccer:{status:'unavailable',settled:0},
  soccerForward:{status:'unavailable',checkedCaptureReceipts:0,formalEligible:false},soccerReaderCapture:{status:'unavailable',captured:0,executable:false}});
assert.deepEqual(limited.logs.filter(log=>log.event==='ERROR').map(log=>log.errorClass),['DATABASE_ERROR','LOCK_UNAVAILABLE','RATE_LIMIT','TIMEOUT']);
assert.equal(limited.calls.at(-1).stage,'CLOUD','recoverable dependency failures still allow existing cloud settlement');checkSafeLogs(limited.logs);

const cloudFailure=harness({failures:{CLOUD:Object.assign(Error(privateMarker),{code:'ECONNRESET'})}});
const unavailable=await cloudFailure.run();assert.equal(unavailable.status,503);
assert.deepEqual(await unavailable.json(),{ok:false,error:privateMarker},'existing error response is unchanged; only logs are sanitized');
assert.deepEqual(cloudFailure.logs.slice(-2).map(log=>[log.stage,log.event,log.errorClass]),[['CLOUD','ERROR','NETWORK_ERROR'],['ROUTE','ERROR','NETWORK_ERROR']]);
checkSafeLogs(cloudFailure.logs);

// Leave a real dependency promise pending. Its START must be visible before
// it resolves, with no invented completion and no detached settlement work.
const held=harness({heldStage:'READER_ANALYSIS'}),pending=held.run();
for(let attempt=0;attempt<20&&!held.calls.some(call=>call.stage==='READER_ANALYSIS');attempt++)await Promise.resolve();
assert.deepEqual(held.logs.at(-1).stage,'READER_ANALYSIS');assert.equal(held.logs.at(-1).event,'START');
assert.equal(held.calls.some(call=>call.stage==='CLOUD'),false);assert.equal(held.logs.some(log=>log.stage==='ROUTE'),false);
held.advance(75000);held.release();assert.deepEqual(await (await pending).json(),expected);
assert.equal(held.logs.find(log=>log.stage==='READER_ANALYSIS'&&log.event==='COMPLETE').elapsedMs,85000);
assert.equal(held.calls.at(-1).options.timeBudgetMs,155000,'elapsed-time budget deduction remains unchanged');checkSafeLogs(held.logs);

const exhausted=harness({durations:{READER_ANALYSIS:250000}});const exhaustedBody=await (await exhausted.run()).json();
assert.deepEqual(exhaustedBody,{...expected,summary:{},settlementDeferred:true});
assert.equal(exhausted.calls.some(call=>call.stage==='CLOUD'),false);
assert.deepEqual(exhausted.logs.find(log=>log.stage==='CLOUD'&&log.event==='COMPLETE').counts,{returnedTickets:0,deferred:1});checkSafeLogs(exhausted.logs);
const brokenLogger=harness({throwLogger:true});assert.deepEqual(await (await brokenLogger.run()).json(),expected);
assert.deepEqual(brokenLogger.calls.map(call=>call.stage),stages,'log output failure cannot stop settlement work');
console.log('PASS settlement cron observation: authenticated actual handler, unchanged successful/fallback/error/slow/deferred responses and budgets, visible in-flight stage, safe fixed log fields, no detached work, logger failure isolation.');
