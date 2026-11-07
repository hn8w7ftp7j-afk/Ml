import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createSessionToken } from '../lib/security.js';
import { soccerDate } from '../lib/soccer/contracts.js';
const keys=['APP_PASSWORD','SESSION_SECRET'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalNow=Date.now;
process.env.APP_PASSWORD='synthetic-collector-route';process.env.SESSION_SECRET='synthetic-collector-route-secret';
const state={calls:[],elapsed:0,failReport:false};globalThis.__SOCCER_COLLECTOR_ROUTE=state;
Date.now=()=>originalNow()+state.elapsed;
const collector='data:text/javascript,'+encodeURIComponent(`export async function collectSoccerForwardResults(scope,options){
 const state=globalThis.__SOCCER_COLLECTOR_ROUTE;state.calls.push({kind:'collect',scope,options});state.elapsed+=options.timeBudgetMs;
 return {version:'SOCCER-FORWARD-CAPTURE-RESULT-COLLECTOR-v1',checkedCaptureReceipts:3,evaluatedCaptureReceipts:2,pendingCaptureReceipts:1,
 failedCaptureReceipts:0,sampleCountScope:'PHYSICAL_ORIGINAL_CAPTURE_RECEIPTS_NOT_CANONICAL_GAMES',formalEligible:false,executable:false,complete:false};}`);
const scanner='data:text/javascript,'+encodeURIComponent(`export class SoccerForwardScanError extends Error{}
export async function continueSoccerForwardScan(scope,options){const state=globalThis.__SOCCER_COLLECTOR_ROUTE;
 state.calls.push({kind:'scan',scope,options});state.elapsed+=options.timeBudgetMs;
 if(state.failReport)throw Object.assign(new SoccerForwardScanError('controlled incomplete report'),{status:503,publicMessage:'完整報表尚未讀完'});
 return {summary:{evaluated:1,formalEligible:false},report:{complete:false,formalEligible:false}};}`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){
 if((c.parentURL||'').endsWith('/app/api/soccer/forward-validation/route.js')){
 if(s.endsWith('/forward-result-collector.js'))return{url:${JSON.stringify(collector)},shortCircuit:true};
 if(s.endsWith('/forward-validation-scan.js'))return{url:${JSON.stringify(scanner)},shortCircuit:true};}return n(s,c);}`),import.meta.url);
try{
 const {POST,maxDuration}=await import('../app/api/soccer/forward-validation/route.js'),cookie='mlb_session='+await createSessionToken();let ip=0;
 const request=({body={action:'evaluate',league:'epl',date:soccerDate()},auth=true,origin='http://localhost'}={})=>new Request('http://localhost/api/soccer/forward-validation',
 {method:'POST',headers:{...(auth?{cookie}:{}),origin,'x-forwarded-for':'198.51.100.'+(++ip)},body:JSON.stringify(body)});
 assert.equal((await POST(request({auth:false}))).status,401);assert.equal((await POST(request({origin:'https://other.example'}))).status,403);
 assert.equal((await POST(request({body:{action:'evaluate',result:{home:9}}}))).status,400);assert.deepEqual(state.calls,[]);
 const response=await POST(request()),payload=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(state.calls.map(call=>call.kind),['collect','scan']);assert.deepEqual(state.calls[0].options,{receiptLimit:25,timeBudgetMs:8000});
 assert.equal(state.calls[1].options.gameLimit,25);assert.equal(state.calls[1].options.timeBudgetMs,25000);
 assert.equal(state.elapsed,33000);assert.ok(state.elapsed<55000&&state.elapsed<maxDuration*1000,'collection and report deadlines fit the existing client/server ceiling');
 assert.equal(payload.collection.checkedCaptureReceipts,3);assert.equal(payload.summary.evaluated,1,'physical progress cannot relabel canonical summary counts');
 state.calls=[];state.elapsed=0;
 await POST(request({body:{action:'evaluate',league:'epl',date:soccerDate(),cursor:'a'.repeat(48),limit:1}}));
 assert.deepEqual(state.calls.map(call=>call.kind),['scan'],'a frozen report continuation avoids new collection outside its manifest');
 assert.equal(state.calls[0].options.cursor,'a'.repeat(48));assert.equal(state.calls[0].options.gameLimit,1);
 state.calls=[];state.failReport=true;
 const failed=await POST(request()),partial=await failed.json();assert.equal(failed.status,503);
 assert.equal(partial.collection.checkedCaptureReceipts,3);assert.equal(partial.collection.complete,false);
 assert.equal(partial.error,'完整報表尚未讀完','a report timeout preserves independently committed physical receipt progress');
 console.log('PASS actual authenticated collector/report POST: same-origin and injection boundary, bounded 8s+25s work, physical/canonical count separation, frozen cursor continuation and independently durable progress retained on report failure.');
}finally{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}Date.now=originalNow;delete globalThis.__SOCCER_COLLECTOR_ROUTE;}
