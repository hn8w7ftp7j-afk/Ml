import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
const fixture=await soccerSqlFixture();
try{
  const {collectSoccerMinutesForward}=await import('../lib/soccer/minutes-forward-collection.js');
  const start=Date.parse('2026-11-09T08:00:00Z');let now=start;
  const date='2026-11-09',game=id=>({id:`soccer:epl:${id}`,sourceId:id,league:'epl',date,status:'scheduled',startTime:new Date(start+3600000+Number(id)*60000).toISOString()});
  const games=[game('1'),game('2')],calls=[],captured=new Set();let failFirst=true,stealLease=false;
  const deps={now:()=>now,query:async(sql,p=[]) => (await fixture.db.query(sql,p)).rows,
    freeze:async league=>({status:'DATABASE_FROZEN',protocolId:'a'.repeat(64),protocolHash:'b'.repeat(64),registeredAt:new Date(start-1000).toISOString(),protocol:{league}}),
    schedule:async(_league,d)=>({ok:true,games:d===date?games:[]}),hasCapture:async(_league,id)=>captured.has(id),
    analyze:async q=>{calls.push(q);if(failFirst&&q.eventId==='1')throw Error('controlled provider outage');
      if(stealLease)await fixture.db.query("UPDATE sports_soccer_minutes_forward_collection_v1 SET lease_token='other-worker' WHERE game_id=$1",[`soccer:epl:${q.eventId}`]);
      captured.add(`soccer:epl:${q.eventId}`);return {status:200,payload:{persisted:true,journalPersisted:true,
        gameId:`soccer:epl:${q.eventId}`,league:q.league,date:q.date,formalScoringEnabled:false,executable:false,
        minutesForwardCapture:{status:'PREDICTION_SAVED',persisted:true,
        receipt:{status:'DATABASE_PREGAME_CAPTURED',protocolId:'a'.repeat(64),protocolHash:'b'.repeat(64),
          analysisRevision:'d'.repeat(64),captureId:'c'.repeat(64),league:'epl',gameId:`soccer:epl:${q.eventId}`,capturedAt:new Date(now).toISOString()}}}};}};
  const first=await collectSoccerMinutesForward({league:'epl',limit:1},deps);assert.equal(first.failedGames,1);assert.equal(first.deferredGames,1);
  assert.deepEqual(calls,[{league:'epl',date,eventId:'1'}]);
  const second=await collectSoccerMinutesForward({league:'epl',limit:1},deps);assert.equal(second.capturedGames,1);assert.equal(calls[1].eventId,'2','a retryable first game cannot starve unattempted games');
  failFirst=false;await fixture.db.query("UPDATE sports_soccer_minutes_forward_collection_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE game_id='soccer:epl:1'");
  const third=await collectSoccerMinutesForward({league:'epl',limit:1},deps);assert.equal(third.capturedGames,1);assert.equal(third.alreadyCapturedGames,1);
  const before=calls.length;const repeat=await collectSoccerMinutesForward({league:'epl',limit:1},deps);assert.equal(repeat.alreadyCapturedGames,2);assert.equal(calls.length,before);
  captured.delete('soccer:epl:1');await fixture.db.query("UPDATE sports_soccer_minutes_forward_collection_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE game_id='soccer:epl:1'");
  stealLease=true;const stolen=await collectSoccerMinutesForward({league:'epl'},deps);assert.equal(stolen.capturedGames,0);assert.equal(stolen.reasons.COLLECTION_LEASE_EXPIRED,1);
  stealLease=false;
  const corruptions=[
    p=>{p.persisted=false;},p=>{p.journalPersisted=false;},p=>{p.gameId='soccer:epl:999';},
    p=>{p.league='ucl';},p=>{p.date='2026-11-08';},p=>{p.formalScoringEnabled=true;},p=>{p.executable=true;},
    p=>{p.minutesForwardCapture.receipt.protocolHash='e'.repeat(64);},
    p=>{p.minutesForwardCapture.receipt.analysisRevision='not-a-revision';},
  ];
  for(const [i,corrupt]of corruptions.entries()){
    const target=game(String(10+i));
    const report=await collectSoccerMinutesForward({league:'epl'}, {...deps,
      schedule:async(_league,d)=>({ok:true,games:d===date?[target]:[]}),
      analyze:async q=>{const result=await deps.analyze(q);corrupt(result.payload);return result;}});
    assert.equal(report.capturedGames,0,'unbound or unpersisted analysis cannot be acknowledged as a minutes capture');
    assert.equal(report.failedGames,1);
    const row=(await fixture.db.query('SELECT last_status FROM sports_soccer_minutes_forward_collection_v1 WHERE game_id=$1',[target.id])).rows[0];
    assert.equal(row.last_status,'RETRYABLE','invalid success remains retryable in the actual database');
  }
  await assert.rejects(()=>collectSoccerMinutesForward({league:'epl'}, {...deps,freeze:async()=>({status:'DATABASE_FROZEN',protocolId:'a'.repeat(64),protocolHash:'b'.repeat(64),registeredAt:new Date(start-1000).toISOString(),protocol:{league:'ucl'}})}),/PROTOCOL_INVALID/);
  for(const input of [{league:'nba'},{league:'epl',limit:3},{league:'epl',timeBudgetMs:50001}])await assert.rejects(()=>collectSoccerMinutesForward(input,deps),/SCOPE_INVALID/);
  const missing=await collectSoccerMinutesForward({league:'ucl'}, {...deps,schedule:async()=>{throw Error('controlled unavailable');}});
  assert.equal(missing.status,'PARTIAL');assert.equal(missing.scheduleFailures,2);assert.equal(missing.capturedGames,0);
  console.log('PASS minutes-forward collection: actual PostgreSQL fair leases/retry/dedup/fencing, independent protocol and league scope, server analysis only and honest partial source/budget semantics; fixtures are synthetic, not Production');
}finally{await fixture.close();}

