import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {soccerSqlFixture} from '../scripts/helpers/soccer-sql-fixture.mjs';
import {soccerDate} from '../lib/soccer/contracts.js';
import {soccerResearchArtifacts} from '../lib/soccer/research-frozen.js';
import {soccerHalfTimeArtifacts} from '../lib/soccer/half-time-frozen.js';
import {soccerCalibrationShadowArtifacts} from '../lib/soccer/calibration-frozen.js';
import {buildSoccerMarketDirections} from '../lib/soccer/market-directions.js';
import {matchSoccerReaderGames} from '../lib/soccer/reader.js';
const fixture=await soccerSqlFixture(),query=async(sql,params=[])=>(await fixture.db.query(sql,params)).rows;
const {enqueueSoccerReaderAnalysis,drainSoccerReaderAnalysis,soccerReaderAnalysisCandidates}=await import('../lib/soccer/reader-auto-analysis.js');
const initial=Date.now();let logicalNow=initial,called=[];
const kickoff=Date.parse(`${new Date(initial+86400000).toISOString().slice(0,10)}T12:00:00.000Z`), date=soccerDate(kickoff),league='ucl',at=new Date(initial).toISOString();
const source={revision:'a'.repeat(64),observationId:'b'.repeat(64),observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
const games=Array.from({length:9},(_,i)=>({id:`soccer:ucl:${990001+i}`,sourceId:String(990001+i),league,date,startTime:new Date(kickoff+i*300000).toISOString(),status:'scheduled',home:{id:'soccer:ucl:team:359',sourceId:'359',name:'Arsenal'},away:{id:'soccer:ucl:team:364',sourceId:'364',name:'Chelsea'}}));
const reader={league:'UCL',boardDate:date,...source,games:games.map(g=>({league:'UCL',boardDate:date,boardTime:new Date(Date.parse(g.startTime)+8*3600000).toISOString().slice(11,16),homeKey:globalThis.Tai888SoccerTeams.key('Arsenal'),awayKey:globalThis.Tai888SoccerTeams.key('Chelsea'),markets:[{period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.9,underWater:.95,rawRows:['大2.5 0.90 小0.95'],serverObservation:source,periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'歐洲冠軍聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}}]}))};
const schedule=async()=>({ok:true,games});
const deps={query,now:()=>logicalNow,loadReader:async()=>reader,schedule,league,date,analyze:async input=>{
 const g=games.find(g=>g.sourceId===input.eventId);called.push(g.id);
 const shadow=soccerCalibrationShadowArtifacts(league),capturedAt=new Date(logicalNow).toISOString();
 const directions=buildSoccerMarketDirections({reader,game:g,matchedGames:matchSoccerReaderGames(reader,games,logicalNow),now:logicalNow});
 return {status:200,payload:{ok:true,persisted:true,journalPersisted:true,executable:false,analysisStatus:'COMPLETED',status:'RESEARCH_ONLY',evidence:{game:g},directions,revision:'c'.repeat(64),prediction:soccerResearchArtifacts().leagues[league].liveModel,inputVersions:{readerSourceObservations:[]},halfTimePrediction:soccerHalfTimeArtifacts().leagues[league].liveModel,calibrationShadowCapture:{persisted:true,status:'SHADOW_PREDICTION_SAVED',fullTimeCaptured:true,halfTimeCaptured:true,freeze:{status:'DATABASE_FROZEN',league,freezeId:'1'.repeat(64),candidateHash:shadow.candidate.contentHash,planHash:shadow.plan.contentHash,frozenAt:new Date(logicalNow-1000).toISOString()},capture:{status:'DATABASE_PREGAME_CAPTURED',league,gameId:g.id,freezeId:'1'.repeat(64),captureId:'2'.repeat(64),captureSequence:'1',analysisRevision:'c'.repeat(64),sourceReceiptId:'3'.repeat(64),predictionHash:'4'.repeat(64),capturedAt}},forwardCapture:{persisted:true,captures:[{variant:'BASELINE',period:'REGULATION_FT',captureId:'d'.repeat(64),captureSequence:'1',capturedAt}]}}};
}};
const {runSoccerReaderContinuationPass,SOCCER_READER_CONTINUATION_WINDOW_MS}=await import('../lib/soccer/reader-analysis-continuation.js');
const workflowSource=fs.readFileSync('workflows/soccer-reader-capture.js','utf8').replace(/^import .*?;\r?\n/gm,'').replace(/export async function /g,'async function ');
let delays=[],passes=[],failOnce=false;
const baseAnalyze=deps.analyze;
deps.analyze=async input=>{if(failOnce){failOnce=false;return{status:503,payload:{ok:false}};}return baseAnalyze(input);};
class ClockDate extends Date{static now(){return logicalNow;}}
function workflow(){
 const context=vm.createContext({Date:ClockDate,console:{info:()=>{}},getWorkflowMetadata:()=>({workflowRunId:'wrun_01ARYZ6S41TSV4RRFFQ69G5FAV'}),
  soccerReaderContinuationScope:input=>{assert.deepEqual(Object.keys(input).sort(),['date','league']);return input;},
  SOCCER_READER_CONTINUATION_WINDOW_MS,
  runSoccerReaderContinuationPass:async(scope,state)=>{const result=await runSoccerReaderContinuationPass(scope,state,{now:()=>logicalNow,
    drain:options=>drainSoccerReaderAnalysis({...deps,...options})});passes.push(result);return result;},
  sleep:async duration=>{const ms=Number(duration.replace(/ms$/,''));assert.ok(ms>0&&ms<=20000);delays.push(ms);logicalNow+=ms;
    // Simulate the same passage of database lease/retry time without a real wait.
    await query("UPDATE sports_soccer_reader_analysis_queue_v1 SET retry_at=clock_timestamp()-interval '1 second' WHERE lease_token IS NULL");
    await query("UPDATE sports_soccer_reader_analysis_claims_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE state='RETRYABLE'");},
 });
 vm.runInContext(workflowSource+';globalThis.run=soccerReaderCaptureWorkflow',context);return context.run({league,date});
}
async function reset(){await query('DELETE FROM sports_soccer_reader_analysis_queue_v1');await query('DELETE FROM sports_soccer_reader_analysis_claims_v1');called=[];passes=[];delays=[];logicalNow=initial;}
try{
 assert.equal(soccerReaderAnalysisCandidates(reader,await schedule(),{league,date,now:logicalNow}).length,9);
 await enqueueSoccerReaderAnalysis(league,date,{query});
 const complete=await workflow();
 assert.equal(complete.status,'SCOPE_COMPLETE');assert.equal(complete.captured,9);assert.equal(complete.batches,3);
 assert.equal(called.length,9);assert.equal(new Set(called).size,9);assert.equal(delays.length,0,'capacity advances immediately without another upload or cron');
 assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_analysis_claims_v1 WHERE state='CAPTURED'"))[0].n,9);
 assert.equal((await query('SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1'))[0].n,0);
 await enqueueSoccerReaderAnalysis(league,date,{query});assert.equal((await workflow()).captured,0);assert.equal(called.length,9,'same prices remain deduplicated across runs');
 await reset();await enqueueSoccerReaderAnalysis(league,date,{query});
 const concurrent=await Promise.all([drainSoccerReaderAnalysis(deps),drainSoccerReaderAnalysis(deps)]);
 assert.equal(concurrent.reduce((sum,row)=>sum+row.captured,0),4,'concurrent workflow/fallback/cron drainers share one SQL scope lease');
 assert.equal(called.length,4);assert.equal((await workflow()).captured,5);assert.equal(new Set(called).size,9);
 await reset();await enqueueSoccerReaderAnalysis(league,date,{query});
 let uploadedAgain=false;
 const normalAnalyze=deps.analyze;
 deps.analyze=async input=>{const result=await normalAnalyze(input);if(called.length===4&&!uploadedAgain){uploadedAgain=true;await enqueueSoccerReaderAnalysis(league,date,{query});}return result;};
 const newGeneration=await workflow();deps.analyze=normalAnalyze;
 assert.equal(newGeneration.captured,9);assert.equal(called.length,9);
 assert.equal(passes[0].summary.continuation.generation,'2','an upload at capacity survives the old generation completion');
 assert.equal(passes[0].delayMs,0);assert.equal((await query('SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1'))[0].n,0);
 await reset();await enqueueSoccerReaderAnalysis(league,date,{query});failOnce=true;
 const recovered=await workflow();assert.equal(recovered.captured,9);assert.equal(recovered.retryable,1);
 assert.ok(delays.length>=1);assert.ok(delays[0]>=19000,'source failure waits for its real retry time');
 assert.ok(passes.some(pass=>pass.delayMs===0&&pass.status==='MORE_PENDING'),'later capacity exhaustion is still immediate');
 await reset();await enqueueSoccerReaderAnalysis(league,date,{query});logicalNow+=181000;
 const expired=await workflow();assert.equal(expired.status,'NO_FRESH_ELIGIBLE_QUOTES');assert.equal(expired.captured,0);assert.equal(called.length,0);
 const old=(await query("SELECT retry_at='infinity'::timestamptz AS dormant FROM sports_soccer_reader_analysis_queue_v1"))[0];assert.equal(old.dormant,true);
 await reset();await enqueueSoccerReaderAnalysis(league,date,{query});
 await query("UPDATE sports_soccer_reader_analysis_queue_v1 SET lease_token='other-worker',lease_until=clock_timestamp()+interval '120 seconds'");
 const held=await drainSoccerReaderAnalysis(deps);assert.equal(held.checked,0);assert.equal(held.continuation.needed,true);assert.equal(held.continuation.reason,'SCOPE_LEASE_HELD');
 assert.ok(held.continuation.delayMs>100000,'zero work under another active lease does not report completion');
 let failureClock=initial,attempts=0;
 const fixedState={startedAt:initial,deadlineAt:initial+180000};
 const failureDeps={now:()=>failureClock,drain:async()=>{attempts++;return{continuation:{needed:true,delayMs:20000,league,date,reason:'SERVER_INPUT_OR_STORAGE_UNAVAILABLE'}};}};
 assert.equal((await runSoccerReaderContinuationPass({league,date},fixedState,failureDeps)).stopped,false);
 failureClock+=181000;assert.equal((await runSoccerReaderContinuationPass({league,date},fixedState,failureDeps)).status,'RUN_WINDOW_EXPIRED');assert.equal(attempts,1);
 await assert.rejects(()=>runSoccerReaderContinuationPass({league,date,quotes:[]},fixedState,failureDeps),/SCOPE_INVALID/);
 await assert.rejects(()=>runSoccerReaderContinuationPass({league:'nba',date},fixedState,failureDeps),/SCOPE_INVALID/);
 await assert.rejects(()=>runSoccerReaderContinuationPass({league,date},{...fixedState,deadlineAt:fixedState.deadlineAt+1},failureDeps),/CLOCK_INVALID/);
 assert.match(workflowSource,/let state=await initializeReaderRun\(scope\)/,'clock is durably initialized before retryable capture steps');
 console.log('PASS Reader durable continuation: single upload nine real-matched games across three bounded SQL batches, no capacity delay, source retry, economic dedup, original quote expiry, active lease distinction and fixed run deadline; fixture provider/receipts are synthetic, Production freshness is separate');
}finally{await fixture.close();}
