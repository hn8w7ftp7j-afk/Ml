import assert from 'node:assert/strict';
import { createSessionToken } from '../lib/security.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// This exercises the actual route and immutable stores against isolated
// PostgreSQL. Every game, price and record is synthetic and no bet is placed.
const fixture = await soccerSqlFixture();
process.env.DATABASE_URL = 'postgres://fixture.invalid/provisional-manual';
delete process.env.DATABASE_V2_URL;
process.env.APP_PASSWORD = 'synthetic-provisional-pass';
process.env.SESSION_SECRET = 'synthetic-provisional-secret';
const { beginSoccerAnalysisRun, finishSoccerAnalysisRun } = await import('../lib/soccer/journal.js');
const { saveSoccerAnalysis } = await import('../lib/soccer/analysis-store.js');
const { soccerAnalysisHash, SOCCER_ANALYSIS_VERSION } = await import('../lib/soccer/analysis.js');
const { soccerManualContractHash, settleSoccerManualRecord } = await import('../lib/soccer/manual-settlement.js');
const { soccerRecordStats } = await import('../lib/soccer/manual-record.js');
const { archiveSoccerSettlementCheck, listSoccerManualRecords, listUnsettledSoccerManualRecords } = await import('../lib/soccer/manual-record-store.js');
const { settleOpenSoccerManualRecords } = await import('../lib/soccer/manual-settlement-service.js');
const { GET, POST } = await import('../app/api/soccer/bet-records/route.js');
const now = Date.now(), date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const game = { id:'soccer:epl:123', sourceId:'123', league:'epl', date, startTime:new Date(now+86400000).toISOString(), status:'scheduled',
  home:{id:'soccer:epl:team:359',name:'Fixture Home',sourceId:'359'}, away:{id:'soccer:epl:team:364',name:'Fixture Away',sourceId:'364'} };
const quote = { key:'provisional-q1',period:'FT',unit:'GOALS',kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,label:'大 3+50',
  eligible:false,formalEligible:false,executable:false,provenance:{gameId:game.id,observedAt:new Date(now).toISOString()} };
const session = `mlb_session=${await createSessionToken()}`;
const request = (method, body={}, league='epl') => new Request(`http://localhost/api/soccer/bet-records?league=${league}&date=${date}`,
  {method,headers:{cookie:session,origin:'http://localhost','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});

try {
  const run = await beginSoccerAnalysisRun({league:'epl',date,gameId:game.id});
  const body = {version:SOCCER_ANALYSIS_VERSION,analysisRunId:run.runId,league:'epl',date,gameId:game.id,observedAt:new Date(now).toISOString(),
    analysisStatus:'COMPLETED',formalScoringEnabled:false,qualification:{eligible:false},directions:[],evidence:{game},executable:false,
    provisionalReaderResearch:{status:'UNVERIFIED_SCHEDULE_SCOPE',identityScope:'UNIQUE_AMONG_FETCHED_SCHEDULE_ONLY',
      scheduleCompletenessVerified:false,formalEligible:false,executable:false,gameId:game.id,league:'epl',date,quotes:[quote]}};
  const saved = await saveSoccerAnalysis({...body,analysisHash:soccerAnalysisHash(body)});
  await finishSoccerAnalysisRun(run,{analysisStatus:'COMPLETED',qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',revision:saved.revision,validUntil:new Date(now+120000).toISOString()});
  const recordAction={action:'record',alreadyPlaced:true,league:'epl',date,gameId:game.id,revision:saved.revision,quoteKey:quote.key};
  assert.equal((await POST(request('POST',recordAction))).status,400,'unverified quote requires explicit acknowledgement');
  const response=await POST(request('POST',{...recordAction,identityUnverifiedAcknowledged:true,water:8,stake:9}));
  assert.equal(response.status,200); const first=(await response.json()).record;
  assert.equal(first.sourceIdentityStatus,'SELF_ASSERTED_UNVERIFIED');assert.equal(first.water,.95);assert.equal(first.stake,10000);
  assert.equal(first.formalEligible,false);assert.equal(first.calibrationEligible,false);assert.equal(first.executable,false);
  assert.equal((await GET(request('GET',{},'ucl'))).status,200);
  assert.deepEqual((await (await GET(request('GET',{},'ucl'))).json()).records,[],'no cross-league record leakage');
  const cancelled=(await (await POST(request('POST',{action:'cancel',league:'epl',date,id:first.id}))).json()).record;
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.sourceIdentityStatus,'SELF_ASSERTED_UNVERIFIED');
  const restored=(await (await POST(request('POST',{action:'restore',league:'epl',date,id:first.id}))).json()).record;
  assert.equal(restored.status,'OPEN');assert.deepEqual(restored.history.map(x=>x.action),['cancel','restore']);
  for(const key of ['water','stake','sourceQuote','analysisRevision','sourceIdentityStatus'])assert.deepEqual(restored[key],first[key]);
  const repeated=(await (await POST(request('POST',{...recordAction,identityUnverifiedAcknowledged:true}))).json()).record;
  assert.equal(repeated.id,first.id,'repeated record preserves the original durable record');

  const settledAt=now+2*86400000, check=settleSoccerManualRecord(restored,{ok:true,verified:true,status:'NORMAL_FINAL_CROSSCHECKED'},
    {status:'SOURCE_TERMS_VERIFIED'},settledAt);
  assert.equal(check.status,'PENDING');assert.equal(check.reason,'RESULT_READER_IDENTITY_UNVERIFIED');
  assert.equal(check.contractHash,soccerManualContractHash(restored));
  let resultFetches=0,contractReads=0;
  const summary=await settleOpenSoccerManualRecords({league:'epl',date,now:()=>settledAt,
    load:async()=>{resultFetches++;throw Error('unverified identity must not fetch');},
    resolveContract:()=>{contractReads++;throw Error('unverified identity must not settle');}});
  assert.equal(summary.checked,1);assert.equal(summary.pending,1);assert.equal(summary.settled,0);assert.equal(summary.resultVerified,0);
  assert.equal(summary.reasons.RESULT_READER_IDENTITY_UNVERIFIED,1);assert.equal(resultFetches,0);assert.equal(contractReads,0);
  const [readback]=await listSoccerManualRecords('epl',date);
  assert.equal(readback.settlement,undefined);assert.equal(readback.settlementCheck.reason,'RESULT_READER_IDENTITY_UNVERIFIED');
  assert.equal(readback.settlementCheck.resultEvidence,undefined);

  // Independent DB fence: even an internal caller that omits the self-asserted
  // flag cannot insert a fabricated SETTLEMENT against the persisted record.
  const forged={...restored};delete forged.sourceIdentityStatus;
  const fakeSettlement={status:'SETTLED',contractHash:soccerManualContractHash(forged),profit:1,stake:10000,contractVersion:'fake',resultHash:'fake'};
  await assert.rejects(()=>archiveSoccerSettlementCheck(forged,fakeSettlement),/來源身分尚未核對/);
  assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM sports_soccer_settlement_events_v1 WHERE event_type='SETTLEMENT'")).rows[0].n,0);

  // A historic snapshot may contain directions from before the identity gate.
  // New recordings still need affirmative acknowledgement and quarantine.
  const legacyRun=await beginSoccerAnalysisRun({league:'epl',date,gameId:game.id});
  const legacyQuote={...quote,key:'legacy-q1',side:'under',label:'小 3+50'};
  const legacyBody={...body,analysisRunId:legacyRun.runId,directions:[{eligible:false,executable:false,quotes:[legacyQuote]}],provisionalReaderResearch:undefined};
  const legacySaved=await saveSoccerAnalysis({...legacyBody,analysisHash:soccerAnalysisHash(legacyBody)});
  await finishSoccerAnalysisRun(legacyRun,{analysisStatus:'COMPLETED',qaFlag:'WARN',selectionResult:'RESEARCH_SHADOW',revision:legacySaved.revision,validUntil:new Date(now+120000).toISOString()});
  const legacyAction={...recordAction,revision:legacySaved.revision,quoteKey:legacyQuote.key};
  assert.equal((await POST(request('POST',legacyAction))).status,400,'legacy direction requires explicit acknowledgement');
  const legacyResponse=await POST(request('POST',{...legacyAction,identityUnverifiedAcknowledged:true}));
  assert.equal(legacyResponse.status,200);
  const legacyRecord=(await legacyResponse.json()).record;
  assert.equal(legacyRecord.sourceIdentityStatus,'SELF_ASSERTED_UNVERIFIED');
  // Simulate a genuinely historical open row saved before the flag existed.
  await fixture.db.query("UPDATE sports_soccer_manual_records_v1 SET payload=payload-'sourceIdentityStatus' WHERE id=$1",[legacyRecord.id]);

  // A legacy row without a flag, or with a forged caller flag, is not proof.
  const trusted={...restored,id:'trusted-legacy',sourceIdentityStatus:'VERIFIED'};
  const conflicting={...restored,id:'self-asserted',teamIds:{...restored.teamIds,away:'soccer:epl:team:999'}};
  const checks=[];let mixedFetches=0,mixedContracts=0;
  const mixed=await settleOpenSoccerManualRecords({now:()=>settledAt,list:async()=>[trusted,conflicting],hydrate:async r=>r,
    load:async()=>{mixedFetches++;throw Error('unproven legacy identity must not fetch');},
    resolveContract:()=>{mixedContracts++;return null;},archive:async(r,c)=>{checks.push({id:r.id,check:c});return {check:c};}});
  assert.equal(mixedFetches,0);assert.equal(mixedContracts,0);assert.equal(mixed.resultVerified,0);
  assert.equal(checks.find(x=>x.id==='self-asserted').check.reason,'RESULT_READER_IDENTITY_UNVERIFIED');
  assert.equal(checks.find(x=>x.id==='self-asserted').check.resultEvidence,undefined);
  assert.equal(checks.find(x=>x.id==='trusted-legacy').check.reason,'RESULT_READER_IDENTITY_UNVERIFIED');
  assert.equal(checks.find(x=>x.id==='trusted-legacy').check.resultEvidence,undefined);
  const accountAction={action:'confirm-account-settlement',league:'epl',date,id:first.id,netProfit:'-123.45',rebateTreatment:'INCLUDED',confirmedAccountSettlement:true,confirmedFinalAmount:true};
  for(const invalid of [{confirmedAccountSettlement:false},{confirmedFinalAmount:false},{rebateTreatment:'EXCLUDED'},{netProfit:'1.234'},{netProfit:'NaN'},{league:'ucl'}])
    assert.notEqual((await POST(request('POST',{...accountAction,...invalid}))).status,200,'invalid confirmation or cross-league request rejected');
  const accountResponse=await POST(request('POST',accountAction));assert.equal(accountResponse.status,200);
  const account=(await accountResponse.json()).record;
  assert.equal(account.sourceIdentityStatus,'SELF_ASSERTED_UNVERIFIED');
  assert.equal(account.settlement.source,'SELF_REPORTED_USER_CONFIRMED');assert.equal(account.settlement.profit,-123.45);
  assert.equal(account.settlement.rebateTreatment,'INCLUDED');assert.equal(account.settlement.outcome,undefined);
  assert.equal(account.settlement.formalEligible,false);assert.equal(account.settlement.calibrationEligible,false);
  assert.equal(account.settlement.resultEvidence,undefined);assert.deepEqual(account.sourceQuote,first.sourceQuote);
  const stats=soccerRecordStats([account]);assert.equal(stats.selfReportedSettled,1);assert.equal(stats.winRate,null);
  assert.equal(stats.profit,-123.45);assert.equal(stats.roi,-123.45/10000);
  const replay=await POST(request('POST',accountAction));assert.equal(replay.status,200);assert.equal((await replay.json()).created,false);
  assert.equal((await POST(request('POST',{...accountAction,netProfit:'500'}))).status,409,'settlement cannot be overwritten');
  const amendment={action:'amend-account-settlement',league:'epl',date,id:first.id,revision:0,changeType:'CORRECT',netProfit:'-80.50',reason:'抄錯帳戶金額',confirmedAccountSettlement:true,confirmedFinalAmount:true};
  assert.notEqual((await POST(request('POST',{...amendment,league:'ucl'}))).status,200);
  assert.notEqual((await POST(request('POST',{...amendment,confirmedFinalAmount:false}))).status,200);
  const changed=await POST(request('POST',amendment));assert.equal(changed.status,200);
  const amended=(await changed.json()).record;assert.equal(amended.settlement.profit,-80.5);
  assert.equal(amended.accountSettlement.original.profit,-123.45);assert.equal(amended.accountSettlement.revision,1);
  assert.equal(soccerRecordStats([amended]).profit,-80.5);assert.equal(soccerRecordStats([amended]).winRate,null);
  const amendedReplay=await POST(request('POST',amendment));assert.equal(amendedReplay.status,200);assert.equal((await amendedReplay.json()).created,false);
  const oldConfirmation=await POST(request('POST',accountAction));assert.equal(oldConfirmation.status,200);
  assert.equal((await oldConfirmation.json()).record.settlement.profit,-80.5,'old initial confirmation replay cannot overwrite latest correction');
  const revoke={...amendment,revision:1,changeType:'REVOKE',reason:'帳戶注單誤認'};
  const revokeResult=await POST(request('POST',revoke));assert.equal(revokeResult.status,200);
  const revoked=(await revokeResult.json()).record;assert.equal(revoked.settlement,null);assert.equal(revoked.accountSettlement.revision,2);
  assert.equal(soccerRecordStats([revoked]).profit,null);assert.equal(soccerRecordStats([revoked]).settled,0);
  assert.equal((await (await POST(request('POST',revoke))).json()).created,false);
  assert.equal((await POST(request('POST',{...revoke,revision:2}))).status,409,'a new duplicate revocation is rejected');
  const restoreAmendment={...amendment,revision:2,netProfit:'-75.25',reason:'已重新核對帳戶'};
  const restoredAccount=(await (await POST(request('POST',restoreAmendment))).json()).record;
  assert.equal(restoredAccount.settlement.profit,-75.25);assert.equal(restoredAccount.accountSettlement.revision,3);
  assert.deepEqual(restoredAccount.accountSettlement.amendments.map(a=>a.action),['CORRECT','REVOKE','CORRECT']);
  assert.equal((await fixture.db.query("SELECT payload->>'profit' AS profit FROM sports_soccer_settlement_events_v1 WHERE record_id=$1 AND event_type='SETTLEMENT'",[first.id])).rows[0].profit,'-123.45','original event stays immutable');
  for(const sql of ["UPDATE sports_soccer_settlement_events_v1 SET payload='{}'::jsonb WHERE record_id=$1","DELETE FROM sports_soccer_settlement_events_v1 WHERE record_id=$1",
    "UPDATE sports_soccer_account_settlement_amendments_v1 SET payload='{}'::jsonb WHERE record_id=$1","DELETE FROM sports_soccer_account_settlement_amendments_v1 WHERE record_id=$1"])
    await assert.rejects(()=>fixture.db.query(sql,[first.id]),/append-only/,'history is append-only even through direct SQL');
  assert.equal((await (await POST(request('POST',{action:'cancel',league:'epl',date,id:first.id}))).json()).record.status,'CANCELLED');
  assert.equal((await POST(request('POST',accountAction))).status,409,'cancelled record cannot be settled or replayed');
  assert.equal((await POST(request('POST',{...amendment,revision:3}))).status,409,'cancelled record cannot be amended');
  assert.equal(soccerRecordStats(await listSoccerManualRecords('epl',date)).profit,null,'cancelled settled record excluded');
  await POST(request('POST',{action:'restore',league:'epl',date,id:first.id}));
  const accountReadback=(await listSoccerManualRecords('epl',date)).find(r=>r.id===first.id);
  assert.equal(accountReadback.settlement.profit,-75.25,'restoring retains the latest account amendment');
  assert.equal((await POST(request('POST',{...accountAction,netProfit:'500'}))).status,409);
  const competing={...accountAction,id:legacyRecord.id};
  const raced=await Promise.all([POST(request('POST',{...competing,netProfit:'10'})),POST(request('POST',{...competing,netProfit:'20'}))]);
  assert.deepEqual(raced.map(r=>r.status).sort(),[200,409],'concurrent conflicting declarations cannot overwrite the first');
  assert.equal((await listSoccerManualRecords('epl',date)).find(r=>r.id===legacyRecord.id).sourceIdentityStatus,undefined,'manual account confirmation does not rewrite legacy original');
  const raceAmendment={...amendment,id:legacyRecord.id,revision:0};
  const raceChanges=await Promise.all([POST(request('POST',{...raceAmendment,netProfit:'11'})),POST(request('POST',{...raceAmendment,netProfit:'22'}))]);
  assert.deepEqual(raceChanges.map(r=>r.status).sort(),[200,409],'concurrent amendments use an atomic compare-and-swap');
  const raceRead=(await listSoccerManualRecords('epl',date)).find(r=>r.id===legacyRecord.id);
  assert.equal(raceRead.accountSettlement.revision,1);assert.equal(raceRead.accountSettlement.amendments.length,1);
  assert.equal((await listUnsettledSoccerManualRecords({league:'epl',date})).length,0,'account-confirmed records never enter the automatic settlement queue');
  console.log('PASS provisional manual record: authenticated route, explicit acknowledgement, immutable price, PG record/cancel/restore, league isolation and no automatic settlement/result attribution');
} finally { await fixture.close(); }
