import assert from 'node:assert/strict';
import { buildSoccerRanking } from '../lib/soccer/ranking.js';
import { soccerManualRecordFromSnapshot,soccerRecordStats } from '../lib/soccer/manual-record.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
const now=Date.now(),at=new Date(now).toISOString(),date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date,startTime:new Date(now+86400000).toISOString(),status:'scheduled',home:{name:'Home',sourceId:'359'},away:{name:'Away',sourceId:'364'}};
const quote={key:'q1',period:'FT',unit:'GOALS',kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,label:'大 3+50',fresh:true,prestart:true,provenance:{gameId:game.id,observedAt:at}};
const result={gameId:game.id,league:'epl',date,observedAt:at,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',formalScoringEnabled:false,qualification:{eligible:false},directions:[{period:'FT',direction:'TOTAL_OVER',quotes:[quote],score:10,W:30,R:20,eligible:true,qaFlag:'WARN'}],evidence:{game}};
const rank=(r=result,t=now)=>buildSoccerRanking([game],{[game.id]:{status:'done',data:r}},{now:t});
const formal=candidateFixture({...result,formalScoringEnabled:true,qualification:{eligible:true}},now);
for(const view of ['entries','order']){
  assert.equal(rank()[view].length,0,'positive injected scores cannot promote research in either ranking');
  assert.equal(rank({...formal,gameId:'soccer:ucl:123'})[view].length,0);
  assert.equal(rank({...formal,publishedCurrent:false})[view].length,0);
  assert.equal(rank(formal,now+180000)[view].length,0);
  assert.equal(rank({...formal,directions:[{...formal.directions[0],quotes:[{...quote,period:'HT'}]}]})[view].length,0);
  assert.equal(buildSoccerRanking([game],{[game.id]:{status:'error',data:formal}},{now})[view].length,0);
  assert.equal(rank(formal)[view].length,1);
  assert.equal(rank(candidateFixture({...result,formalScoringEnabled:true,qualification:{eligible:true},directions:[{...result.directions[0],score:7.2}]},now))[view].length,1,'the inclusive S threshold is unchanged');
  for(const patch of [{score:7.1},{score:NaN},{W:0},{W:-1},{R:0},{R:-1},{eligible:false},{qaFlag:'BLOCKED'}])
    assert.equal(rank({...formal,directions:[{...formal.directions[0],...patch}]})[view].length,0,`${view} excludes ${JSON.stringify(patch)}`);
  assert.equal(rank({...formal,qualification:{eligible:false}})[view].length,0);
}
assert.equal(result.directions[0].quotes[0],quote,'ranking filtering preserves the original research quote for analysis results');
assert.equal(result.directions[0].score,10,'ranking filtering never rewrites source scores');
const earlier={...game,id:'soccer:epl:124',sourceId:'124',startTime:new Date(now+3600000).toISOString()},other=candidateFixture({...result,formalScoringEnabled:true,qualification:{eligible:true},gameId:earlier.id,evidence:{game:earlier},directions:[{...result.directions[0],score:7.5,quotes:[{...quote,key:'q2',provenance:{...quote.provenance,gameId:earlier.id}}]}]},now);
const ordered=buildSoccerRanking([game,earlier],{[game.id]:{status:'done',data:formal},[earlier.id]:{status:'done',data:other}},{now});
assert.equal(ordered.entries[0].game.id,game.id);assert.equal(ordered.order[0].game.id,earlier.id,'time ordering differs from score ordering');
assert.deepEqual(ordered.entries.map(e=>e.stableKey).sort(),ordered.order.map(e=>e.stableKey).sort(),'both views contain the same eligible candidates');
console.log('PASS football ranking: both views exclude research, low scores and nonpositive W/R, retain inclusive S threshold, formal QA, currentness, original research quotes and score/time sorting');

const record=soccerManualRecordFromSnapshot({...result,revision:'r1'},'q1');
assert.equal(record.stake,10000);assert.equal(record.rebateRate,.01);assert.equal(record.calibrationEligible,false);assert.equal(record.executable,false);
for(const patch of [{period:null},{unit:'CORNERS'},{water:NaN},{provenance:{gameId:'soccer:ucl:123'}}])assert.throws(()=>soccerManualRecordFromSnapshot({...result,directions:[{quotes:[{...quote,...patch}]}]},'q1'));
assert.throws(()=>soccerManualRecordFromSnapshot(result,'forged'));
const fixture=await soccerSqlFixture();process.env.DATABASE_URL='postgres://fixture.invalid/workspace';delete process.env.DATABASE_V2_URL;
try{
  const {archiveSoccerManualRecord,listSoccerManualRecords,changeSoccerManualRecordStatus}=await import('../lib/soccer/manual-record-store.js');
  const {saveSoccerAnalysis,listSoccerAnalysisBoard,loadSoccerAnalysisRevision}=await import('../lib/soccer/analysis-store.js');
  const {soccerAnalysisHash,SOCCER_ANALYSIS_VERSION}=await import('../lib/soccer/analysis.js');
  const {beginSoccerAnalysisRun,finishSoccerAnalysisRun}=await import('../lib/soccer/journal.js');
  const run=await beginSoccerAnalysisRun({league:'epl',date,gameId:game.id});
  const body={...result,directions:result.directions.map(d=>({...d,score:null,W:null,R:null,eligible:false,executable:false})),version:SOCCER_ANALYSIS_VERSION,analysisRunId:run.runId,executable:false};delete body.publishedCurrent;delete body.persisted;
  const saved=await saveSoccerAnalysis({...body,analysisHash:soccerAnalysisHash(body)});
  await finishSoccerAnalysisRun(run,{analysisStatus:'COMPLETED',qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',revision:saved.revision,validUntil:new Date(now+120000).toISOString()});
  assert.equal((await listSoccerAnalysisBoard('epl',date,date))[0].publishedCurrent,true);
  const original=await loadSoccerAnalysisRevision('epl',game.id,date,saved.revision);
  const first=await archiveSoccerManualRecord(original,'q1');
  const duplicate=await archiveSoccerManualRecord({...original,directions:[{...result.directions[0],quotes:[{...quote,water:1.3,key:'new'}]}]},'new');
  assert.equal(first.record.id,duplicate.record.id);assert.equal(duplicate.record.water,.95,'new analysis cannot overwrite recorded water');
  assert.equal((await listSoccerManualRecords('epl',date)).length,1);assert.equal((await listSoccerManualRecords('ucl',date)).length,0);
  await assert.rejects(()=>changeSoccerManualRecordStatus('ucl',date,first.record.id,'cancel'),/不存在/);
  const cancelled=await changeSoccerManualRecordStatus('epl',date,first.record.id,'cancel');assert.equal(cancelled.record.status,'CANCELLED');
  await changeSoccerManualRecordStatus('epl',date,first.record.id,'cancel');
  const restored=await changeSoccerManualRecordStatus('epl',date,first.record.id,'restore');assert.equal(restored.record.status,'OPEN');assert.equal(restored.record.history.length,2);
  for(const key of ['line','water','stake','recordedAt','analysisRevision','sourceQuote'])assert.deepEqual(restored.record[key],first.record[key]);
  assert.equal(soccerRecordStats([restored.record]).stake,10000);assert.equal(soccerRecordStats([cancelled.record]).stake,0);assert.equal(soccerRecordStats([restored.record]).profit,null);
  await fixture.db.query(`UPDATE sports_soccer_analysis_heads_v2 SET valid_until=now()-interval '1 second'`);
  assert.equal((await listSoccerAnalysisBoard('epl',date,date))[0].publishedCurrent,false,'restored history does not authorize expired projection');
  await assert.rejects(()=>loadSoccerAnalysisRevision('ucl','soccer:ucl:123',date,saved.revision),/找不到/);
  await assert.rejects(()=>archiveSoccerManualRecord(original,'q1',{db:{query:async()=>{throw Error('offline');}}}),/offline/);
  console.log('PASS real PostgreSQL: durable quote-bound records, double-click replay, scoped cancel/restore, immutable price/stake, unknown settlement metrics, revision validation and publication expiry');
}finally{await fixture.close();}
