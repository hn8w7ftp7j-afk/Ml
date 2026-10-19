import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Exercise the shipped board SELECT in PostgreSQL. An older request may finish
// after a newer one, while its immutable evidence time is later than the head.
const fixture=await soccerSqlFixture(),{db}=fixture;
const envKeys=['DATABASE_URL','DATABASE_V2_URL'],before=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-board-current';delete process.env.DATABASE_V2_URL;
try{
  const {beginSoccerAnalysisRun,finishSoccerAnalysisRun}=await import('../lib/soccer/journal.js');
  const {saveSoccerAnalysis,listSoccerAnalysisBoard}=await import('../lib/soccer/analysis-store.js');
  const {soccerAnalysisHash,SOCCER_ANALYSIS_VERSION}=await import('../lib/soccer/analysis.js');
  const now=Date.now(),date='2026-10-20',scope={league:'epl',date,gameId:'soccer:epl:123'};
  const read=()=>listSoccerAnalysisBoard(scope.league,date,date);
  const save=async(run,observedAt)=>{
    const body={version:SOCCER_ANALYSIS_VERSION,league:run.league,date:run.date,gameId:run.gameId,
      analysisRunId:run.runId,observedAt:new Date(observedAt).toISOString(),analysisStatus:'COMPLETED',
      qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',formalScoringEnabled:false,executable:false};
    return saveSoccerAnalysis({...body,analysisHash:soccerAnalysisHash(body)});
  };
  const finish=(run,saved)=>finishSoccerAnalysisRun(run,{analysisStatus:'COMPLETED',qaFlag:'WARN',
    selectionResult:'RESEARCH_SHADOW',revision:saved.revision,validUntil:new Date(now+120000).toISOString()});
  const a=await beginSoccerAnalysisRun({...scope,now:now-60000}),b=await beginSoccerAnalysisRun({...scope,now:now-45000});
  const savedB=await save(b,now-20000);assert.equal((await finish(b,savedB)).publishedCurrent,true);
  const savedA=await save(a,now-10000);assert.equal((await finish(a,savedA)).publishedCurrent,false);
  let rows=await read();
  assert.equal(rows.length,1);assert.equal(rows[0].revision,savedB.revision,'the current B survives A completing with a later observed_at');
  assert.equal(rows[0].publishedCurrent,true);assert.equal(rows[0].analysisRunId,b.runId);
  const history=(await db.query('SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 ORDER BY analysis_hash')).rows;
  assert.equal(history.length,2,'both completed versions remain immutable history');

  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET valid_until=clock_timestamp()-interval '1 second'`);
  rows=await read();assert.equal(rows[0].revision,savedA.revision,'without an active head the latest history remains visible');
  assert.equal(rows[0].publishedCurrent,false,'expiry uses the database clock');
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET valid_until=clock_timestamp()+interval '2 minutes'`);
  await db.query(`INSERT INTO sports_soccer_source_heads_v2(league,board_date,quote_generation) VALUES ('epl',$1::date,1)`,[date]);
  rows=await read();assert.equal(rows[0].revision,savedA.revision);assert.equal(rows[0].publishedCurrent,false,'a changed quote generation invalidates B');
  await db.query(`UPDATE sports_soccer_source_heads_v2 SET quote_generation=0`);
  assert.equal((await read())[0].revision,savedB.revision);
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET requested_seq=requested_seq+1`);
  rows=await read();assert.equal(rows[0].revision,savedA.revision);assert.equal(rows[0].publishedCurrent,false,'a head cannot borrow a run with a different request sequence');
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET requested_seq=$1`,[b.requestSeq]);
  const foreign=await beginSoccerAnalysisRun({league:'ucl',date,gameId:'soccer:ucl:123'});
  const savedForeign=await save(foreign,now-5000);await finish(foreign,savedForeign);
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET requested_run_id=$1,requested_seq=$2 WHERE league='epl'`,[foreign.runId,foreign.requestSeq]);
  rows=await read();assert.equal(rows.length,1);assert.equal(rows[0].revision,savedA.revision);
  assert.equal(rows[0].publishedCurrent,false,'foreign league/run evidence cannot qualify an EPL head');
  assert.equal((await listSoccerAnalysisBoard('ucl',date,date))[0].revision,savedForeign.revision);
  await db.query(`UPDATE sports_soccer_analysis_heads_v2 SET requested_run_id=$1,requested_seq=$2 WHERE league='epl'`,[b.runId,b.requestSeq]);
  await beginSoccerAnalysisRun({...scope,now:now-1000});
  rows=await read();assert.equal(rows[0].revision,savedA.revision);assert.equal(rows[0].publishedCurrent,false,'a pending newer request preserves history without restoring B');
  assert.deepEqual((await db.query(`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 WHERE league='epl' ORDER BY analysis_hash`)).rows,history);
  console.log('PASS board PostgreSQL: delayed older run cannot hide current head; database expiry, quote generation, run/sequence/league fencing and latest-history fallback preserve immutable versions');
}finally{
  for(const key of envKeys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  await fixture.close();
}
