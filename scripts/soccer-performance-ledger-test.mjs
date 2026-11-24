import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { soccerManualPerformanceBet } from '../lib/soccer/performance-ledger.js';
import { soccerManualContractHash, settleSoccerManualRecord } from '../lib/soccer/manual-settlement.js';
import { soccerVerifiedSettlementContract } from '../lib/soccer/settlement-contract.js';
import { listSoccerPerformanceLedgerPage, normalizeSoccerPerformanceReadOptions } from '../lib/soccer/manual-record-store.js';
import { filterBetLedgerByPeriod, summarizeBetLedger, matchesBetStatMarket } from '../lib/bet-stats.js';

const at='2026-11-22T16:10:00.000Z', settledAt='2026-11-23T05:00:00.000Z';
const id=n=>`22222222-2222-4222-8222-${n.toString(16).padStart(12,'0')}`;
function record(patch={}) {
  const r={id:id(1),league:'epl',date:'2026-11-23',gameId:'soccer:epl:123',startTime:'2026-11-23T02:00:00Z',
    home:'Arsenal',away:'Liverpool',period:'FT',kind:'TOTAL',side:'over',line:'3+20',lineSide:null,
    stake:10000,water:.95,quoteKey:'a'.repeat(64),analysisRevision:'b'.repeat(64),status:'OPEN',recordedAt:at,...patch};
  r.gameId=`soccer:${r.league}:123`;r.teamIds={home:`soccer:${r.league}:team:359`,away:`soccer:${r.league}:team:364`};
  r.sourceQuote={key:r.quoteKey,sourceQuoteKey:r.quoteKey,period:r.period,kind:r.kind,side:r.side,line:r.line,lineSide:r.lineSide,water:r.water,
    rawRows:[`${r.line} 0.95`],provenance:{gameId:r.gameId,observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,
      readerRevision:'b'.repeat(64),readerObservationId:'c'.repeat(64),sourceHost:'www.tai888.in',sourceUrl:'https://www.tai888.in/newapp/'}};
  return r;
}
function settle(r,scores={home:2,away:1}) {
  const result={ok:true,verified:true,status:'NORMAL_FINAL_CROSSCHECKED',gameId:r.gameId,league:r.league,date:r.date,
    startTime:r.startTime,teamIds:r.teamIds,resultHash:'d'.repeat(64),
    halfTime:{...scores,period:'REGULATION_HT'},fullTime:{...scores,period:'REGULATION_FT'}};
  const settlement=settleSoccerManualRecord(r,result,soccerVerifiedSettlementContract(r),Date.parse(settledAt));
  assert.equal(settlement.status,'SETTLED');
  return {...r,settlement,settlementStatus:'SETTLED'};
}
const native=settle(record()),before=structuredClone(native),bet=soccerManualPerformanceBet(native);
assert.deepEqual(native,before,'read adapter preserves original contract and settlement');
assert.equal(bet.status,'SETTLED');assert.equal(bet.league,'EPL');assert.equal(bet.nativeLeague,'epl');
assert.equal(bet.id,`soccer-manual:epl:${id(1)}`);assert.equal(bet.nativeRecordId,id(1));
assert.equal(bet.ledgerSource,'SOCCER_MANUAL_V1');assert.equal(bet.nativeStatus,'OPEN');
assert.equal(bet.market,'全場大小');assert.equal(bet.slotId,'FULL_TOTAL_OVER');
assert.equal(bet.settlement.netProfit,1920);assert.equal(bet.settlement.rebate,20);assert.equal(bet.settlement.winFraction,.2);
assert.equal(bet.settlement.outcome,'HALF_WIN');assert.equal(matchesBetStatMarket(bet,'FULL_TOTAL_OVER'),true);
assert.equal(bet.formalEligible,false);assert.equal(bet.calibrationEligible,false);assert.equal(bet.score,null);
for(const league of ['epl','ucl'])for(const period of ['FT','HT'])for(const kind of ['HANDICAP','TOTAL']) {
  const r=settle(record({league,period,kind,line:kind==='TOTAL'?'3-20':'1-20',side:kind==='TOTAL'?'over':'home',lineSide:kind==='TOTAL'?null:'home'}));
  const b=soccerManualPerformanceBet(r);
  assert.equal(b.status,'SETTLED');assert.equal(b.league,league.toUpperCase());
  assert.equal(b.market,`${period==='FT'?'全場':'上半'}${kind==='TOTAL'?'大小':'讓分'}`);
  assert.equal(b.settlement.outcome,'HALF_LOSS');assert.equal(b.settlement.lossFraction,.2);assert.equal(b.settlement.netProfit,-1980);
}
for(const [patch,scores,outcome] of [
  [{line:'2.5'},{home:2,away:1},'WIN'],[{line:'3.5'},{home:2,away:1},'LOSS'],
  [{line:'3平'},{home:2,away:1},'PUSH'],
  [{kind:'HANDICAP',side:'away',lineSide:'home',line:'0平'},{home:0,away:0},'PUSH'],
]) assert.equal(soccerManualPerformanceBet(settle(record(patch),scores)).settlement.outcome,outcome);
assert.equal(soccerManualPerformanceBet(record({kind:'HANDICAP',side:'away',lineSide:'home',line:'0平'})).statRunlineRole,'PICKEM');
assert.equal(soccerManualPerformanceBet(record({kind:'HANDICAP',side:'away',lineSide:'home',line:'1.5'})).statRunlineRole,'RECEIVING');
for(const key of ['profit','rebate','winFraction','lossFraction','grossProfit']) {
  const corrupt={...native,settlement:{...native.settlement,[key]:native.settlement[key]+.01}};
  assert.equal(soccerManualPerformanceBet(corrupt).status,'MANUAL_REVIEW');
  assert.equal(soccerManualPerformanceBet(corrupt).settlement,null);
}
for(const change of [r=>r.line='4.5',r=>r.settlement.scores.period='REGULATION_HT',
  r=>r.settlement.resultEvidence.league='ucl',r=>r.settlement.resultEvidence.teamIds.home='soccer:epl:team:999',
  r=>r.settlement.contractHash='bad']) {
  const corrupt=structuredClone(native);change(corrupt);assert.equal(soccerManualPerformanceBet(corrupt).status,'MANUAL_REVIEW');
}
for(const patch of [{gameId:'soccer:ucl:123'},{league:'nba'},{date:'2026-02-30'},{recordedAt:'bad'},
  {teamIds:{home:'soccer:ucl:team:359',away:'soccer:ucl:team:364'}},{side:'home'}])
  assert.equal(soccerManualPerformanceBet({...native,...patch}),null);
const cancelled=soccerManualPerformanceBet({...native,status:'CANCELLED'});
assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.settlement,null);
const selfRecord=record({id:id(2),league:'ucl',period:'HT'});
const account={status:'SETTLED',source:'SELF_REPORTED_USER_CONFIRMED',version:'SOCCER-ACCOUNT-SELF-REPORT-v1',
  contractHash:soccerManualContractHash(selfRecord),stake:10000,profit:157.25,rebateTreatment:'INCLUDED',settledAt};
const self=soccerManualPerformanceBet({...selfRecord,settlement:account});
assert.equal(self.status,'SETTLED');assert.equal(self.settlement.netProfit,157.25);
for(const key of ['outcome','winFraction','lossFraction','rebate','grossWin','grossLoss'])assert.equal(self.settlement[key],null);
const summary=summarizeBetLedger([bet,self,cancelled]).overall;
assert.equal(summary.settled,2);assert.equal(summary.netPnl,2077.25);assert.equal(summary.winRate,1);
assert.equal(summary.totalStake,20000);assert.equal(summary.roi,2077.25/20000);
assert.equal(filterBetLedgerByPeriod([bet],'TODAY',Date.parse('2026-11-23T06:00:00Z')).length,1,'Taipei record date governs statistics');

for(const options of [{},{league:'NBA'},{league:'EPL'},{league:'epl',limit:0},{league:'epl',limit:501},
  {league:'epl',date:'2026-02-30'},{league:'epl',cursor:'invalid'}])assert.throws(()=>normalizeSoccerPerformanceReadOptions(options),e=>e.status===400);
const pg=new PGlite();await pg.waitReady;
const db={query:async(sql,params)=>(await pg.query(sql,params)).rows};
try {
  await pg.exec(`CREATE TABLE sports_soccer_manual_records_v1(id text PRIMARY KEY,league text,board_date date,payload jsonb,recorded_at timestamptz);
    CREATE TABLE sports_soccer_settlement_events_v1(event_id text,record_id text,event_type text,payload jsonb,created_at timestamptz);
    CREATE TABLE sports_soccer_account_settlement_amendments_v1(record_id text,revision integer,payload jsonb);`);
  const records=Array.from({length:1007},(_,n)=>record({id:id(n+10)}));
  records.push(selfRecord);
  await db.query(`INSERT INTO sports_soccer_manual_records_v1 SELECT v->>'id',v->>'league',(v->>'date')::date,v,'2026-11-22T16:10:00.123456Z'::timestamptz FROM jsonb_array_elements($1::jsonb) v`,[JSON.stringify(records)]);
  let cursor=null,all=[],pages=0;
  do {
    const page=await listSoccerPerformanceLedgerPage({league:'epl',cursor,limit:500},{db});
    assert.equal(page.league,'epl');assert.equal(page.pagination.totalRecords,1007);assert.equal(page.pagination.invalidRecordsOnPage,0);
    all.push(...page.bets);cursor=page.pagination.nextCursor;pages++;
    if(cursor){assert.equal(normalizeSoccerPerformanceReadOptions({league:'epl',cursor}).cursor.recordedAt,'2026-11-22T16:10:00.123456Z');
      assert.throws(()=>normalizeSoccerPerformanceReadOptions({league:'ucl',cursor}),/分頁識別/);
      assert.throws(()=>normalizeSoccerPerformanceReadOptions({league:'epl',date:'2026-11-23',cursor}),/分頁識別/);}
  }while(cursor);
  assert.equal(pages,3);assert.equal(all.length,1007);assert.equal(new Set(all.map(b=>b.id)).size,1007);
  const ucl=await listSoccerPerformanceLedgerPage({league:'ucl'},{db});assert.equal(ucl.bets.length,1);assert.equal(ucl.bets[0].league,'UCL');
  const persistedRecord=(await db.query('SELECT payload FROM sports_soccer_manual_records_v1 WHERE id=$1',[selfRecord.id]))[0].payload;
  const persistedAccount={...account,contractHash:soccerManualContractHash(persistedRecord)};
  await db.query(`INSERT INTO sports_soccer_settlement_events_v1 VALUES('account',$1,'SETTLEMENT',$2::jsonb,$3::timestamptz)`,[selfRecord.id,JSON.stringify(persistedAccount),settledAt]);
  assert.equal((await listSoccerPerformanceLedgerPage({league:'ucl'},{db})).bets[0].settlement.netProfit,157.25);
  await db.query(`INSERT INTO sports_soccer_account_settlement_amendments_v1 VALUES($1,1,$2::jsonb)`,[selfRecord.id,JSON.stringify({revision:1,action:'CORRECT',profit:-9980,recordedAt:settledAt})]);
  assert.equal((await listSoccerPerformanceLedgerPage({league:'ucl'},{db})).bets[0].settlement.netProfit,-9980);
  await db.query(`INSERT INTO sports_soccer_account_settlement_amendments_v1 VALUES($1,2,$2::jsonb)`,[selfRecord.id,JSON.stringify({revision:2,action:'REVOKE',recordedAt:settledAt})]);
  assert.equal((await listSoccerPerformanceLedgerPage({league:'ucl'},{db})).bets[0].status,'OPEN');
  await db.query(`UPDATE sports_soccer_manual_records_v1 SET payload=jsonb_set(payload,'{league}','"epl"') WHERE id=$1`,[selfRecord.id]);
  const invalid=await listSoccerPerformanceLedgerPage({league:'ucl'},{db});assert.equal(invalid.pagination.invalidRecordsOnPage,1);assert.equal(invalid.bets.length,0);
  const empty=await listSoccerPerformanceLedgerPage({league:'epl',date:'2026-11-24'},{db});assert.equal(empty.pagination.totalRecords,0);assert.deepEqual(empty.bets,[]);
  await assert.rejects(listSoccerPerformanceLedgerPage({league:'epl'},{db:{query:async()=>[]}}),/總筆數/);
}finally{await pg.close();}
console.log('Soccer performance ledger PASS: EPL/UCL and FT/HT isolation, unchanged one-percent native settlement, exact fractional weights, account amounts without invented outcomes, correction/revocation overlays, PostgreSQL 1007-record keyset pagination, malformed identity quarantine and explicit completeness');
