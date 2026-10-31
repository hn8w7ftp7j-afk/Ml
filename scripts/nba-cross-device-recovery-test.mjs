import assert from 'node:assert/strict';
import {analyzeNbaOpening} from '../lib/nba/opening-model.js';
import {buildNbaAnalysisCapture,restoreNbaAnalysisBoard} from '../lib/nba/analysis-journal.js';
import {mergeNbaAnalysisResults,nbaResultQuoteCurrent} from '../lib/nba/analysis-job-display.js';
const date='2026-10-29',observedAt='2026-10-28T21:20:00Z';
const team=(id,abbreviation)=>({id:`nba:espn:team:${id}`,sourceId:String(id),league:'NBA',abbreviation});
const game={id:'nba:espn:game:401909881',sourceId:'401909881',league:'NBA',taipeiDate:date,season:{year:2027,type:'regular'},seasonType:'regular',neutralSite:false,startTime:'2026-10-28T23:00:00.000Z',status:'scheduled',completed:false,timeConfirmed:true,home:team(1,'ATL'),away:team(14,'MIA')};
const quotes={fullRunline:{line:'2+25',lineSide:'home',homeWater:.95,awayWater:.95}};
const model=analyzeNbaOpening(game,quotes);
assert.equal(model.status,'ready');
const input={...model,league:'NBA',game,gameId:game.id,date,observedAt,generatedAt:observedAt,quoteHash:'a'.repeat(64)};
const capture=buildNbaAnalysisCapture(input);
const stored={...capture,captured_at:'2026-10-28T21:20:01Z'};
const board={league:'NBA',date,rows:[{game,quote:quotes,canAnalyze:false,observedAt,reason:'Reader 盤口已過期'}],tasks:[],total:0,readerStatus:'stale'};
let calls=0;const db=async(strings)=>{calls++;assert.match(strings.join(''),/SELECT DISTINCT ON/);return [stored];};
const restored=await restoreNbaAnalysisBoard(board,{db});
assert.equal(calls,1);assert.equal(restored.savedAnalysisStatus,'ready');assert.equal(restored.rows[0].jobState,'ready');
assert.equal(restored.rows[0].result.persistence.persisted,true);assert.equal(restored.rows[0].canAnalyze,false);assert.equal(restored.total,0);
assert.equal(nbaResultQuoteCurrent(restored.rows[0],Date.parse('2026-10-28T21:46:00Z')),false);
assert.equal((await restoreNbaAnalysisBoard(board,{db:async()=>[{...stored,revision:'b'.repeat(64)}]})).rows[0].result,undefined);
assert.equal((await restoreNbaAnalysisBoard({...board,date:'2026-10-28'},{db:async()=>[stored]})).rows[0].result,undefined);
assert.equal((await restoreNbaAnalysisBoard(board,{db:async()=>{throw Error('offline');}})).savedAnalysisStatus,'unavailable');

// Reconnecting to a completed old job must not erase a newer server capture,
// including markets which were absent when that old job originally ran.
const newerAt='2026-10-28T21:21:00Z';
const newerQuotes={...quotes,firstHalfRunline:{line:'1+50',lineSide:'home',homeWater:.94,awayWater:.94}};
const newerResult={...analyzeNbaOpening(game,newerQuotes),league:'NBA',game,gameId:game.id,date,
  observedAt:newerAt,generatedAt:newerAt,quoteHash:'c'.repeat(64)};
const newerRow={game,quote:newerQuotes,canAnalyze:true,observedAt:newerAt,pageActivityAt:newerAt,
  result:newerResult,resultRunId:'run-newer-capture',jobState:'ready',jobError:''};
const entry=(payload,ok=true,error='')=>({ok,payload,error,task:{game:{...game,gamePk:Number(game.sourceId)},
  nbaQuery:{id:game.sourceId,date,observedAt:payload?.observedAt||newerAt}}});
const merge=(entryValue,row=newerRow)=>mergeNbaAnalysisResults({league:'NBA',date,runId:'run-reconnected-old-job',results:[entryValue]},[row],date)[0];
assert.equal(newerResult.marketAnalyses.firstHalfRunline.status,'ready');
assert.equal(input.marketAnalyses.firstHalfRunline.status,'unavailable');
const older=merge(entry(input));
assert.equal(older.result,newerResult);assert.equal(older.resultRunId,newerRow.resultRunId);
assert.equal(older.jobState,'ready');assert.equal(nbaResultQuoteCurrent(older,Date.parse(newerAt)),true);
const missingTime=merge(entry({...input,generatedAt:undefined}));
assert.equal(missingTime.result,newerResult,'a result without an ordering timestamp cannot displace a timed accepted capture');

const failed=merge(entry(null,false,'受控來源失敗'));
assert.equal(failed.result,newerResult);assert.equal(failed.resultRunId,newerRow.resultRunId);
assert.equal(failed.jobState,'failed');assert.equal(failed.jobError,'受控來源失敗');
assert.equal(nbaResultQuoteCurrent(failed,Date.parse(newerAt)),false,'retained analysis is historical after a failed refresh, even with unchanged fresh prices');
const blockedPayload={league:'NBA',gameId:game.id,date,observedAt:newerAt,executable:false,
  status:'blocked',generatedAt:'2026-10-28T21:22:00Z',issues:[{code:'NBA_ANALYSIS_QUOTE_CHANGED',message:'盤口已更新'}]};
const blocked=merge(entry(blockedPayload,false,'盤口已更新'));
assert.equal(blocked.result,newerResult);assert.equal(blocked.jobState,'blocked');
assert.equal(nbaResultQuoteCurrent(blocked,Date.parse(newerAt)),false);
const oldFailure=merge(entry({...blockedPayload,generatedAt:observedAt},false,'較早工作失敗'));
assert.equal(oldFailure.jobState,'ready');assert.equal(oldFailure.jobError,'');

const latestResult={...newerResult,generatedAt:'2026-10-28T21:23:00Z'};
const recovered=merge(entry(latestResult),failed);
assert.equal(recovered.result,latestResult);assert.equal(recovered.jobState,'ready');assert.equal(recovered.jobError,'');
assert.equal(recovered.resultRunId,'run-reconnected-old-job');
assert.equal(nbaResultQuoteCurrent(recovered,Date.parse(newerAt)),true);

// Retention runs only after incoming checks, and never protects unvalidated,
// foreign-date or foreign-event evidence from an ordinary failed response.
const invalid=structuredClone(newerResult);invalid.marketAnalyses.fullRunline.samples=0;
assert.equal(merge(entry(null,false,'failed'),{...newerRow,result:invalid}).result,null);
assert.equal(merge(entry(null,false,'failed'),{...newerRow,result:{...newerResult,date:'2026-10-28'}}).result,null);
const foreignGame={...game,id:'nba:espn:game:401909882',sourceId:'401909882'};
const foreignEntry={...entry(null,false,'failed'),task:{game:{...foreignGame,gamePk:Number(foreignGame.sourceId)},
  nbaQuery:{id:foreignGame.sourceId,date,observedAt:newerAt}}};
const separate=mergeNbaAnalysisResults({league:'NBA',date,results:[foreignEntry]},[newerRow],date);
assert.equal(separate.find(row=>row.game.id===game.id).result,newerResult);
assert.equal(separate.find(row=>row.game.id===foreignGame.id).result,null);
assert.throws(()=>merge(entry({...input,marketAnalyses:{}})),/分析無效/,'old invalid payloads must still be rejected');
assert.throws(()=>merge({...entry(blockedPayload,false),task:{...entry(blockedPayload,false).task,
  nbaQuery:{id:game.sourceId,date,observedAt:'2026-10-28T21:24:00Z'}}}),/盤口時間不符/);
console.log('Cross-device NBA recovery PASS: original server capture, hash/date/identity guards, no stale eligibility, no writes, independent database failure');
console.log('NBA reconnect ordering PASS: newer validated markets retained, failed refresh shown separately, old captures never current after failure, fresh successful recovery and unchanged validation fences');
