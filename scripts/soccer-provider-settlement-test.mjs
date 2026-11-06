import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerProviderIdentityFixture } from './helpers/soccer-provider-identity-fixture.mjs';
import { createSessionToken } from '../lib/security.js';

// Synthetic source/account/database fixture enters actual source normalizers,
// immutable stores and authenticated route. No live account or bet is touched.
const db = await soccerSqlFixture(), envKeys=['DATABASE_URL','DATABASE_V2_URL','APP_PASSWORD','SESSION_SECRET'];
const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),oldNow=Date.now,oldFetch=globalThis.fetch;
process.env.DATABASE_URL='postgres://fixture.invalid/provider-settlement';delete process.env.DATABASE_V2_URL;
process.env.APP_PASSWORD='synthetic-provider-settlement';process.env.SESSION_SECRET='synthetic-provider-settlement-secret';
const {saveSoccerAnalysis,loadSoccerAnalysisRevision}=await import('../lib/soccer/analysis-store.js');
const {soccerManualRecordFromSnapshot}=await import('../lib/soccer/manual-record.js');
const {soccerManualContractHash,settleSoccerManualRecord}=await import('../lib/soccer/manual-settlement.js');
const {verifySoccerManualSettlementIdentity,soccerManualSettlementIdentityVerified}=await import('../lib/soccer/manual-settlement-identity.js');
const {archiveSoccerSettlementCheck,listSoccerManualRecords,changeSoccerManualRecordStatus}=await import('../lib/soccer/manual-record-store.js');
const {settleOpenSoccerManualRecords,hydrateSoccerSettlementIdentity}=await import('../lib/soccer/manual-settlement-service.js');
const {soccerVerifiedSettlementContract}=await import('../lib/soccer/settlement-contract.js');
const {fetchSoccerSettlementResult}=await import('../lib/soccer/settlement-result.js');
const {GET,POST}=await import('../app/api/soccer/bet-records/route.js');
const request=async(body,method='POST')=>new Request('http://localhost/api/soccer/bet-records'+(method==='GET'?`?league=epl&date=${body.date}`:''),
  {method,headers:{cookie:`mlb_session=${await createSessionToken()}`,origin:'http://localhost','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
try {
 const f=await soccerProviderIdentityFixture(),saved=await saveSoccerAnalysis(f.snapshot);
 const snapshot=await loadSoccerAnalysisRevision('epl',f.game.id,f.date,saved.revision);
 const quote=snapshot.directions.find(d=>d.direction==='TOTAL_OVER'&&d.period==='FT').quotes[0];
 const action={action:'record',alreadyPlaced:true,league:'epl',date:f.date,gameId:f.game.id,revision:saved.revision,quoteKey:quote.key};
 const created=await POST(await request({...action,sourceIdentityStatus:'FORGED',stake:1,water:99}));
 assert.equal(created.status,200);const record=(await created.json()).record;
 assert.equal(record.sourceIdentityStatus,'PROVIDER_SCOPED_UNIQUE_MATCH');
 assert.equal(record.sourceIdentityEvidence.contentHash,snapshot.readerIdentityEvidence.contentHash);
 assert.equal(record.stake,10000);assert.equal(record.water,quote.water);
 assert.equal(soccerManualSettlementIdentityVerified(record),false,'serialized markers cannot authorize archive');
 const loaded=await hydrateSoccerSettlementIdentity(record);
 assert.equal(soccerManualSettlementIdentityVerified(loaded),true,'actual original immutable revision admits the exact record');
 assert.equal(soccerManualSettlementIdentityVerified(structuredClone(loaded)),false,'serialized copies lose process admission');
 assert.equal(soccerManualContractHash({...loaded,sourceIdentityEvidence:{contentHash:loaded.sourceIdentityEvidence.contentHash,version:loaded.sourceIdentityEvidence.version}}),soccerManualContractHash(loaded),'JSONB key order preserves optional identity contract hash');
 const mutated=await hydrateSoccerSettlementIdentity(record);mutated.water=.01;
 assert.equal(soccerManualSettlementIdentityVerified(mutated),false,'post-verification mutation invalidates proof');
 for(const change of [r=>r.sourceIdentityEvidence.contentHash='c'.repeat(64),r=>r.teamIds.home=r.teamIds.away,
  r=>r.sourceQuote.rawRows=['changed'],r=>r.quoteKey='f'.repeat(64),r=>r.analysisRevision='d'.repeat(64),r=>r.water=4]){
  const value=structuredClone(record);change(value);
  assert.equal(soccerManualSettlementIdentityVerified(await hydrateSoccerSettlementIdentity(value)),false);
 }
 const legacy={...record};delete legacy.sourceIdentityStatus;delete legacy.sourceIdentityEvidence;
 const self={...record,sourceIdentityStatus:'SELF_ASSERTED_UNVERIFIED'};delete self.sourceIdentityEvidence;
 for(const value of [legacy,self])assert.equal(soccerManualSettlementIdentityVerified(await hydrateSoccerSettlementIdentity(value)),false,'old/self-asserted records are never retroactively promoted');
 const erased=structuredClone(snapshot);delete erased.readerIdentityEvidence;
 assert.equal(soccerManualSettlementIdentityVerified(await verifySoccerManualSettlementIdentity(record,async()=>erased)),false);
 assert.equal(soccerManualSettlementIdentityVerified(await verifySoccerManualSettlementIdentity(record,async()=>{throw Error('temporary DB unavailable');})),false);
 const corrupted=structuredClone(snapshot);corrupted.directions.find(d=>d.quotes.length).quotes[0].water=99;
 assert.equal(soccerManualSettlementIdentityVerified(await verifySoccerManualSettlementIdentity(record,async()=>corrupted)),false);

 const end=Date.parse(f.start)+3*3600000,final=structuredClone(f.payload),comp=final.header.competitions[0];
 comp.status={type:{state:'post',completed:true,name:'STATUS_FULL_TIME'}};
 for(const side of ['home','away']){const team=comp.competitors.find(t=>t.homeAway===side);team.score=side==='home'?'2':'1';team.linescores=[{period:1,value:side==='home'?1:0},{period:2,value:1}];}
 final.keyEvents=[];
 let reads=0;const fetchImpl=async url=>{reads++;return Response.json(String(url).includes('/summary?')?final:{leagues:[final.header.league],events:[{...final.header,date:comp.date,status:comp.status,format:final.format,keyEvents:final.keyEvents}]});};
 const result=await fetchSoccerSettlementResult(loaded,{now:()=>end,fetchImpl});assert.equal(result.ok,true,JSON.stringify(result));
 const contract=soccerVerifiedSettlementContract(loaded);assert.ok(contract,'actual already-confirmed account rules bind the original prospective quote');
 const check=settleSoccerManualRecord(loaded,result,contract,end);assert.equal(check.status,'SETTLED');
 assert.equal(check.rebate,100);assert.equal(check.profit,9100);assert.equal(check.formalEligible,false);
 const fake={...check,contractHash:soccerManualContractHash(record)};
 await assert.rejects(()=>archiveSoccerSettlementCheck(record,fake),/來源身分尚未核對/,'marker-only internal object cannot settle');
 await assert.rejects(()=>archiveSoccerSettlementCheck(structuredClone(loaded),fake),/來源身分尚未核對/,'copy cannot carry private proof');
 await changeSoccerManualRecordStatus('epl',f.date,record.id,'cancel');
 assert.equal((await archiveSoccerSettlementCheck(loaded,check,{now:end})).created,false,'database cancellation fence survives a qualified stale object');
 await changeSoccerManualRecordStatus('epl',f.date,record.id,'restore');
 let fetches=0;const mixedChecks=[];
 const mixed=await settleOpenSoccerManualRecords({now:()=>end,list:async()=>[legacy,self],hydrate:async r=>r,load:async()=>{fetches++;throw Error('must not fetch');},archive:async(r,c)=>{mixedChecks.push(c);return {check:c};}});
 assert.equal(fetches,0);assert.equal(mixed.settled,0);assert.ok(mixedChecks.every(c=>c.reason==='RESULT_READER_IDENTITY_UNVERIFIED'));

 // Actual authenticated action -> real default hydrator -> immutable DB ->
 // provider result normalizers -> locked record insert -> readback.
 Date.now=()=>end;globalThis.fetch=fetchImpl;
 const api=await POST(await request({action:'check-settlement',league:'epl',date:f.date}));assert.equal(api.status,200);
 const body=await api.json();assert.equal(body.summary.settled,1,JSON.stringify(body));assert.equal(body.summary.resultVerified,1);
 const rows=(await (await GET(await request({date:f.date},'GET'))).json()).records;
 assert.equal(rows.length,1);assert.equal(rows[0].settlement.profit,9100);assert.equal(rows[0].settlement.source,undefined);
 assert.equal(rows[0].sourceIdentityStatus,'PROVIDER_SCOPED_UNIQUE_MATCH');assert.equal(rows[0].settlement.calibrationEligible,false);
 assert.equal((await POST(await request({action:'check-settlement',league:'epl',date:f.date}))).status,200);
 assert.equal((await db.db.query("SELECT count(*)::int n FROM sports_soccer_settlement_events_v1 WHERE event_type='SETTLEMENT'")).rows[0].n,1,'repeated checks cannot create two settlements');
 await assert.rejects(()=>db.db.query("UPDATE sports_soccer_settlement_events_v1 SET payload=payload"),/append-only/);
 assert.ok(reads>=3);
 console.log('PASS provider-scoped soccer settlement: actual source normalizers and authenticated immutable PG record/cancel/restore/check/readback; marker forgery, copied/mutated proofs and legacy/self-asserted records rejected; real result/account gates, 1% rebate and no formal promotion');
} finally {
 Date.now=oldNow;globalThis.fetch=oldFetch;
 for(const key of envKeys){if(oldEnv[key]===undefined)delete process.env[key];else process.env[key]=oldEnv[key];}
 await db.close();
}
