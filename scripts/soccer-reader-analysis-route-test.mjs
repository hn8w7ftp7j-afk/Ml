import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { soccerLeague, validSoccerDate } from '../lib/soccer/contracts.js';
import { soccerReaderContinuationScope } from '../lib/soccer/reader-analysis-continuation.js';

const scope={league:'epl',date:'2026-11-07'},runId='wrun_01ARYZ6S41TSV4RRFFQ69G5FAV';
const strip=source=>source.replace(/^import .*?;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export async function /g,'async function ');
const launcherSource=strip(fs.readFileSync('lib/soccer/reader-analysis-launcher.js','utf8'));
let fallbackCallback,fallbackCalls=0,startCalls=0;
const launched=vm.createContext({soccerReaderContinuationScope,soccerReaderCaptureWorkflow:()=>{},
  start:async(workflow,args)=>{startCalls++;assert.equal(args.length,1);assert.deepEqual(JSON.parse(JSON.stringify(args[0])),scope);return{runId};},
  after:callback=>{fallbackCallback=callback;},drainSoccerReaderAnalysis:async value=>{fallbackCalls++;assert.deepEqual(JSON.parse(JSON.stringify(value)),scope);},
});
vm.runInContext(launcherSource+';globalThis.launch=launchSoccerReaderContinuation',launched);
const started=await launched.launch(scope);assert.equal(started.status,'STARTED');assert.equal(started.runId,runId);assert.equal(started.durable,true);
assert.equal(started.executable,false);assert.equal(fallbackCallback,undefined,'successful durable enqueue does not also spawn an after worker');
launched.start=async()=>{throw Error('synthetic start failure');};
const fallback=await launched.launch(scope);assert.equal(fallback.status,'FALLBACK_ONLY');assert.equal(fallback.durable,false);assert.equal(fallbackCalls,0);
await fallbackCallback();assert.equal(fallbackCalls,1,'failed durable start still registers the bounded after-response recovery');
launched.start=async()=>({runId:'wfr_wrong_prefix'});assert.equal((await launched.launch(scope)).status,'FALLBACK_ONLY');
launched.after=()=>{throw Error('no request after context');};assert.equal((await launched.launch(scope)).status,'UNAVAILABLE');
await assert.rejects(()=>launched.launch({...scope,quotes:[]}),/SCOPE_INVALID/);
assert.equal(startCalls,1);

let authorized=true,sameOrigin=true,rateAllowed=true,body={action:'resume',...scope},reader={league:'EPL',boardDate:scope.date},queueCalls=0,launchCalls=0,sourceCalls=0;
const context=vm.createContext({Response,NextResponse:{json:(value,options)=>Response.json(value,options)},soccerLeague,validSoccerDate,
  requireApiAuth:async()=>authorized?null:Response.json({ok:false},{status:401}),validateSameOrigin:()=>sameOrigin,
  originErrorResponse:()=>Response.json({ok:false},{status:403}),checkRateLimit:()=>({allowed:rateAllowed}),
  rateLimitResponse:()=>Response.json({ok:false},{status:429}),readJsonBody:async()=>body,
  loadSoccerReaderSnapshot:async(league,date)=>{sourceCalls++;assert.equal(league,scope.league);assert.equal(date,scope.date);return reader;},
  enqueueSoccerReaderAnalysis:async(league,date)=>{queueCalls++;assert.equal(league,scope.league);assert.equal(date,scope.date);},
  launchSoccerReaderContinuation:async value=>{launchCalls++;assert.deepEqual(JSON.parse(JSON.stringify(value)),scope);return{status:'STARTED',runId,durable:true,executable:false};},
});
vm.runInContext(strip(fs.readFileSync('app/api/soccer/reader-analysis/route.js','utf8'))+';globalThis.post=POST',context);
const request=()=>new Request('https://fixture.invalid/api/soccer/reader-analysis',{method:'POST'});
authorized=false;assert.equal((await context.post(request())).status,401);assert.equal(sourceCalls,0);
authorized=true;sameOrigin=false;assert.equal((await context.post(request())).status,403);assert.equal(sourceCalls,0);
sameOrigin=true;rateAllowed=false;assert.equal((await context.post(request())).status,429);assert.equal(sourceCalls,0);rateAllowed=true;
for(const invalid of [{...body,quotes:[]},{...body,observedAt:new Date().toISOString()},{...body,gameId:'soccer:ucl:1'},
  {...body,runId},{...body,league:'NBA'},{...body,league:'EPL'},{...body,date:'2026-02-30'},{...body,action:'capture'},{league:'epl',date:scope.date}]){
  body=invalid;assert.equal((await context.post(request())).status,400);
}
assert.equal(queueCalls,0);assert.equal(launchCalls,0);
body={action:'resume',...scope};reader=null;assert.equal((await context.post(request())).status,404);assert.equal(queueCalls,0);
reader={league:'UCL',boardDate:scope.date};assert.equal((await context.post(request())).status,503);assert.equal(queueCalls,0,'server source scope conflicts cannot be queued');
reader={league:'EPL',boardDate:scope.date,observedAt:'2026-10-20T00:00:00Z'};
const response=await context.post(request()),result=await response.json();
assert.equal(response.status,200);assert.equal(result.continuation.status,'STARTED');assert.equal(result.continuation.durable,true);
assert.equal(result.executable,false);assert.equal(result.league,scope.league);assert.equal(result.date,scope.date);
assert.equal(queueCalls,1);assert.equal(launchCalls,1,'old saved inputs may start a workflow, whose real matcher will stop without fabricating a fresh forecast');
context.enqueueSoccerReaderAnalysis=async()=>{throw Error('synthetic storage failure');};assert.equal((await context.post(request())).status,503);
assert.equal(launchCalls,1,'queue failure does not acknowledge a workflow start');
console.log('PASS Reader resume/start transport: authenticated same-origin rate-limited scope-only input, immutable server-source scope, actual SDK run ID format, durable enqueue versus completion, start-failure after fallback and storage failure');
