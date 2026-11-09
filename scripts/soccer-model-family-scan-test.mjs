import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerModelFamilyHash as hash } from '../lib/soccer/model-family-uncertainty.js';

// Synthetic source/page dependencies exercise the shipped durable replay on
// actual PostgreSQL (WASM). No fixture is evidence of Production coverage,
// model applicability, predictive performance or formal scoring eligibility.
const fixture=await soccerSqlFixture(),{db}=fixture;
const old={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/model-family-scan';delete process.env.DATABASE_V2_URL;
const scan=await import('../lib/soccer/model-family-scan.js');
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
const iso=value=>new Date(value).toISOString(),day=86400000;
const scope={league:'epl',period:'FT'};
const rejects=(action,code,status=503)=>assert.rejects(action,error=>error.message===code&&error.status===status);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const restrictions=value=>{
  for(const key of ['accepted','formalEligible','executable'])assert.equal(value[key],false,key);
  for(const key of ['W','R','S'])assert.equal(value[key],null,key);
};

try {
  const [{observed_at:dbNow}]=await query('SELECT clock_timestamp() AS observed_at');
  const now=new Date(dbNow).getTime(),start=now-10*day;
  const baseline={...scope,modelHash:hash('scan-fixed-synthetic-model'),trainingHash:hash('scan-synthetic-training'),
    sourceHashes:[hash('scan-synthetic-source')],trainedThrough:iso(start-2*day),createdAt:iso(start-day)};
  const protocol={registeredAt:iso(start-1000),calibrationFrom:iso(start),calibrationBefore:iso(now-day),alpha:.1};
  const rows=Array.from({length:2},(_,i)=>({...scope,baselineModelHash:baseline.modelHash,
    gameId:`soccer:epl:${910000001+i}`,homeRate:1.5,awayRate:1.1,actualScore:{home:i+1,away:1},
    sourceHashes:[hash(`scan-synthetic-result-${i}`)],kickoff:iso(start+i*day+3600000),
    predictedAt:iso(start+i*day+3500000),resultAvailableAt:iso(start+i*day+7200000)}));
  const source={...scope,baseline,protocol,sourceRevision:hash('scan-source-revision'),totalCaptures:2,
    sourceModelFreezeVerified:true};
  const page=(index,extra={})=>{
    const body={baseline,protocol,sourceRevision:source.sourceRevision,
      observations:[rows[index]],quarantinedGameIds:[],excludedReasons:{},
      coverage:{readCaptures:1,totalCaptures:2,complete:index===1,nextSequence:index===1?null:'1'},...extra};
    return {...body,contentHash:hash(body)};
  };
  const reads={query,latestFreeze:async()=>null};
  const ordinary={...reads,metadata:async()=>structuredClone(source),page:async args=>page(args.afterSequence==='0'?0:1)};
  const stored=async cursor=>(await query('SELECT * FROM sports_soccer_model_family_scans_v1 WHERE cursor=$1',[cursor]))[0];
  const partial=()=>scan.continueSoccerModelFamilyScan(scope,ordinary);

  assert.equal((await scan.readSoccerModelFamilyScan(scope,reads)).status,'NOT_STARTED');
  let metadataNow,pageNow,pageCalls=0;
  const deps={...ordinary,clock:()=>0,metadata:async args=>{metadataNow=args.now;return structuredClone(source);},
    page:async args=>{pageCalls++;pageNow=args.now;assert.equal(args.captureLimit,1);assert.equal(args.expectedRevision,source.sourceRevision);
      assert.deepEqual(args.protocol,protocol);return page(args.afterSequence==='0'?0:1);}};
  const first=await scan.continueSoccerModelFamilyScan(scope,deps);
  assert.equal(first.status,'REPLAY_PARTIAL');assert.equal(first.totalCaptures,2);assert.equal(first.processedCaptures,1);
  assert.equal(first.completeWithinRequestedScope,false);assert.equal(first.confidenceSet,null);assert.equal(first.diagnostics,null);
  assert.equal(first.nextCursor,first.cursor);restrictions(first);
  assert.equal(metadataNow,pageNow);assert.equal(metadataNow,Date.parse(first.asOf));
  assert.equal(new Date((await stored(first.cursor)).as_of).getTime(),metadataNow,'the metadata cutoff and persisted replay cutoff share the database clock');
  assert.ok(metadataNow>=now&&metadataNow<now+60000,'an injected application clock cannot backdate metadata');
  await rejects(()=>scan.freezeSoccerModelFamilyScan({...scope,cursor:first.cursor},{query}), 'MODEL_FAMILY_COMPLETE_DATASET_REQUIRED',409);

  const final=await scan.continueSoccerModelFamilyScan({...scope,cursor:first.cursor},deps);
  assert.equal(final.status,'REPLAY_COMPLETE');assert.equal(final.processedCaptures,2);assert.equal(final.nextCursor,null);
  assert.equal(final.completeWithinRequestedScope,true);assert.equal(final.confidenceSet.independentRealGames,2);
  assert.equal(final.diagnostics.calibration.realGames,2);assert.equal(final.confidenceSet.generatedAt,first.asOf);
  assert.equal(final.confidenceSet.baseline.league,'epl');assert.equal(final.confidenceSet.baseline.period,'FT');
  assert.deepEqual(final.confidenceSet.protocol,protocol);assert.equal(final.sourceModelFreezeVerified,true);
  assert.equal(final.familyProtocolProspectiveVerified,false);
  assert.equal(final.registrationInterpretation,'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION');
  for(const value of [final,final.confidenceSet,final.diagnostics])restrictions(value);
  assert.equal(final.confidenceSet.coverageAssumptionsVerified,false);
  assert.equal(final.confidenceSet.modelMisspecificationBound,null);
  assert.equal(final.diagnostics.untouchedTestVerified,false);
  assert.equal('observations' in final,false,'private raw observations are not returned in the public report');
  assert.equal('state' in final,false);
  const frozenState=(await stored(final.cursor)).state,finalRevision=(await stored(final.cursor)).revision;
  assert.deepEqual(await scan.continueSoccerModelFamilyScan({...scope,cursor:final.cursor},deps),final);
  assert.deepEqual(await scan.readSoccerModelFamilyScan({...scope,cursor:final.cursor},reads),{...final,freeze:null,freezeMatchesReplay:false});
  assert.equal(pageCalls,2,'a completed cursor neither replays nor fits a third time');
  assert.deepEqual((await stored(final.cursor)).state,frozenState);assert.equal((await stored(final.cursor)).revision,finalRevision);
  for(const other of [{league:'ucl',period:'FT'},{league:'epl',period:'HT'}]) {
    await rejects(()=>scan.continueSoccerModelFamilyScan({...other,cursor:final.cursor},ordinary),'MODEL_FAMILY_SCAN_SCOPE_OR_EXPIRY_INVALID',400);
    await rejects(()=>scan.readSoccerModelFamilyScan({...other,cursor:final.cursor},{query}),'MODEL_FAMILY_SCAN_SCOPE_OR_EXPIRY_INVALID',400);
    await rejects(()=>scan.freezeSoccerModelFamilyScan({...other,cursor:final.cursor},{query}),'MODEL_FAMILY_SCAN_SCOPE_OR_EXPIRY_INVALID',400);
  }
  for(const request of [{league:'nba',period:'FT'},{...scope,cursor:'forged'}])
    await rejects(()=>scan.continueSoccerModelFamilyScan(request,ordinary),'MODEL_FAMILY_SCAN_SCOPE_INVALID',400);

  // Source or page errors must leave durable progress intact and release only
  // this request's lease, so an operator can retry without duplicate games.
  async function rejectPage(makePage,code='MODEL_FAMILY_SCAN_PAGE_INVALID',status=503) {
    const job=await partial(),before=await stored(job.cursor);
    await rejects(()=>scan.continueSoccerModelFamilyScan({...scope,cursor:job.cursor},{...ordinary,page:async()=>makePage()}),code,status);
    const after=await stored(job.cursor);
    assert.equal(after.processed,before.processed);assert.equal(after.revision,before.revision);
    assert.deepEqual(after.state,before.state);assert.equal(after.lease_owner,null);assert.equal(after.lease_until,null);
    return job;
  }
  await rejectPage(()=>page(1,{sourceRevision:hash('changed-revision')}),'MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);
  await rejectPage(()=>page(1,{baseline:{...baseline,modelHash:hash('wrong-baseline-hash')}}),'MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);
  await rejectPage(()=>page(1,{protocol:{...protocol,alpha:.2}}),'MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);
  await rejectPage(()=>({...page(1),contentHash:hash('wrong-page-hash')}),'MODEL_FAMILY_SCAN_PAGE_HASH_INVALID');
  await rejectPage(()=>{const value=page(1);delete value.contentHash;return value;},'MODEL_FAMILY_SCAN_PAGE_HASH_INVALID');
  await rejectPage(()=>page(1,{coverage:undefined}));
  await rejectPage(()=>page(1,{observations:null}));
  await rejectPage(()=>page(1,{quarantinedGameIds:null}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:0,totalCaptures:2,complete:true,nextSequence:null}}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:2,totalCaptures:2,complete:true,nextSequence:null}}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:1,totalCaptures:0,complete:true,nextSequence:null}}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:NaN,totalCaptures:2,complete:true,nextSequence:null}}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:1,totalCaptures:2,complete:false,nextSequence:'1'}}));
  await rejectPage(()=>page(1,{coverage:{readCaptures:0,totalCaptures:2,complete:false,nextSequence:'0'}}));
  await rejectPage(()=>page(1,{excludedReasons:{'human text':1}}));
  await rejectPage(()=>page(1,{excludedReasons:{SOURCE_RESULT_MISSING:-1}}));

  const countBefore=(await query('SELECT count(*)::integer AS n FROM sports_soccer_model_family_scans_v1'))[0].n;
  for(const totalCaptures of [undefined,null,'2',-1,1001])
    await rejects(()=>scan.continueSoccerModelFamilyScan(scope,{...ordinary,metadata:async()=>({...source,totalCaptures})}),
      'MODEL_FAMILY_SCAN_SOURCE_SCOPE_UNAVAILABLE');
  assert.equal((await query('SELECT count(*)::integer AS n FROM sports_soccer_model_family_scans_v1'))[0].n,countBefore,
    'unavailable source counts are rejected rather than coerced into an empty replay');
  const empty=await scan.continueSoccerModelFamilyScan(scope,{...ordinary,metadata:async()=>({...source,totalCaptures:0}),
    page:async()=>page(0,{observations:[],coverage:{readCaptures:0,totalCaptures:0,complete:true,nextSequence:null}})});
  assert.equal(empty.totalCaptures,0);assert.equal(empty.processedCaptures,0);
  assert.equal(empty.confidenceSet.status,'MISSING_VALID_CALIBRATION_GAMES');restrictions(empty);
  await rejects(()=>scan.freezeSoccerModelFamilyScan({...scope,cursor:empty.cursor},{query}),'MODEL_FAMILY_COMPLETE_DATASET_REQUIRED',409);

  // A zero-progress first page remains resumable but cannot persist transient
  // missing-result counters or quarantine an earlier receipt on each retry.
  const noProgress=await scan.continueSoccerModelFamilyScan(scope,{...ordinary,
    page:async()=>page(0,{observations:[],quarantinedGameIds:[rows[0].gameId],excludedReasons:{SOURCE_RESULT_MISSING:1},
      page:{reason:'MODEL_FAMILY_SOURCE_TIME_BUDGET'},coverage:{readCaptures:0,totalCaptures:2,complete:false,nextSequence:'0'}})});
  assert.equal(noProgress.processedCaptures,0);assert.equal(noProgress.confidenceSet,null);
  assert.equal(noProgress.lastPageReason,'MODEL_FAMILY_SOURCE_TIME_BUDGET');assert.equal(noProgress.quarantinedGames,0);
  assert.deepEqual(noProgress.excludedReasons,{});assert.equal((await stored(noProgress.cursor)).revision,0);
  const retry=await scan.continueSoccerModelFamilyScan({...scope,cursor:noProgress.cursor},{...ordinary,
    page:async()=>page(0,{observations:[],excludedReasons:{SOURCE_RESULT_MISSING:1},
      coverage:{readCaptures:0,totalCaptures:2,complete:false,nextSequence:'0'}})});
  assert.equal(retry.lastPageReason,'MODEL_FAMILY_DATA_TIME_BUDGET');assert.deepEqual(retry.excludedReasons,{});
  assert.equal((await stored(noProgress.cursor)).revision,0);assert.equal((await stored(noProgress.cursor)).lease_owner,null);
  assert.equal((await scan.continueSoccerModelFamilyScan({...scope,cursor:noProgress.cursor},ordinary)).processedCaptures,1);

  const corrupt=await partial();
  await query(`UPDATE sports_soccer_model_family_scans_v1 SET state=jsonb_set(state,'{stateHash}',to_jsonb($2::text)) WHERE cursor=$1`,[corrupt.cursor,hash('wrong-state-hash')]);
  await rejects(()=>scan.readSoccerModelFamilyScan({...scope,cursor:corrupt.cursor},{query}),'MODEL_FAMILY_SCAN_STATE_INVALID');
  await rejects(()=>scan.continueSoccerModelFamilyScan({...scope,cursor:corrupt.cursor},ordinary),'MODEL_FAMILY_SCAN_STATE_INVALID');

  // Concurrent requests share one DB lease. The loser must neither call the
  // source adapter nor overwrite the winner when it finishes later.
  const concurrent=await partial(),entered=deferred(),release=deferred();let heldPages=0;
  const winner=scan.continueSoccerModelFamilyScan({...scope,cursor:concurrent.cursor},{...ordinary,page:async()=>{
    heldPages++;entered.resolve();await release.promise;return page(1);
  }});
  await entered.promise;
  try {
    const busy=await scan.continueSoccerModelFamilyScan({...scope,cursor:concurrent.cursor},{...ordinary,page:async()=>{throw Error('busy lease called adapter');}});
    assert.equal(busy.status,'REPLAY_BUSY');assert.equal(busy.processedCaptures,1);assert.equal(busy.confidenceSet,null);
  } finally { release.resolve(); }
  assert.equal((await winner).processedCaptures,2);assert.equal(heldPages,1);
  assert.equal((await stored(concurrent.cursor)).revision,2);assert.equal((await stored(concurrent.cursor)).lease_owner,null);

  for(const sabotage of ['revision','lease']) {
    const job=await partial(),before=await stored(job.cursor);
    await rejects(()=>scan.continueSoccerModelFamilyScan({...scope,cursor:job.cursor},{...ordinary,page:async()=>{
      if(sabotage==='revision')await query('UPDATE sports_soccer_model_family_scans_v1 SET revision=revision+1 WHERE cursor=$1',[job.cursor]);
      else await query(`UPDATE sports_soccer_model_family_scans_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE cursor=$1`,[job.cursor]);
      return page(1);
    }}),'MODEL_FAMILY_SCAN_LEASE_LOST');
    const after=await stored(job.cursor);assert.equal(after.processed,1);assert.equal(after.complete,false);
    assert.deepEqual(after.state,before.state,'a lost CAS cannot overwrite persisted partial evidence');assert.equal(after.lease_owner,null);
  }

  const duplicate=await partial();
  const deduplicated=await scan.continueSoccerModelFamilyScan({...scope,cursor:duplicate.cursor},{...ordinary,page:async()=>page(1,{observations:[rows[0]]})});
  assert.equal(deduplicated.processedCaptures,2);assert.equal(deduplicated.confidenceSet.independentRealGames,1);
  assert.equal(deduplicated.diagnostics.calibration.realGames,1);
  const quarantined=await partial();
  const removed=await scan.continueSoccerModelFamilyScan({...scope,cursor:quarantined.cursor},{...ordinary,page:async()=>page(1,
    {quarantinedGameIds:[rows[0].gameId],excludedReasons:{SOURCE_RESULT_CONFLICT:1}})});
  assert.equal(removed.quarantinedGames,1);assert.equal(removed.confidenceSet.independentRealGames,1);
  assert.equal(removed.excludedReasons.SOURCE_RESULT_CONFLICT,1,'a later correction removes an earlier page game before fitting');

  let freezeInput,freezeMetadata;
  const [{observed_at:freezeDbNow}]=await query('SELECT clock_timestamp() AS observed_at');
  const frozen=await scan.freezeSoccerModelFamilyScan({...scope,cursor:final.cursor},{...ordinary,clock:()=>0,
    metadata:async args=>{freezeMetadata=args;return structuredClone(source);},
    freeze:async input=>{freezeInput=input;return {status:'TEST_ONLY_FREEZE_RECEIPT'};}});
  assert.equal(frozen.freeze.status,'TEST_ONLY_FREEZE_RECEIPT');assert.deepEqual(freezeInput.artifact,final.confidenceSet);
  assert.deepEqual(freezeMetadata,{...scope,now:Date.parse(final.asOf)},'freeze checks source identity at the original replay cutoff');
  assert.equal(freezeInput.testFrom,iso((Math.floor(new Date(freezeDbNow).getTime()/day)+1)*day),
    'the future test boundary comes from the current database day, never a caller clock');
  assert.equal(freezeInput.testBefore,'2026-12-23T00:00:00.000Z');restrictions(frozen);
  for(const changed of [{...source,sourceRevision:hash('post-replay-source-change')},
    {...source,baseline:{...baseline,trainingHash:hash('post-replay-training-change')}}])
    await rejects(()=>scan.freezeSoccerModelFamilyScan({...scope,cursor:final.cursor},{...ordinary,metadata:async()=>changed,
      freeze:async()=>{throw Error('changed source reached freeze');}}),'MODEL_FAMILY_SCAN_SOURCE_CHANGED',409);

  let latestIdentity;
  const receipt={status:'TEST_ONLY_DATABASE_RECEIPT',sourceArtifactHash:final.confidenceSet.contentHash};
  const withFreeze=await scan.readSoccerModelFamilyScan({...scope,cursor:final.cursor},{query,latestFreeze:async identity=>{
    latestIdentity=identity;return receipt;
  }});
  assert.deepEqual(latestIdentity,{...scope,modelHash:baseline.modelHash,trainingHash:baseline.trainingHash});
  assert.deepEqual(withFreeze.freeze,receipt);assert.equal(withFreeze.freezeMatchesReplay,true);restrictions(withFreeze);
  const changedReceipt=await scan.readSoccerModelFamilyScan({...scope,cursor:final.cursor},{query,
    latestFreeze:async()=>({...receipt,sourceArtifactHash:hash('another-replay-artifact')})});
  assert.equal(changedReceipt.freezeMatchesReplay,false);assert.equal(changedReceipt.familyProtocolProspectiveVerified,false);
  console.log('PASS model-family durable replay PostgreSQL regression: pinned DB cutoff, bounded complete-source fitting, cursor scope/revision/page/state hash integrity, unavailable counts, duplicate/quarantine handling, concurrent lease and lost-CAS authority, noninflating retries, immutable completed readback, fresh-source DB-clock freeze, exact-scope freeze readback and no formal promotion (synthetic engineering fixtures only)');
} finally {
  for(const key of Object.keys(old)){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
  await fixture.close();
}
