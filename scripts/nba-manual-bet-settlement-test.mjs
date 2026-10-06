import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadOfficialNbaEvidence } from '../lib/nba/official.js';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { settleNbaManualBet, nbaManualContractHash } from '../lib/nba/manual-bet-settlement.js';
import { nbaManualRecordStats } from '../lib/nba/manual-bet-stats.js';
import { archiveNbaManualSettlement, listNbaManualBetRecords } from '../lib/nba/manual-bet-store.js';
import { settleOpenNbaManualRecords } from '../lib/nba/manual-bet-settlement-service.js';
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-official-0022500003.json', import.meta.url)));
const game = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-onoff-401809234.json', import.meta.url))).game;
const now = Date.parse('2026-10-06T20:00:00Z');
const official = await loadOfficialNbaEvidence(game, [], { now: () => now, fetchImpl: async url => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:url.includes('/games?')?raw.schedule:{game:raw.game}}})}</script>`) });
assert.equal(official.status, 'partial'); // no player crosswalk needed for checked scores
const result = {data:{game},sources:[{provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,status:'ready',hash:'a'.repeat(64),fetchedAt:new Date(now).toISOString()}]};
const total = game.away.score + game.home.score;
const base = {alreadyPlaced:true,gameId:game.id,date:game.taipeiDate,startTime:game.startTime,away:game.away.name,home:game.home.name,marketKey:'fullTotal',side:'over',line:`${total}+35.5`,water:.94,stake:10000};
const record = {...normalizeNbaManualBetRecord(base),id:'11111111-1111-4111-8111-111111111111',status:'OPEN'};
const settled = settleNbaManualBet(record,result,official,now);
assert.equal(settled.status,'SETTLED'); assert.equal(settled.result,'PARTIAL_WIN');
assert.equal(settled.fraction,.355); assert.equal(settled.profit,3390.25); assert.equal(settled.rebate,53.25);
assert.equal(settled.contractHash,nbaManualContractHash(record)); assert.equal(settled.calibrationEligible,false);
const settle = patch => settleNbaManualBet({...record,...normalizeNbaManualBetRecord({...base,...patch})},result,official,now);
assert.equal(settle({side:'under'}).profit,-3496.75);
assert.equal(settle({line:`${total}平`}).profit,0);
assert.equal(settle({line:`${total-1}.5`}).profit,9550);
assert.equal(settle({line:`${total+1}.5`}).profit,-9850);
const halfTotal = ['away','home'].reduce((sum,side)=>sum+game[side].periodScores.slice(0,2).reduce((a,p)=>a+p.score,0),0);
assert.equal(settle({marketKey:'firstHalfTotal',line:`${halfTotal}平`}).result,'PUSH');
const margin=game.home.score-game.away.score, giver=margin>=0?'home':'away';
assert.equal(settle({marketKey:'fullRunline',side:giver,lineSide:giver,line:`${Math.abs(margin)}+25`}).profit,2387.5);
assert.equal(settle({marketKey:'fullRunline',side:giver==='home'?'away':'home',lineSide:giver,line:`${Math.abs(margin)}+25`}).profit,-2462.5);
const halfMargin=game.home.periodScores.slice(0,2).reduce((a,p)=>a+p.score,0)-game.away.periodScores.slice(0,2).reduce((a,p)=>a+p.score,0);
const halfGiver=halfMargin>=0?'home':'away';
assert.equal(settle({marketKey:'firstHalfRunline',side:halfGiver,lineSide:halfGiver,line:`${Math.abs(halfMargin)}平`}).result,'PUSH');
for (const mutate of [g=>g.id='nba:espn:game:999',g=>g.taipeiDate='2025-10-24',g=>g.startTime='2025-10-23T01:00:00Z',g=>g.status='live',g=>g.statusText='Forfeit',g=>g.away.periodScores.pop(),g=>g.home.periodScores[0].score++,g=>g.home.id=g.away.id]) {
 const bad=structuredClone(result);mutate(bad.data.game);assert.equal(settleNbaManualBet(record,bad,official,now).status,'PENDING');
}
assert.equal(settleNbaManualBet({...record,status:'CANCELLED'},result,official,now).status,'PENDING');
assert.equal(settleNbaManualBet({...record,startTime:null},result,official,now).status,'PENDING');
assert.equal(settleNbaManualBet(record,{...result,sources:result.sources.map(s=>({...s,status:'stale'}))},official,now).status,'PENDING');
assert.equal(settleNbaManualBet(record,result,{...official,status:'blocked'},now).status,'PENDING');
assert.equal(settleNbaManualBet(record,result,official,now+16*60000).status,'PENDING');
// Overtime changes full-game settlement, never the first-half quantity.
const ot=structuredClone(result);for(const side of ['away','home']){ot.data.game[side].periodScores.push({period:5,score:5});ot.data.game[side].score+=5;}
const otRaw=structuredClone(raw.game);for(const side of ['away','home']){otRaw[`${side}Team`].periods.push({period:5,score:5});otRaw[`${side}Team`].score+=5;}
const otOfficial=await loadOfficialNbaEvidence(ot.data.game,[],{now:()=>now,fetchImpl:async url=>new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:url.includes('/games?')?raw.schedule:{game:otRaw}}})}</script>`)});
assert.equal(settleNbaManualBet(record,ot,otOfficial,now).result,'WIN');
assert.equal(settleNbaManualBet({...record,marketKey:'firstHalfTotal',line:`${halfTotal}平`},ot,otOfficial,now).result,'PUSH');
let writes=0, saved;
const db=async(strings,...values)=>{const sql=strings.join('?');if(sql.includes('INSERT INTO')){if(saved)return[];writes++;saved=JSON.parse(values[1]);return[{payload:saved}];}return saved?[{payload:saved}]:[];};
const original=structuredClone(record);
assert.equal((await archiveNbaManualSettlement(record,settled,{db,prepareSchema:false})).created,true);
assert.equal((await archiveNbaManualSettlement(record,{...settled,settledAt:'changed'},{db,prepareSchema:false})).created,false);
assert.equal(writes,1);assert.deepEqual(record,original);
await assert.rejects(archiveNbaManualSettlement({...record,line:'300平'},settled,{db,prepareSchema:false}),/mismatch/);
const records=await listNbaManualBetRecords(record.date,{db:async()=>[{payload:record,settlement:saved}],prepareSchema:false});
assert.equal(records[0].settlementStatus,'SETTLED');assert.equal(records[0].evidenceStatus,'MANUAL_UNVERIFIED');
const stats=nbaManualRecordStats([...records,{...record,id:'cancelled',status:'CANCELLED',settlement:{...settled,profit:999999}},{...record,id:'pending'}]);
assert.equal(stats.settled,1);assert.equal(stats.pending,1);assert.equal(stats.profit,3390.25);assert.equal(stats.roi,.339025);
let loads=0,officialLoads=0,archives=0;
const summary=await settleOpenNbaManualRecords({now:()=>now,list:async()=>[record,{...record,id:'other',side:'under'}],load:async()=>{loads++;return result;},official:async()=>{officialLoads++;return official;},archive:async(r,s)=>{archives++;return{settlement:s};}});
assert.equal(loads,1);assert.equal(officialLoads,1);assert.equal(archives,2);assert.equal(summary.settled,2);
console.log('NBA verified manual settlement PASS: real official score crosscheck, four markets, credit decimal tails, OT/half separation, fail-closed source/identity, append-only idempotence, original contract preservation, active-only stats and one fetch per game');
