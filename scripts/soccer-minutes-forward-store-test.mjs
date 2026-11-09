import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Storage-contract fixture only. The source producer is deliberately replaced
// with a private synthetic capability. The separate service tests exercise
// actual original-source reconstruction; none of these rows is Production.
const fixture=await soccerSqlFixture(),db=fixture.db,saved={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/minutes-forward';delete process.env.DATABASE_V2_URL;
const proofs=new WeakMap(),iso=t=>new Date(t).toISOString(),restriction={accepted:false,formalEligible:false,promotionEligible:false,executable:false,W:null,R:null,S:null};
globalThis.__MINUTES_STORE_SERVICE={
  soccerMinutesForwardProtocol:league=>({version:'SOCCER-MINUTES-FORWARD-v1',league,modelHash:'a'.repeat(64),artifactHash:'b'.repeat(64),
    modelCreatedAt:'2026-01-01T00:00:00.000Z',baselineMethod:'FIXED_PRIOR_BASELINE',metrics:['minuteMAE','minuteRMSE','logLoss','brier'],...restriction}),
  getSoccerMinutesForwardCaptureProof:prepared=>{const entry=proofs.get(prepared);return entry&&JSON.stringify(prepared)===entry.fingerprint?entry.proof:null;},
  replaySoccerMinutesForwardCapture:async({capture})=>({ok:true,body:capture.body}),
};
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){
  if(s==='./minutes-forward-validation.js'&&/\\/minutes-forward-store\\.js$/.test(c.parentURL||''))return {url:${JSON.stringify('data:text/javascript,'+encodeURIComponent(`
    export const soccerMinutesForwardProtocol=(...a)=>globalThis.__MINUTES_STORE_SERVICE.soccerMinutesForwardProtocol(...a);
    export const getSoccerMinutesForwardCaptureProof=(...a)=>globalThis.__MINUTES_STORE_SERVICE.getSoccerMinutesForwardCaptureProof(...a);
    export const replaySoccerMinutesForwardCapture=(...a)=>globalThis.__MINUTES_STORE_SERVICE.replaySoccerMinutesForwardCapture(...a);
  `))},shortCircuit:true};return n(s,c);}`),import.meta.url);
const store=await import('../lib/soccer/minutes-forward-store.js'),hash=store.soccerMinutesForwardStorageHash;
try{
  await store.ensureSoccerMinutesForwardStore();
  assert.equal(await store.loadSoccerMinutesForwardProtocol('epl'),null);
  const empty=await store.readSoccerMinutesForwardReportPage('epl');assert.equal(empty.counts.captures,0);assert.equal(empty.protocol,null);
  assert.equal(empty.accepted,false);assert.equal(empty.S,null);assert.equal(empty.page.reachedEnd,true);
  const freeze=await store.freezeSoccerMinutesForwardProtocol('epl');
  assert.deepEqual(await store.freezeSoccerMinutesForwardProtocol('epl'),freeze,'protocol DB receipt is immutable and repeated registration does not move its time');
  assert.equal(await store.loadSoccerMinutesForwardProtocol('ucl'),null,'protocol authority remains per league');
  const kickoff=Date.now()+2000;
  async function preparedFor(eventId,{cutoff=Date.now()+20,kickoffAt=kickoff,sourceLeague='epl',bodyExtra={},runStartedAt=iso(Date.now()),sourceFetchedAt=iso(Date.now()),observationRecordedAt=null}={}){
    const game={id:`soccer:epl:${eventId}`,sourceId:String(eventId),league:'epl',date:iso(kickoffAt+8*3600000).slice(0,10),startTime:iso(kickoffAt),status:'scheduled'},
      sourceHash=hash(['source',eventId]),sourceReceiptId=hash(['receipt',eventId]),analysisRevision=hash(['analysis',eventId,cutoff]);
    await db.query(`INSERT INTO sports_soccer_source_documents_v1(content_hash,representation,document_text,document_bytes)
      VALUES($1,'NORMALIZED_JSON_DOCUMENT','{}',2)`,[sourceHash]);
    const source=(await db.query(`INSERT INTO sports_soccer_source_document_observations_v1(receipt_id,content_hash,league,game_id,source_url,fetched_at,available_at,binding)
      VALUES($1,$2,$3,$4,'https://site.api.espn.com/fixture',$5::timestamptz,$5::timestamptz,'{}') RETURNING recorded_at`,[sourceReceiptId,sourceHash,sourceLeague,game.id,sourceFetchedAt])).rows[0];
    const runId=hash(['run',eventId]);
    await db.query(`INSERT INTO sports_soccer_analysis_runs_v2(run_id,league,game_id,board_date,started_at,quote_generation,requirements_version)
      VALUES($1,'epl',$2,$3::date,$4::timestamptz,0,'2.2')`,[runId,game.id,game.date,runStartedAt]);
    const body={game,fixture:true,...bodyExtra},original={date:game.date,analysisRunId:runId,analysisCutoff:iso(cutoff),evidence:{game,source:{contentHash:sourceHash},sourceDocumentArchive:{receiptId:sourceReceiptId}}};
    await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
      VALUES('epl',$1,$2,clock_timestamp(),$3::jsonb)`,[game.id,analysisRevision,JSON.stringify(original)]);
    const observationId=hash(['observation',eventId]);
    await db.query(`INSERT INTO sports_soccer_observations_v1(receipt_id,league,game_id,field,kind,binding,observation,reconstruction_inputs,recorded_at)
      VALUES($1,'epl',$2,'teams.home.minutes','PERSONNEL_RESEARCH','{}','{}','{}',coalesce($3::timestamptz,clock_timestamp()))`,[observationId,game.id,observationRecordedAt]);
    body.observationReceipts=[{receiptId:observationId,field:'teams.home.minutes'}];
    const prepared={fixture:true,eventId},proof={league:'epl',gameId:game.id,date:game.date,kickoffAt:game.startTime,
      analysisRevision,analysisCutoff:iso(cutoff),sourceReceiptId,sourceHash,sourceRecordedAt:iso(source.recorded_at),body,protocolHash:freeze.protocolHash,
      observationReceipts:[{receiptId:observationId,field:'teams.home.minutes'}]};
    proofs.set(prepared,{fingerprint:JSON.stringify(prepared),proof});return prepared;
  }
  assert.equal((await store.archiveSoccerMinutesForwardCapture({accepted:true})).persisted,false,'JSON flags cannot mint a private source capability');
  const stale=await preparedFor('91',{cutoff:Date.parse(freeze.registeredAt)-1});
  assert.equal((await store.archiveSoccerMinutesForwardCapture(stale)).persisted,false,'protocol must precede original analysis cutoff');
  const late=await preparedFor('92',{kickoffAt:Date.now()-1});assert.equal((await store.archiveSoccerMinutesForwardCapture(late)).persisted,false,'late DB observation cannot backdate capture');
  const foreign=await preparedFor('93',{sourceLeague:'ucl'});await new Promise(r=>setTimeout(r,25));
  assert.equal((await store.archiveSoccerMinutesForwardCapture(foreign)).persisted,false,'borrowed source receipt cannot cross leagues');
  const oldRun=await preparedFor('94',{runStartedAt:iso(Date.parse(freeze.registeredAt)-100)});
  const oldCurrentSource=await preparedFor('95',{sourceFetchedAt:iso(Date.parse(freeze.registeredAt)-100)});await new Promise(r=>setTimeout(r,25));
  assert.equal((await store.archiveSoccerMinutesForwardCapture(oldRun)).persisted,false,'freeze after an analysis run started cannot create untouched prospective evidence');
  assert.equal((await store.archiveSoccerMinutesForwardCapture(oldCurrentSource)).persisted,false,'freeze after acquiring current target summary cannot create untouched prospective evidence');
  const lateObservation=await preparedFor('96',{observationRecordedAt:iso(Date.now()+86400000)});await new Promise(r=>setTimeout(r,25));
  assert.equal((await store.archiveSoccerMinutesForwardCapture(lateObservation)).persisted,false,'a future personnel archive cannot backdate an analysis source even through private proof');
  const a=await preparedFor('101'),b=await preparedFor('102');await new Promise(r=>setTimeout(r,25));
  const first=await store.archiveSoccerMinutesForwardCapture(a),second=await store.archiveSoccerMinutesForwardCapture(b);
  assert.equal(first.persisted,true,JSON.stringify(first));assert.equal(second.persisted,true,JSON.stringify(second));
  assert.equal((await store.archiveSoccerMinutesForwardCapture(a)).captureId,first.captureId,'same game protocol keeps the first forecast');
  assert.equal(await store.hasSoccerMinutesForwardCapture('epl','soccer:epl:101'),true);
  assert.equal(await store.hasSoccerMinutesForwardCapture('ucl','soccer:ucl:101'),false);
  a.changed=true;assert.equal((await store.archiveSoccerMinutesForwardCapture(a)).persisted,false,'mutated prepared body loses private producer capability');
  const capture=await store.loadSoccerMinutesForwardCapture('epl',first.captureId);assert.equal(capture.body.game.id,'soccer:epl:101');
  const oldReplay=globalThis.__MINUTES_STORE_SERVICE.replaySoccerMinutesForwardCapture;
  globalThis.__MINUTES_STORE_SERVICE.replaySoccerMinutesForwardCapture=async()=>({ok:true,body:{forged:true}});
  await assert.rejects(()=>store.loadSoccerMinutesForwardCapture('epl',first.captureId),/SOURCE_REPLAY_FAILED/);
  const isolated=await store.readSoccerMinutesForwardReportPage('epl');
  assert.equal(isolated.captures[0].sourceReplayError,'MINUTES_FORWARD_CAPTURE_SOURCE_REPLAY_FAILED');
  assert.equal(isolated.page.reachedEnd,false,'one source replay failure can quarantine one game and retain the next-page cursor');
  globalThis.__MINUTES_STORE_SERVICE.replaySoccerMinutesForwardCapture=oldReplay;
  const page=await store.readSoccerMinutesForwardReportPage('epl');assert.equal(page.counts.captures,2);assert.equal(page.captures.length,1);assert.equal(page.page.reachedEnd,false);
  const next=await store.readSoccerMinutesForwardReportPage('epl',{afterSequence:page.page.nextSequence,revision:page.page.revision});
  assert.equal(next.captures[0].captureId,second.captureId);assert.equal(next.page.reachedEnd,true);
  await assert.rejects(()=>store.readSoccerMinutesForwardReportPage('epl',{afterSequence:'999999',revision:page.page.revision}),/CURSOR_INVALID/);
  const pending=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING'});
  await assert.rejects(()=>store.readSoccerMinutesForwardReportPage('epl',{afterSequence:page.page.nextSequence,revision:page.page.revision}),/HISTORY_CHANGED/);
  const repeated=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING'});
  assert.equal(repeated.checkId,pending.checkId);assert.ok(Date.parse(repeated.attemptedAt)>=Date.parse(pending.attemptedAt));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_minutes_forward_checks_v1')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_minutes_forward_attempts_v1')).rows[0].n,2,'deduplicated failures still advance fair attempt receipts');
  const preKickoff=await store.readSoccerMinutesForwardReportPage('epl');assert.equal(preKickoff.counts.upcoming,2);
  if(kickoff>=Date.now())await new Promise(r=>setTimeout(r,kickoff-Date.now()+5));
  await assert.rejects(()=>store.readSoccerMinutesForwardReportPage('epl',{revision:preKickoff.page.revision}),/HISTORY_CHANGED/,
    'crossing kickoff changes snapshot revision so a paged reader restarts instead of mixing upcoming denominators');
  const queue=await store.listSoccerMinutesForwardPending('epl',{limit:1,recheckAfterMs:0});assert.equal(queue.captures[0].captureId,second.captureId);
  await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:second.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING'});
  assert.equal((await store.listSoccerMinutesForwardPending('epl',{limit:1,recheckAfterMs:0})).captures[0].captureId,first.captureId,'queue uses latest attempt, including deduplicated failures');
  const doc={scoreboard:{ok:false,code:'SOURCE_FAILED',source:{fetchedAt:iso(Date.now()-10)}},summaries:[]};
  const d1=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING',resultDocuments:doc});
  const changed=structuredClone(doc);changed.scoreboard.source.fetchedAt=iso(Date.now()-2);
  const d2=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING',resultDocuments:changed});
  assert.equal(d2.checkId,d1.checkId,'exact raw body retained once, fetch metadata separately appended');
  const read=await store.readSoccerMinutesForwardReportPage('epl');assert.equal(read.checks.find(c=>c.checkId===d1.checkId).resultDocuments.scoreboard.source.fetchedAt,doc.scoreboard.source.fetchedAt);
  const retryRevision=read.page.revision;
  await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',reason:'MINUTES_RESULT_PENDING',resultDocuments:changed});
  assert.equal((await store.readSoccerMinutesForwardReportPage('epl')).page.revision,retryRevision,'failed-source retry clocks do not change accepted-result evidence revision');
  const reference=Date.now(),raw=(state,fetchedAt)=>({scoreboard:{ok:true,data:{state},source:{provider:'ESPN',contentHash:hash({state}),fetchedAt:iso(fetchedAt)}},summaries:[]});
  const early=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',resultDocuments:raw('PENDING',reference-30)});
  await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'EVALUATED',resultDocuments:raw('FINAL',reference-20)});
  const beforeWithdrawal=await store.readSoccerMinutesForwardReportPage('epl');
  const withdrawal=await store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',resultDocuments:raw('PENDING',reference-10)});
  assert.equal(withdrawal.checkId,early.checkId,'same complete raw document remains stored once');
  const withdrawn=await store.readSoccerMinutesForwardReportPage('epl');
  assert.notEqual(withdrawn.page.revision,beforeWithdrawal.page.revision,'a true later successful-source observation changes read revision even if raw data deduplicate');
  const chronology=withdrawn.checks.filter(c=>c.resultDocuments?.scoreboard?.ok).flatMap(c=>c.attempts.map(a=>({state:c.resultDocuments.scoreboard.data.state,at:a.sourceObservations[0].source.fetchedAt}))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  assert.deepEqual(chronology.map(c=>c.state),['PENDING','FINAL','PENDING'],'new source-clock attempts preserve nonfinal→final→same-nonfinal withdrawal for service replay');
  await assert.rejects(()=>store.readSoccerMinutesForwardReportPage('epl',{revision:beforeWithdrawal.page.revision}),/HISTORY_CHANGED/);
  changed.scoreboard.source.fetchedAt=iso(Date.now()+86400000);
  await assert.rejects(()=>store.archiveSoccerMinutesForwardCheck({league:'epl',captureId:first.captureId,status:'PENDING',resultDocuments:changed}),/STORAGE_UNAVAILABLE/);
  for(const table of ['protocols','captures','checks','attempts'])for(const operation of ['UPDATE','DELETE'])await assert.rejects(()=>db.query(operation==='UPDATE'
    ?`UPDATE sports_soccer_minutes_forward_${table}_v1 SET league=league`.replace(' SET league=league',table==='attempts'?' SET capture_id=capture_id':' SET league=league')
    :`DELETE FROM sports_soccer_minutes_forward_${table}_v1`),/SOCCER_IMMUTABLE_HISTORY/);
  console.log('PASS minutes-forward storage: real PostgreSQL immutable protocol/capture/check/attempt rows, DB-clock and original-source FK fencing, private capability/mutation rejection, exact replay, first-game deduplication, bounded revision-paged histories and fair retry queue (synthetic source producer only; no Production/OOS acceptance)');
}finally{
  delete globalThis.__MINUTES_STORE_SERVICE;
  for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await fixture.close();
}
