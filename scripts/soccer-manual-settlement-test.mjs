import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerSettlementResult,fetchSoccerSettlementResult } from '../lib/soccer/settlement-result.js';
import { settleSoccerManualRecord,soccerManualContractHash } from '../lib/soccer/manual-settlement.js';
import { soccerVerifiedSettlementContract,soccerSettlementContractComplete,soccerSettlementContractBound,SOCCER_PUBLIC_TERM_EVIDENCE } from '../lib/soccer/settlement-contract.js';
import { soccerManualRecordFromSnapshot,soccerRecordStats } from '../lib/soccer/manual-record.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const examples=JSON.parse(fs.readFileSync('research/soccer/half-time-extraction-examples.json','utf8')).examples;
const now=Date.parse('2026-10-20T00:00:00Z'),at=new Date(now).toISOString();
const sources=(example,league)=>({summary:{...example.source,fetchedAt:at},scoreboard:{...example.source,fetchedAt:at,url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${league==='epl'?'eng.1':'uefa.champions'}/scoreboard?dates=20250101`}});
function fixture(example){
  const league=example.name.startsWith('epl')?'epl':'ucl',source=sources(example,league),payload=structuredClone(example.payload);
  // Retained real scoring projections omit names and league metadata. Restore
  // synthetic identity wrappers for these unit fixtures; this is not a live
  // governing-body result or proof of independently verified provider identity.
  payload.header.league={id:league==='epl'?'700':'775',slug:league==='epl'?'eng.1':'uefa.champions'};
  const c=payload.header.competitions[0];
  c.competitors.forEach(t=>{t.team.displayName=`Fixture team ${t.team.id}`;});
  const normalized=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:c.date,status:c.status,format:payload.format,keyEvents:payload.keyEvents}]},league,source.summary);
  assert.equal(normalized.ok,true);const game=normalized.games[0];
  const quote={key:'q1',period:'FT',unit:'GOALS',kind:'TOTAL',side:'over',line:`${game.home.score+game.away.score}+50`,lineSide:null,water:.95,label:'原盤',provenance:{gameId:game.id}};
  const snapshot={league,date:game.date,gameId:game.id,revision:'r1',evidence:{game},directions:[{quotes:[quote]}]};
  const record={...soccerManualRecordFromSnapshot(snapshot,'q1'),status:'OPEN',id:'11111111-1111-4111-8111-111111111111'};
  const summary={ok:true,data:payload,source:source.summary};
  const scoreboard={ok:true,games:[{...game,source:source.scoreboard}],freshness:{stale:false}};
  return{game,record,snapshot,quote,summary,scoreboard,result:normalizeSoccerSettlementResult(record,summary,scoreboard,now)};
}
const base=fixture(examples[0]);
for(const example of examples){const f=fixture(example);assert.equal(f.result.ok,true);assert.equal(f.result.halfTime.verified,true);assert.equal(f.result.fullTime.period,'REGULATION_FT');assert.equal(f.result.halfTime.period,'REGULATION_HT');}
assert.equal(base.result.evidenceScope,'ESPN_TWO_ENDPOINT_CROSSCHECK_NOT_INDEPENDENT_OFFICIAL_CONFIRMATION');
let endpointReads=0;
const fetched=await fetchSoccerSettlementResult(base.record,{now:()=>now,fetchImpl:async url=>{
 endpointReads++;
 const payload=base.summary.data,c=payload.header.competitions[0];
 return new Response(JSON.stringify(String(url).includes('/summary?')?payload:{leagues:[payload.header.league],events:[{...payload.header,date:c.date,status:c.status,format:payload.format,keyEvents:payload.keyEvents}]}));
}});
assert.equal(fetched.ok,true);assert.equal(endpointReads,3,'summary and the two UTC dates covering the Taipei day are independently fetched');
const invalids=[
 f=>f.record.league='ucl',f=>f.record.date='2025-02-01',f=>f.record.teamIds.home=f.record.teamIds.away,
 f=>f.summary.source.fetchedAt=new Date(now-16*60000).toISOString(),f=>f.summary.source.url='https://untrusted.invalid/summary',
 f=>f.summary.data.header.competitions[0].status.type.name='STATUS_FINAL_PENALTIES',
 f=>f.summary.data.keyEvents.push({id:'extra',period:{number:3}}),
 f=>f.scoreboard.games[0].home.score++,f=>f.scoreboard.games[0].league='ucl',f=>f.scoreboard.games[0].startTime='2025-01-01T00:00:00Z',
 f=>f.scoreboard.freshness.stale=true,f=>f.scoreboard.games.push(structuredClone(f.scoreboard.games[0])),
];
for(const mutate of invalids){const f=structuredClone(base);mutate(f);assert.equal(normalizeSoccerSettlementResult(f.record,f.summary,f.scoreboard,now).ok,false);}
const noHT=structuredClone(base);noHT.summary.data.keyEvents=[];
assert.equal(normalizeSoccerSettlementResult(noHT.record,noHT.summary,noHT.scoreboard,now).halfTime,null);

// This is a synthetic explicit contract for engineering arithmetic only. It is
// not installed in the production approval registry or evidence of Tai888 terms.
const contractFor=(record,applies=true)=>({status:'SOURCE_TERMS_VERIFIED',version:'SYNTHETIC-TEST-ONLY',evidenceRef:'fixture://not-provider-terms',verifiedAt:at,
 league:record.league,period:record.period,kind:record.kind,line:record.line,type:'CREDIT_BOUNDARY',
 scope:record.period==='HT'?'REGULATION_HT_WITH_STOPPAGE':'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES',
 normalFinalOnly:true,abnormalStatusPolicy:'MANUAL_REVIEW',rebate:{rate:.01,basis:'TOTAL_PRINCIPAL',appliesTo:Object.fromEntries(['FULL_WIN','PARTIAL_WIN','PUSH','PARTIAL_LOSS','FULL_LOSS'].map(k=>[k,applies]))}});
assert.equal(soccerVerifiedSettlementContract(base.record),null);
const boundRecord={...base.record,sourceQuote:{provenance:{sourceHost:'xg1.tai888.in',sourceUrl:'https://xg1.tai888.in/newapp/',observedAt:'2025-01-01T15:00:00Z',readerObservationId:'captured-observation'}}};
const binding={provider:'TAI888',bindingEvidenceRef:'fixture://effective-terms-only',effectiveFrom:'2025-01-01T00:00:00Z',effectiveUntil:'2025-02-01T00:00:00Z'};
assert.equal(soccerSettlementContractBound(binding,boundRecord),true);
assert.equal(soccerSettlementContractBound({...binding,effectiveFrom:'2026-01-01T00:00:00Z'},boundRecord),false);
assert.equal(soccerSettlementContractBound({...binding,provider:'OTHER_PROVIDER'},boundRecord),false);
assert.equal(soccerSettlementContractBound(binding,base.record),false,'unbound historical quotes cannot inherit current source terms');
const pending=settleSoccerManualRecord(base.record,base.result,null,now);
assert.equal(pending.status,'PENDING');assert.equal(pending.reason,'SOCCER_SOURCE_CONTRACT_UNVERIFIED');assert.equal(pending.resultStatus,'RESULT_VERIFIED_CONTRACT_PENDING');assert.equal(pending.missingTerms.length,6);assert.equal(pending.profit,undefined);
const rules=JSON.parse(fs.readFileSync('research/soccer/provider-rules/tai888-20261020/findings.json','utf8'));
assert.equal(SOCCER_PUBLIC_TERM_EVIDENCE.sourceSha256,rules.reviewedSourceSha256);assert.equal(SOCCER_PUBLIC_TERM_EVIDENCE.completeContractVerified,false);
assert.equal(SOCCER_PUBLIC_TERM_EVIDENCE.publishedAt,null);assert.equal(SOCCER_PUBLIC_TERM_EVIDENCE.facts.find(f=>f.field==='HT_PERIOD').status,'PARTIAL');
assert.equal(soccerSettlementContractComplete({provenance:{status:'VERIFIED'}},base.record),false);
const c=contractFor(base.record),settled=settleSoccerManualRecord(base.record,base.result,c,now);
assert.equal(settled.status,'SETTLED');assert.equal(settled.outcome,'PARTIAL_WIN');assert.equal(settled.grossProfit,4750);assert.equal(settled.rebate,100);assert.equal(settled.profit,4850);
assert.equal(settled.calibrationEligible,false);assert.equal(settled.formalEligible,false);assert.equal(settled.executable,false);
assert.equal(settleSoccerManualRecord(base.record,base.result,contractFor(base.record,false),now).profit,4750);
const half={...base.record,period:'HT',line:`${base.result.halfTime.home+base.result.halfTime.away}平`};
assert.equal(settleSoccerManualRecord(half,base.result,contractFor(half),now).outcome,'PUSH');
assert.equal(settleSoccerManualRecord(half,{...base.result,halfTime:null},contractFor(half),now).reason,'RESULT_PERIOD_SCORE_UNVERIFIED');
assert.equal(settleSoccerManualRecord(base.record,{...base.result,league:'ucl'},c,now).status,'PENDING');
assert.equal(settleSoccerManualRecord({...base.record,status:'CANCELLED'},base.result,c,now).reason,'RECORD_CANCELLED');
assert.equal(settleSoccerManualRecord(base.record,base.result,{...c,rebate:{rate:.015,basis:'TOTAL_PRINCIPAL'}},now).status,'PENDING');

const fixtureDb=await soccerSqlFixture();process.env.DATABASE_URL='postgres://fixture.invalid/settlement';delete process.env.DATABASE_V2_URL;
const {settleOpenSoccerManualRecords,hydrateSoccerSettlementIdentity}=await import('../lib/soccer/manual-settlement-service.js');
const legacy={...base.record};delete legacy.teamIds;
const hydrated=await hydrateSoccerSettlementIdentity(legacy,async()=>base.snapshot);
assert.deepEqual(hydrated.identityEvidence.teamIds,base.record.teamIds);assert.equal(soccerManualContractHash(hydrated),soccerManualContractHash(legacy));
assert.equal((await hydrateSoccerSettlementIdentity({...legacy,water:.5},async()=>base.snapshot)).identityEvidence,undefined);

try{
 const {archiveSoccerManualRecord,archiveSoccerSettlementCheck,listSoccerManualRecords,listUnsettledSoccerManualRecords,changeSoccerManualRecordStatus}=await import('../lib/soccer/manual-record-store.js');
 const saved=await archiveSoccerManualRecord(base.snapshot,'q1');const r=saved.record;
 const p=settleSoccerManualRecord(r,base.result,null,now),s=settleSoccerManualRecord(r,base.result,c,now);
 assert.equal((await archiveSoccerSettlementCheck(r,p)).created,true);assert.equal((await archiveSoccerSettlementCheck(r,p)).created,false);
 const pendingRead=(await listSoccerManualRecords(r.league,r.date))[0];assert.equal(pendingRead.settlementCheck.reason,'SOCCER_SOURCE_CONTRACT_UNVERIFIED');assert.equal(pendingRead.settlement,undefined);
 assert.equal((await listUnsettledSoccerManualRecords({league:r.league,date:r.date})).length,1);
 await changeSoccerManualRecordStatus(r.league,r.date,r.id,'cancel');
 assert.equal((await archiveSoccerSettlementCheck(r,s)).check,null,'concurrent cancellation cannot get a new settlement');
 assert.equal((await fixtureDb.db.query('SELECT count(*)::int n FROM sports_soccer_settlement_events_v1')).rows[0].n,1,'cancellation retains prior check');
 await changeSoccerManualRecordStatus(r.league,r.date,r.id,'restore');
 const receipts=await Promise.all([archiveSoccerSettlementCheck(r,s),archiveSoccerSettlementCheck(r,s)]);
 assert.equal(receipts.filter(x=>x.created).length,1);
 assert.equal((await listUnsettledSoccerManualRecords({league:r.league,date:r.date})).length,0);
 await changeSoccerManualRecordStatus(r.league,r.date,r.id,'cancel');
 const cancelled=(await listSoccerManualRecords(r.league,r.date))[0];assert.equal(cancelled.settlement.profit,4850);assert.equal(soccerRecordStats([cancelled]).profit,null);
 await changeSoccerManualRecordStatus(r.league,r.date,r.id,'restore');
 const restored=(await listSoccerManualRecords(r.league,r.date))[0];assert.equal(restored.water,r.water);assert.equal(soccerRecordStats([restored]).profit,4850);assert.equal(soccerRecordStats([restored]).roi,.485);
 await assert.rejects(()=>archiveSoccerSettlementCheck({...r,water:.1},s),/識別/);
 assert.equal((await listSoccerManualRecords('ucl',r.date)).length,0);
}finally{await fixtureDb.close();}

let loads=0,archives=0;
const service=await settleOpenSoccerManualRecords({now:()=>now,list:async()=>[base.record,{...base.record,id:'other',period:'HT'}],hydrate:async r=>r,
 load:async()=>{loads++;return base.result;},archive:async(r,check)=>{archives++;return{check};}});
assert.equal(loads,1);assert.equal(archives,2);assert.equal(service.resultVerified,2);assert.equal(service.settled,0);assert.equal(service.pending,2);assert.equal(service.reasons.SOCCER_SOURCE_CONTRACT_UNVERIFIED,2);
const identityConflict=await settleOpenSoccerManualRecords({now:()=>now,list:async()=>[base.record,{...base.record,teamIds:{...base.record.teamIds,home:'soccer:epl:team:999'}}],hydrate:async r=>r,
 load:async()=>{throw Error('conflicting original identities must not fetch or select a winner');},archive:async(r,check)=>({check})});
assert.equal(identityConflict.resultVerified,0);assert.equal(identityConflict.reasons.ORIGINAL_RECORD_TEAM_IDENTITY_CONFLICT,2);
const failed=await settleOpenSoccerManualRecords({now:()=>now,list:async()=>[base.record],hydrate:async r=>r,load:async()=>{throw Error('offline');},archive:async(r,check)=>({check})});
assert.equal(failed.settled,0);assert.equal(failed.reasons.RESULT_SOURCE_UNAVAILABLE,1);
console.log('PASS soccer settlement pipeline: real EPL/UCL endpoint projections, league/team/time/source/FT/HT isolation, unknown source terms block profit, explicit synthetic per-state 1% arithmetic, legacy immutable identity, PostgreSQL append-only audit/idempotence/cancellation lock, active-only stats, grouped automatic checks; production contract registry remains empty');
