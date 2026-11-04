import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { collectSoccerCalibrationPredictions } from '../lib/soccer/calibration-collection.js';
import { soccerDate } from '../lib/soccer/contracts.js';
const db = new PGlite(), query = async (sql, params=[]) => (await db.query(sql,params)).rows;
await query('CREATE TABLE sports_soccer_calibration_captures_v1(freeze_id text,league text,game_id text)');
const hash = 'a'.repeat(64), now = Date.parse('2026-11-05T10:00:00Z'), date = soccerDate(now);
const artifacts = () => ({candidate:{contentHash:hash},plan:{contentHash:hash,beginsStrictlyAfter:'2026-11-01T00:00:00Z',usedGamesExcluded:['epl:8']}});
const freeze = async league => ({status:'DATABASE_FROZEN',league,freezeId:hash,candidateHash:hash,planHash:hash});
const game = (id,league='epl',extra={}) => ({id:`soccer:${league}:${id}`,sourceId:String(id),league,date,status:'scheduled',
  startTime:new Date(now+3600000).toISOString(),home:{id:`soccer:${league}:team:1`,sourceId:'1'},away:{id:`soccer:${league}:team:2`,sourceId:'2'},...extra});
let games=[game(1),game(2),game(3)], calls=[];
const schedule = async (league,requested) => ({ok:true,games:requested===date?games:[]});
const success = async input => {
  const id=`soccer:${input.league}:${input.eventId}`;calls.push(input);
  await query('INSERT INTO sports_soccer_calibration_captures_v1 VALUES ($1,$2,$3)',[hash,input.league,id]);
  return {status:200,payload:{persisted:true,journalPersisted:true,gameId:id,league:input.league,date:input.date,
    executable:false,formalScoringEnabled:false,calibrationShadowCapture:{status:'SHADOW_PREDICTION_SAVED',persisted:true,
      fullTimeCaptured:true,halfTimeCaptured:true,capture:{status:'DATABASE_PREGAME_CAPTURED',freezeId:hash,
        league:input.league,gameId:id,captureId:hash,sourceReceiptId:hash,predictionHash:hash,analysisRevision:hash,
        capturedAt:new Date(now).toISOString()}}}};
};
const deps={query,now:()=>now,freeze,artifacts,schedule,analyze:success};
const collect=(options={},extra={})=>collectSoccerCalibrationPredictions({league:'epl',limit:2,...options},{...deps,...extra});
try {
  const first=await collect();assert.equal(first.capturedGames,2);assert.equal(first.deferredGames,1);assert.equal(first.status,'MORE_PENDING');
  const next=await collect();assert.equal(next.capturedGames,1);assert.equal(next.alreadyCapturedGames,2);
  const repeated=await collect();assert.equal(repeated.checkedGames,0);assert.equal(calls.length,3,'repeat skips games from actual capture table');
  assert.equal(repeated.formalEligible,false);assert.equal(repeated.executable,false);

  games=[game(4,'ucl'),game(5,'epl',{status:'live'}),game(6,'epl',{startTime:new Date(now-1).toISOString()}),
    game(7,'epl',{startTime:new Date(now+86400001).toISOString()}),game(8),game(9,'epl',{id:'soccer:ucl:9'}),game(10,'epl',{away:{id:'soccer:epl:team:1',sourceId:'1'}})];
  assert.equal((await collect()).checkedGames,0,'foreign league, live, started, future, reused and invalid identity rejected');

  games=[game(11),game(12),game(13)];
  const failed=await collect({limit:1},{analyze:async()=>{throw Error('controlled outage');}});
  assert.equal(failed.failedGames,1);assert.equal(failed.status,'PARTIAL');
  const continued=await collect({limit:1});assert.equal(continued.capturedGames,1);
  assert.equal(calls.at(-1).eventId,'12','a failed earlier game cannot starve an untouched game');
  const rows=await query('SELECT last_status,last_reason FROM sports_soccer_calibration_collection_v1 WHERE game_id=$1',['soccer:epl:11']);
  assert.equal(rows[0].last_status,'RETRYABLE');assert.equal(rows[0].last_reason,'CALIBRATION_COLLECTION_ANALYSIS_UNAVAILABLE');

  games=[game(20)];let release,entered;
  const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const inFlight=collect({}, {analyze:async input=>{entered();await blocked;return success(input);}});
  await started;
  assert.equal((await collect()).checkedGames,0,'concurrent worker cannot acquire active database lease');
  release();assert.equal((await inFlight).capturedGames,1);

  games=[game(21)];
  const forged=await collect({}, {analyze:async input=>{
    const value=await success(input);value.payload.calibrationShadowCapture.capture.league='ucl';return value;
  }});assert.equal(forged.capturedGames,0);assert.equal(forged.failedGames,1,'foreign receipt never counts as capture');

  games=[game(22)];
  const expired=await collect({}, {analyze:async input=>{
    const value=await success(input);
    await query("UPDATE sports_soccer_calibration_collection_v1 SET lease_token='new-worker' WHERE game_id=$1",['soccer:epl:22']);return value;
  }});assert.equal(expired.capturedGames,0);assert.equal(expired.reasons.CALIBRATION_COLLECTION_LEASE_EXPIRED,1);

  games=[game(30,'ucl')];
  assert.equal((await collect({league:'ucl'})).capturedGames,1,'UCL uses its own identity and freeze scope');
  const partial=await collect({}, {schedule:async(_league,d)=>d===date?{ok:false}: {ok:true,games:[]}});
  assert.equal(partial.scheduleFailures,1);assert.equal(partial.status,'PARTIAL','source failure is not an empty slate');
  games=[game(40)];let ticks=0;
  assert.equal((await collect({}, {now:()=>ticks++===0?now:now+60000})).checkedGames,0,'expired run budget starts no analysis');
  await assert.rejects(collect({league:'nba'}),/SCOPE_INVALID/);
  await assert.rejects(collect({}, {freeze:async()=>({...await freeze('epl'),candidateHash:'b'.repeat(64)})}),/FREEZE_INVALID/);
  console.log('PASS calibration collection: real PostgreSQL leases, partial schedule failure, source/league/time scope, first capture dedup, starvation-free retry, concurrent claims and late-worker fencing; no formal promotion.');
} finally { await db.close(); }
