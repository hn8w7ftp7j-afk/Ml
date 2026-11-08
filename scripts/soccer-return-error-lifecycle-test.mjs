import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerForwardHash as hash } from '../lib/soccer/forward-validation.js';
import { SOCCER_RETURN_ERROR_VERSION, fitSoccerReturnErrorResearch } from '../lib/soccer/return-error-model.js';
import { soccerDate } from '../lib/soccer/contracts.js';

// Synthetic rows exercise orchestration, durability and clock ordering against
// actual PostgreSQL. They are never empirical football samples or acceptance.
const fixture=await soccerSqlFixture(),{db}=fixture;
const old=process.env.DATABASE_URL,oldV2=process.env.DATABASE_V2_URL;
process.env.DATABASE_URL='postgres://fixture.invalid/return-error-lifecycle';delete process.env.DATABASE_V2_URL;
const store=await import('../lib/soccer/return-error-validation-store.js');
const {runSoccerReturnErrorLifecycle:run,readSoccerReturnErrorLifecycleReadiness:read,readSoccerReturnErrorSourceWatermark:watermark,SOCCER_RETURN_ERROR_REPLAY_REVISION}=await import('../lib/soccer/return-error-lifecycle.js');
const iso=value=>new Date(value).toISOString();
const seal=value=>({...value,contentHash:hash(value)});
try {
  const empty=await read('epl');
  assert.equal(empty.status,'NOT_CONFIGURED');
  assert.deepEqual([...empty.requiredInputs].sort(),['calibrationBefore','from','league','miscoverage','testBefore','trainingBefore'].sort());
  assert.match(empty.registrationCommand,/soccer-return-error-validation\.mjs register/);
  assert.match(empty.registrationCommand,/--league epl/);
  assert.equal(empty.accepted,false);assert.equal(empty.formalEligible,false);assert.equal(empty.executable,false);
  const timedOut=await read('epl',{timeoutMs:1,listProtocols:async()=>new Promise(()=>{})});
  assert.equal(timedOut.status,'NOT_VERIFIED');assert.equal(timedOut.configuredProtocols,null);assert.equal(timedOut.persisted,false);
  let sourceReads=0;
  const noPlan=await run({league:'epl'},{scan:async()=>{sourceReads++;throw Error('no plan must not fetch');}});
  assert.equal(noPlan.status,'NOT_CONFIGURED');assert.equal(noPlan.persisted,true);assert.equal(sourceReads,0);
  await assert.rejects(()=>run({league:'nba'}),/SCOPE_INVALID/);
  await assert.rejects(()=>run({league:'epl',limit:0}),/SCOPE_INVALID/);
  await assert.rejects(()=>run({league:'epl',timeBudgetMs:0}),/SCOPE_INVALID/);

  const dbNow=await store.soccerReturnErrorDatabaseNow(),trainingBefore=dbNow+1000,calibrationBefore=dbNow+2000,testBefore=dbNow+60000;
  const input={from:soccerDate(dbNow-86400000),trainingBefore:iso(trainingBefore),calibrationBefore:iso(calibrationBefore),testBefore:iso(testBefore)};
  const epl=await store.registerSoccerReturnErrorProtocol({league:'epl',...input});
  const ucl=await store.registerSoccerReturnErrorProtocol({league:'ucl',...input});
  assert.deepEqual((await store.listActiveSoccerReturnErrorProtocols({league:'epl'})).protocols.map(value=>value.protocolId),[epl.protocolId]);
  assert.deepEqual((await store.listActiveSoccerReturnErrorProtocols({league:'ucl'})).protocols.map(value=>value.protocolId),[ucl.protocolId]);
  assert.equal((await store.listActiveSoccerReturnErrorProtocols({league:'epl',readyOnly:true})).protocols.length,0);
  const waiting=await run({league:'epl'},{scan:async()=>{throw Error('waiting must not fetch');}});
  assert.equal(waiting.status,'WAITING');
  const delay=calibrationBefore-Date.now()+20;if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
  const rowsFor=league=>Array.from({length:10},(_,index)=>({
    observationId:hash(`${league}-row-${index}`),league,gameId:`soccer:${league}:${900000000+index}`,period:'FT',variant:'BASELINE',
    modelHash:hash(`${league}-model`),settlementRuleFamilyHash:hash(`${league}-rules`),contractHash:hash(`${league}-contract-${index}`),kind:'TOTAL',side:'over',
    kickoff:iso(index===0?dbNow-1000:trainingBefore+(index-1)*50),predictionCapturedAt:iso(index===0?dbNow-2000:trainingBefore-100),
    checkedAt:iso(index===0?dbNow-500:trainingBefore+(index-1)*50+1),predictedNetReturn:.1,
    realizedNetReturn:index%2?.9:-.99,predictionError:(index%2?.9:-.99)-.1,actualScore:{home:index%2,away:0}
  }));
  const dataset=(league,rows)=>seal({version:SOCCER_RETURN_ERROR_VERSION,type:'VALIDATED_RETURN_ERROR_DATASET',selection:epl.protocol.selection,
    observations:rows,boundedObservations:[],quarantinedGameKeys:[],excludedReasons:{},coverage:{completeWithinRequestedScope:true}});
  const page=async(options,league,rows,sourceAt,cursor)=>{
    for(const row of rows)await options.onGameEvidence({captures:[{league,gameId:row.gameId}],rows:[row]},
      {now:sourceAt,scanCursor:cursor,hydrateCapture:async()=>null});
  };
  const eplRows=rowsFor('epl'),sourceBounds=[],scopes=[],clock={value:100000};
  const buildDataset=async(evidence,options)=>{sourceBounds.push(options.now);return dataset(evidence.captures[0].league,evidence.rows);};
  const first=await run({league:'epl',timeBudgetMs:1000},{now:()=>clock.value,buildDataset,scan:async(scope,options)=>{
    scopes.push(scope);assert.equal(options.cursor,null);assert.ok(options.timeBudgetMs<=1000);
    await page(options,'epl',eplRows.slice(0,1),await store.soccerReturnErrorDatabaseNow(),'a'.repeat(48));
    clock.value+=2000;
    return {report:{complete:false,scan:{cursor:'a'.repeat(48),nextCursor:'a'.repeat(48),processedGames:1}}};
  }});
  assert.equal(first.status,'IN_PROGRESS',JSON.stringify(first));assert.equal(first.persisted,true);
  let jobs=(await db.query('SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1',[epl.protocolId])).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].processed_games,1);assert.equal(jobs[0].status,'RUNNING');
  const originalCutoff=new Date(jobs[0].evidence_cutoff_at).getTime();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[jobs[0].run_id])).rows[0].n,1);
  const expired=await run({league:'epl'},{buildDataset,scan:async(_scope,options)=>{
    assert.equal(options.cursor,'a'.repeat(48));
    throw Object.assign(Error('synthetic expired derived cursor'),{code:'SOCCER_FORWARD_SCAN_CURSOR_EXPIRED'});
  }});
  assert.equal(expired.status,'IN_PROGRESS',JSON.stringify(expired));
  assert.equal(expired.protocols[0].reason,'RETURN_ERROR_LIFECYCLE_SCAN_RESTARTED');
  const abandoned=(await db.query('SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE run_id=$1',[jobs[0].run_id])).rows[0];
  assert.equal(abandoned.status,'ABANDONED');assert.equal(abandoned.artifact.type,'INCOMPLETE_SCAN_RESTART');assert.equal(abandoned.artifact.requestedScopeComplete,false);
  const restarted=(await db.query("SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND status='RUNNING'",[epl.protocolId])).rows[0];
  assert.notEqual(restarted.run_id,jobs[0].run_id);
  assert.equal(restarted.scan_cursor,null);assert.equal(restarted.processed_games,0);
  assert.equal(new Date(restarted.evidence_cutoff_at).getTime(),originalCutoff);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[jobs[0].run_id])).rows[0].n,0,'expired derived data cannot mix with a new manifest');
  await db.query('UPDATE sports_soccer_return_error_lifecycle_v1 SET replay_revision=$2 WHERE run_id=$1',[restarted.run_id,'synthetic-old-replay']);
  let staleRevisionScans=0;
  const changedMethod=await run({league:'epl'},{buildDataset,scan:async()=>{staleRevisionScans++;throw Error('stale replay must restart before scanning');}});
  assert.equal(changedMethod.status,'IN_PROGRESS',JSON.stringify(changedMethod));
  assert.equal(changedMethod.protocols[0].reason,'RETURN_ERROR_LIFECYCLE_SCAN_RESTARTED');
  assert.equal(staleRevisionScans,0,'an old replay revision cannot read or fit under current semantics');
  const staleRevision=(await db.query('SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE run_id=$1',[restarted.run_id])).rows[0];
  assert.equal(staleRevision.status,'ABANDONED');assert.equal(staleRevision.artifact.reason,'SOCCER_FORWARD_SCAN_SELECTION_CHANGED');assert.equal(staleRevision.artifact.requestedScopeComplete,false);
  const currentRevision=(await db.query("SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND status='RUNNING'",[epl.protocolId])).rows[0];
  assert.notEqual(currentRevision.run_id,restarted.run_id);assert.equal(currentRevision.replay_revision,SOCCER_RETURN_ERROR_REPLAY_REVISION);
  assert.equal(currentRevision.scan_cursor,null);assert.equal(currentRevision.processed_games,0);
  assert.equal(new Date(currentRevision.evidence_cutoff_at).getTime(),originalCutoff);
  assert.deepEqual(currentRevision.source_through,restarted.source_through);
  clock.value=200000;
  let resumedIndex=0;
  const resumed=await run({league:'epl',timeBudgetMs:1000},{now:()=>clock.value,buildDataset,scan:async(scope,options)=>{
    scopes.push(scope);assert.equal(options.cursor,resumedIndex===0?null:'d'.repeat(48));
    // The resumed source cannot advance the original job evidence cutoff.
    await page(options,'epl',eplRows.slice(resumedIndex,resumedIndex+1),originalCutoff+86400000,'d'.repeat(48));
    resumedIndex++;
    return {report:{complete:resumedIndex===10,scan:{cursor:'d'.repeat(48),nextCursor:resumedIndex===10?null:'d'.repeat(48),processedGames:resumedIndex}}};
  }});
  assert.equal(resumed.status,'RESEARCH_FROZEN');assert.equal(resumed.accepted,false);assert.equal(resumed.formalEligible,false);
  assert.equal(sourceBounds.at(-1),originalCutoff);
  assert.deepEqual(scopes,Array.from({length:11},()=>({league:'epl',from:input.from,through:soccerDate(calibrationBefore-1)})));
  jobs=(await db.query("SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND status='COMPLETE'",[epl.protocolId])).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].status,'COMPLETE');assert.equal(jobs[0].artifact.observedGames,10);
  assert.equal(jobs[0].artifact.groups[0].train.games,1);assert.equal(jobs[0].artifact.groups[0].calibration.games,9);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[jobs[0].run_id])).rows[0].n,10);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_freezes_v1 WHERE protocol_id=$1',[epl.protocolId])).rows[0].n,1);

  // A failed page retains its original immutable datasets. The same page can
  // replay once the transient failure clears without counting a game twice.
  const uclRows=rowsFor('ucl');let attempts=0;
  const retry=await run({league:'ucl'},{buildDataset,scan:async(_scope,options)=>{
    attempts++;await page(options,'ucl',uclRows.slice(0,1),await store.soccerReturnErrorDatabaseNow(),'b'.repeat(48));
    throw Error('synthetic temporary source failure');
  }});
  assert.equal(retry.status,'RETRYABLE');
  const retryJobs=(await db.query('SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1',[ucl.protocolId])).rows;
  assert.equal(retryJobs.length,1);assert.equal(retryJobs[0].status,'RUNNING');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[retryJobs[0].run_id])).rows[0].n,1);
  let retryIndex=0;
  const retried=await run({league:'ucl'},{buildDataset,freeze:async(protocolId,artifact)=>{await store.freezeSoccerReturnErrorParameters(protocolId,artifact);throw Error('synthetic failure after committed freeze');},scan:async(_scope,options)=>{
    attempts++;await page(options,'ucl',uclRows.slice(retryIndex,retryIndex+1),await store.soccerReturnErrorDatabaseNow(),'b'.repeat(48));
    retryIndex++;
    return {report:{complete:retryIndex===10,scan:{cursor:'b'.repeat(48),nextCursor:retryIndex===10?null:'b'.repeat(48),processedGames:retryIndex}}};
  }});
  assert.equal(retried.status,'RETRYABLE');assert.equal(attempts,11);
  assert.equal((await store.loadSoccerReturnErrorFreezeVerifier(ucl.protocolId)).freezes.length,1,'a partial acknowledgement failure leaves a real durable freeze');
  const freezeRetried=await run({league:'ucl'},{buildDataset,scan:async(_scope,options)=>{
    assert.equal(options.cursor,'b'.repeat(48));
    return {report:{complete:true,scan:{cursor:'b'.repeat(48),nextCursor:null,processedGames:10}}};
  }});
  assert.equal(freezeRetried.status,'RESEARCH_FROZEN',JSON.stringify(freezeRetried));
  assert.equal(freezeRetried.protocols[0].operation,'freeze','an interrupted freeze must resume even after one or more durable receipts exist');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[retryJobs[0].run_id])).rows[0].n,10);

  // A completed evaluation must later read a NEW source manifest, so results
  // arriving after the previous manifest are not lost forever.
  let evaluationWatermark=1;
  const sourceWatermark=async()=>hash(`epl-source-${evaluationWatermark}`);
  const evaluation=async rows=>{let index=0;return run({league:'epl'},{buildDataset,sourceWatermark,scan:async(_scope,options)=>{
    assert.equal(options.cursor,index===0?null:'c'.repeat(48));await page(options,'epl',rows.slice(index,index+1),await store.soccerReturnErrorDatabaseNow(),'c'.repeat(48));
    index++;return {report:{complete:index===rows.length,scan:{cursor:'c'.repeat(48),nextCursor:index===rows.length?null:'c'.repeat(48),processedGames:index}}};
  }});};
  assert.equal((await evaluation(eplRows)).status,'RESEARCH_EVALUATED');
  let repeatedScans=0;
  const unchanged=await run({league:'epl'},{sourceWatermark,scan:async()=>{repeatedScans++;throw Error('unchanged source must not rescan');}});
  assert.equal(unchanged.status,'UNCHANGED_SOURCE',JSON.stringify(unchanged));assert.equal(repeatedScans,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation='evaluate'",[epl.protocolId])).rows[0].n,1);
  await db.query("UPDATE sports_soccer_return_error_lifecycle_v1 SET replay_revision='SYNTHETIC_OLDER_RETURN_REPLAY' WHERE protocol_id=$1 AND operation='evaluate' AND status='COMPLETE'",[epl.protocolId]);
  assert.equal((await evaluation(eplRows)).status,'RESEARCH_EVALUATED','the same source watermark cannot reuse an older implementation result');
  const replayed=(await db.query("SELECT replay_revision FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation='evaluate' ORDER BY last_attempt_at DESC,run_id DESC LIMIT 1",[epl.protocolId])).rows[0];
  assert.equal(replayed.replay_revision,SOCCER_RETURN_ERROR_REPLAY_REVISION);
  evaluationWatermark=2;
  await new Promise(resolve=>setTimeout(resolve,10));
  const available=await store.soccerReturnErrorDatabaseNow();
  const testRow={...eplRows[0],observationId:hash('epl-test-row'),gameId:'soccer:epl:900000020',
    kickoff:iso(available-1),predictionCapturedAt:iso(available-3),checkedAt:iso(available)};
  const futureRow={...testRow,observationId:hash('future-result-row'),gameId:'soccer:epl:900000021',checkedAt:iso(available+86400000)};
  assert.equal((await evaluation([...eplRows,testRow,futureRow])).status,'RESEARCH_EVALUATED');
  const evaluations=(await db.query("SELECT * FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation='evaluate' ORDER BY evidence_cutoff_at,run_id",[epl.protocolId])).rows;
  assert.equal(evaluations.length,2);assert.notEqual(evaluations[0].run_id,evaluations[1].run_id);
  assert.equal(evaluations[0].artifact.groups[0].test.games,0);
  assert.equal(evaluations[1].artifact.groups[0].test.games,1,'a result check arriving after the job evidence cutoff cannot enter fit');
  assert.equal(evaluations[1].artifact.observedGames,11);
  assert.equal(evaluations[1].artifact.groups[0].testUntouchedVerified,true);
  assert.equal(evaluations[1].artifact.R,null);assert.equal(evaluations[1].artifact.accepted,false);
  const firstEvaluationId=evaluations[0].run_id;
  evaluationWatermark=3;await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await evaluation([...eplRows,testRow])).status,'RESEARCH_EVALUATED');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation='evaluate' AND status='COMPLETE'",[epl.protocolId])).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_v1 WHERE run_id=$1',[firstEvaluationId])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1',[firstEvaluationId])).rows[0].n,0);
  assert.equal((await store.loadSoccerReturnErrorFreezeVerifier(epl.protocolId)).freezes.length,1,'derived evaluation retention never removes original freeze receipts');
  const incompatibleTest={...testRow,predictionCapturedAt:iso(calibrationBefore-100)};
  const authority=await store.loadSoccerReturnErrorFreezeVerifier(epl.protocolId);
  const leadTime=fitSoccerReturnErrorResearch({datasets:[dataset('epl',[...eplRows,incompatibleTest])],
    protocol:epl.protocol,now:await store.soccerReturnErrorDatabaseNow(),verifyFrozenModelReceipt:authority.verifyFrozenModelReceipt});
  assert.equal(leadTime.groups[0].firstTestPredictionCapturedAt,incompatibleTest.predictionCapturedAt);
  assert.equal(leadTime.groups[0].testUntouchedVerified,false);
  assert.ok(leadTime.groups[0].missing.includes('TEST_PREDICTION_CAPTURE_NOT_AFTER_CALIBRATION_BOUNDARY'));
  assert.equal(leadTime.missingReasons.RETURN_ERROR_TEST_CAPTURE_LEAD_TIME_INCOMPATIBLE,1);
  assert.equal(leadTime.accepted,false);assert.equal(leadTime.R,null);
  // The production SQL watermark tracks meaningful original evidence, while
  // repeated check-window heartbeats cannot force another full replay.
  const watermarkCutoff=await store.soccerReturnErrorDatabaseNow();
  const noEvidence=await watermark(epl,watermarkCutoff);
  const forwardProtocol=(await db.query('SELECT protocol_version FROM sports_soccer_forward_protocol_v1 LIMIT 1')).rows[0].protocol_version;
  const originalRevision=hash('watermark-original-analysis'),watermarkCapture=hash('watermark-original-capture');
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
    VALUES('epl','soccer:epl:900009999',$1,$2::timestamptz,'{}'::jsonb)`,[originalRevision,iso(watermarkCutoff-200)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,'epl','soccer:epl:900009999',$3::date,'REGULATION_FT','BASELINE',$4,$5,$6::timestamptz)`,
    [watermarkCapture,forwardProtocol,soccerDate(watermarkCutoff),hash('watermark-model'),originalRevision,iso(watermarkCutoff-100)]);
  const originalEvidence=await watermark(epl,watermarkCutoff);assert.notEqual(originalEvidence,noEvidence);
  const proof={status:'CHECKED',checkWindow:'first-window',evaluation:{status:'EVALUATED',actualScore:{home:1,away:0},
    marketReturnValidation:{evidenceHash:hash('watermark-return')}},resultEvidence:{resultHash:hash('watermark-result')}};
  const addCheck=async(label,payload,at)=>db.query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,checked_at,payload)
    VALUES($1,$2,$3::timestamptz,$4::jsonb)`,[hash(label),watermarkCapture,iso(at),JSON.stringify(payload)]);
  await addCheck('watermark-check-1',proof,watermarkCutoff-50);
  const resultEvidence=await watermark(epl,watermarkCutoff);assert.notEqual(resultEvidence,originalEvidence);
  await addCheck('watermark-check-2',{...proof,checkWindow:'second-window',checkedAt:iso(watermarkCutoff-20)},watermarkCutoff-20);
  assert.equal(await watermark(epl,watermarkCutoff),resultEvidence,'identical result/economic evidence across heartbeat windows has one source identity');
  await addCheck('watermark-check-correction',{...proof,resultEvidence:{resultHash:hash('watermark-corrected-result')}},watermarkCutoff-10);
  const correctedEvidence=await watermark(epl,watermarkCutoff);assert.notEqual(correctedEvidence,resultEvidence,'a genuine result correction must trigger revalidation');
  await addCheck('watermark-check-future',{...proof,resultEvidence:{resultHash:hash('watermark-future-result')}},watermarkCutoff+86400000);
  assert.equal(await watermark(epl,watermarkCutoff),correctedEvidence,'new receipts beyond the fixed source cutoff cannot change the watermark');
  evaluationWatermark=4;
  assert.equal((await evaluation([...eplRows,testRow])).status,'RESEARCH_EVALUATED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1 WHERE capture_id=$1',[watermarkCapture])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_result_checks_v1 WHERE capture_id=$1',[watermarkCapture])).rows[0].n,4,'derived retention must preserve every original and corrected result receipt');
  console.log('PASS return-error lifecycle PostgreSQL orchestration: explicit missing configuration, league isolation, deadline continuation with complete durable datasets, transient page retry, expired cursor reset, frozen source cutoff, unchanged-source skip and new evaluation manifests and no fabricated acceptance');
} finally {
  if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;
  if(oldV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldV2;
  await fixture.close();
}
