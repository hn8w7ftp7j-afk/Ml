import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Run the real read/publication SQL against PostgreSQL, not a SQL-text matcher.
const fixture=await soccerSqlFixture(),{db}=fixture;
const envKeys=['DATABASE_URL','DATABASE_V2_URL'],old=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-current-status';delete process.env.DATABASE_V2_URL;
try{
  const {beginSoccerAnalysisRun,finishSoccerAnalysisRun,getSoccerCurrentResearchStatus}=await import('../lib/soccer/journal.js');
  const scope={league:'epl',date:'2026-10-20',gameId:'soccer:epl:123'},read=()=>getSoccerCurrentResearchStatus(scope.league,scope.date,scope.gameId);
  assert.equal((await read()).reason,'NO_ANALYSIS');
  const a=await beginSoccerAnalysisRun(scope);
  assert.equal((await read()).reason,'REANALYSIS_PENDING');
  const finish=(run,revision,validUntil=new Date(Date.now()+60000).toISOString())=>finishSoccerAnalysisRun(run,{analysisStatus:'COMPLETED',qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',revision,validUntil});
  assert.equal((await finish(a,'revision-a')).publishedCurrent,true);
  const first=await read();assert.equal(first.publishedCurrent,true);assert.equal(first.reason,'ACTIVE');
  assert.equal(first.revision,'revision-a');assert.equal(first.analysisRunId,a.runId);assert.equal(first.executable,false);assert.equal(first.formalScoringEnabled,false);
  assert.ok(Date.parse(first.validUntil)>Date.parse(first.checkedAt));
  const b=await beginSoccerAnalysisRun(scope);assert.equal((await read()).publishedCurrent,false,'a newer request invalidates the current read before completing');
  assert.equal((await finish(a,'revision-a')).publishedCurrent,false,'a late retry of the old result cannot become current');
  await finish(b,'revision-b');
  const immutableBefore=(await db.query('SELECT * FROM sports_soccer_analysis_events_v2 ORDER BY run_id')).rows;
  await db.query(`INSERT INTO sports_soccer_source_heads_v2(league,board_date,quote_generation,content_hash) VALUES ('epl','2026-10-20',1,'new-price')`);
  const repriced=await read();assert.equal(repriced.publishedCurrent,false);assert.equal(repriced.reason,'QUOTE_CHANGED','read fencing detects generation changes even without clearing the projection');
  assert.deepEqual((await db.query('SELECT * FROM sports_soccer_analysis_events_v2 ORDER BY run_id')).rows,immutableBefore,'read-time invalidation never edits completed events');
  const c=await beginSoccerAnalysisRun(scope);await finish(c,'revision-c');
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET valid_until=clock_timestamp()-interval '1 second'`);
  const expired=await read();assert.equal(expired.publishedCurrent,false);assert.equal(expired.reason,'EXPIRED');assert.equal(expired.revision,'revision-c','an expired revision remains identifiable for history');
  const failed=await beginSoccerAnalysisRun(scope);await finishSoccerAnalysisRun(failed,{analysisStatus:'FAILED',qaFlag:'BLOCKED',reasons:['SOURCE_FAILED']});
  assert.equal((await read()).reason,'ANALYSIS_NOT_COMPLETED');
  assert.equal((await getSoccerCurrentResearchStatus('ucl',scope.date,'soccer:ucl:123')).reason,'NO_ANALYSIS');
  await assert.rejects(()=>getSoccerCurrentResearchStatus('epl',scope.date,'soccer:ucl:123'),/SCOPE_INVALID/);
  console.log('PASS current research PostgreSQL: no/pending/active/expired/failed states, current-request and quote-generation fencing, immutable history and league isolation');
}finally{for(const key of envKeys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await fixture.close();}

// Execute the shipped route handlers. Only external/auth/store dependencies are
// substituted; these assertions exercise the real request and response branches.
const routeSource=fs.readFileSync('app/api/soccer/analysis/route.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export const /g,'const ').replace(/export async function /g,'async function ');
const {analyzeSoccerGame:sharedAnalyze,validSoccerAnalysisQuery}=await import('../lib/soccer/analysis-service.js');
const at=Date.parse('2026-10-20T12:59:30Z'),kickoff='2026-10-20T13:00:00.000Z';
let historyReads=0,sourceReads=0,currentLoads=0,savedResult=null,finishInput=null,denied=false,currentActive=true,currentReadError=false,publicationCurrent=true,receiptPatch={};
const run={runId:'run-new',requestSeq:'4',quoteGeneration:'2',startedAt:new Date(at).toISOString()};
const current=()=>({analysisRunId:run.runId,revision:'saved-revision',qualificationVersion:'4',quoteGeneration:'2',checkedAt:new Date(at).toISOString(),validUntil:kickoff,publishedCurrent:currentActive,reason:currentActive?'ACTIVE':'QUOTE_CHANGED',analysisStatus:'COMPLETED',selectionResult:currentActive?'RESEARCH_SHADOW':null,executable:false,formalScoringEnabled:false,...receiptPatch});
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date:'2026-10-20',startTime:kickoff,status:'scheduled'};
const readCurrent=async()=>{if(currentReadError)throw Error('controlled current-status outage');return current();};
const deps={
  beginSoccerAnalysisRun:async()=>run,recordSoccerCohort:async()=>{},fetchSoccerSchedule:async()=>{sourceReads++;return{ok:true,games:[game]};},
  fetchSoccerPrematch:async()=>({ok:true,source:{fetchedAt:new Date(at).toISOString()}}),fetchSoccerWorkload:async()=>({ok:false}),loadSoccerReaderSnapshot:async()=>null,
  fetchSoccerTeamXg:async()=>({ok:false,reason:'TEAM_XG_NOT_PART_OF_FIXTURE'}),
  listSoccerAnalysis:async()=>[],
  buildSoccerAnalysis:()=>({analysisHash:'discarded',ok:true,status:'RESEARCH_ONLY',league:'epl',date:game.date,gameId:game.id,analysisStatus:'COMPLETED',qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',executable:false,formalScoringEnabled:false}),
  soccerAnalysisHash:value=>{assert.ok(value.validUntil,'the shared service hashes the expiry into the immutable snapshot');return 'snapshot-hash';},
  saveSoccerAnalysis:async value=>{savedResult=value;return{persisted:true,revision:'saved-revision'};},
  finishSoccerAnalysisRun:async(_run,value)=>{finishInput=value;return{publishedCurrent:publicationCurrent};},
  getSoccerCurrentResearchStatus:readCurrent,
};
const context=vm.createContext({URL,Date,Number,JSON,Promise,NextResponse:{json:(body,options)=>Response.json(body,options)},
  requireApiAuth:async()=>denied?Response.json({ok:false},{status:401}):null,validateSameOrigin:()=>true,originErrorResponse:()=>Response.json({ok:false},{status:403}),
  checkRateLimit:()=>({allowed:true}),rateLimitResponse:()=>Response.json({ok:false},{status:429}),readJsonBody:request=>request.json(),
  soccerLeague:value=>value==='epl'?{id:'epl'}:value==='ucl'?{id:'ucl'}:null,validSoccerDate:value=>/^\d{4}-\d{2}-\d{2}$/.test(value||''),
  getSoccerCurrentResearchStatus:readCurrent,listSoccerAnalysis:async()=>{historyReads++;return[];},listSoccerRunHistory:async()=>{historyReads++;return[];},
  validSoccerAnalysisQuery,analyzeSoccerGame:query=>sharedAnalyze(query,deps),
  loadSoccerCurrentAnalysis:async()=>{currentLoads++;return{currentVersion:{revision:'saved-revision',persisted:true},currentRun:{analysisRunId:run.runId}};},
});
vm.runInContext(routeSource+';globalThis.handlers={GET,POST};',context);
const url='https://fixture.invalid/api/soccer/analysis?league=epl&date=2026-10-20&eventId=123';
const light=await context.handlers.GET(new Request(url+'&view=current')),lightBody=await light.json();
assert.equal(light.status,200);assert.equal(historyReads,0);assert.equal(sourceReads,0);assert.equal(currentLoads,0);assert.equal(lightBody.currentResearch.publishedCurrent,true);assert.equal(lightBody.versions,undefined);assert.equal(lightBody.currentVersion,undefined);
assert.equal(light.headers.get('cache-control'),'no-store');
for(const suffix of ['&view=current&view=current','&view=other','&unknown=1','&date=2026-10-20'])assert.equal((await context.handlers.GET(new Request(url+suffix))).status,400);
for(const eventId of ['0','9007199254740992','../123'])assert.equal((await context.handlers.GET(new Request(url.replace('eventId=123',`eventId=${eventId}`)))).status,400,'shared safe event-id validation must remain intact');
const normal=await context.handlers.GET(new Request(url)),normalBody=await normal.json();
assert.equal(normal.status,200);assert.equal(historyReads,2);assert.equal(currentLoads,1);assert.equal(sourceReads,0);
assert.deepEqual(normalBody.versions,[]);assert.deepEqual(normalBody.runs,[]);assert.equal(normalBody.currentVersion.revision,'saved-revision');assert.equal(normalBody.currentRun.analysisRunId,run.runId);assert.equal(normalBody.currentResearch.publishedCurrent,true,'normal history GET keeps main recovery fields and adds a separate current receipt');
denied=true;assert.equal((await context.handlers.GET(new Request(url+'&view=current'))).status,401);denied=false;
const request=()=>new Request('https://fixture.invalid/api/soccer/analysis',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({league:'epl',date:game.date,eventId:'123'})});
const post=await context.handlers.POST(request()),postBody=await post.json();assert.equal(post.status,200);
assert.equal(savedResult.validUntil,kickoff,'the immutable prematch snapshot expires at kickoff before the three-minute source TTL');
assert.equal(finishInput.validUntil,kickoff);assert.equal(postBody.validUntil,kickoff);assert.equal(postBody.publishedCurrent,true);
assert.equal(postBody.currentResearch.executable,false);assert.equal(postBody.formalScoringEnabled,false);
currentActive=false;const superseded=await (await context.handlers.POST(request())).json();
assert.equal(superseded.publishedCurrent,false,'a quote change between publication and response cannot be advertised as current');
assert.equal(superseded.persisted,true,'superseded results remain saved');
currentActive=true;
for(const patch of [{revision:'newer-revision'},{analysisRunId:'newer-run'}]){
  receiptPatch=patch;const mismatched=await sharedAnalyze({league:'epl',date:game.date,eventId:'123'},deps);
  assert.equal(mismatched.payload.publishedCurrent,false,'an ACTIVE receipt must still match this run and saved revision');assert.equal(mismatched.payload.persisted,true);
}
receiptPatch={};currentReadError=true;
const uncertain=await sharedAnalyze({league:'epl',date:game.date,eventId:'123'},deps);
assert.equal(uncertain.status,200);assert.equal(uncertain.payload.publishedCurrent,false);assert.equal(uncertain.payload.currentResearch,null);assert.equal(uncertain.payload.persisted,true);assert.equal(uncertain.payload.journalPersisted,true);
currentReadError=false;publicationCurrent=false;
const unpublished=await sharedAnalyze({league:'epl',date:game.date,eventId:'123'},deps);assert.equal(unpublished.payload.publishedCurrent,false,'a read cannot override a refused publication');publicationCurrent=true;
game.startTime='2026-10-20T14:00:00.000Z';
const sourceExpiry=await sharedAnalyze({league:'epl',date:game.date,eventId:'123'},deps);assert.equal(sourceExpiry.payload.validUntil,new Date(at+180000).toISOString(),'a later kickoff cannot extend the source lifetime');
game.startTime=kickoff;
console.log('PASS shipped current-status API/shared service: authenticated no-store lightweight reads, unchanged recovery fields and safe query scope, immutable kickoff/source expiry, response-time run/revision fencing and fail-closed status outages for manual/background callers');

const readerRouteSource=fs.readFileSync('app/api/soccer/reader/route.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export const /g,'const ').replace(/export async function /g,'async function ');
const aggregateHash='f'.repeat(64),readerContext=vm.createContext({URL,Response,NextResponse:{json:(body,options)=>Response.json(body,options)},
  requireApiAuth:async()=>null,soccerLeague:value=>value==='epl'?{id:'epl'}:null,validSoccerDate:value=>value==='2026-10-20',
  soccerReaderStorageConfigured:()=>true,loadSoccerReaderSnapshot:async()=>({contentHash:aggregateHash,revision:'heartbeat-revision',games:[],sourceObservations:[],periodsCovered:['FT']}),
  fetchSoccerSchedule:async()=>({ok:true,games:[]}),matchSoccerReaderGames:()=>[],
});
vm.runInContext(readerRouteSource+';globalThis.readerGet=GET;',readerContext);
const readerBody=await (await readerContext.readerGet(new Request('https://fixture.invalid/api/soccer/reader?league=epl&date=2026-10-20'))).json();
assert.equal(readerBody.contentHash,aggregateHash,'Reader exposes the content fingerprint separately from heartbeat revision');assert.equal(readerBody.revision,'heartbeat-revision');assert.equal(readerBody.executable,false);
console.log('PASS shipped Reader API: immutable-content fingerprint is exposed independently from heartbeat observation revision');
