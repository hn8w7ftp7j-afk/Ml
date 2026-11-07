import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadNbaData, recoverableNbaScheduleSourceError } from '../lib/nba/data.js';
import { loadNbaRetainedAnalysisBoard, buildNbaAnalysisCapture } from '../lib/nba/analysis-journal.js';
import { nbaCaptureRevision } from '../lib/nba/forward-validation.js';
import { nbaResultQuoteCurrent } from '../lib/nba/analysis-job-display.js';
import { analyzeNbaOpening } from '../lib/nba/opening-model.js';
import { PGlite } from '@electric-sql/pglite';

// Synthetic source responses exercise the shipped provider/cache/normalizer.
const date='2026-10-29',now=Date.parse('2026-10-28T21:46:00Z');
const team=(id,abbreviation,name)=>({id,uid:`s:40~l:46~t:${id}`,abbreviation,displayName:name});
const event={id:'401909881',uid:'s:40~l:46~e:401909881',date:'2026-10-28T23:00:00Z',season:{year:2027,type:2},
  competitions:[{id:'401909881',date:'2026-10-28T23:00:00Z',competitors:[
    {id:'1',homeAway:'home',team:team('1','ATL','Atlanta Hawks')},
    {id:'14',homeAway:'away',team:team('14','MIA','Miami Heat')}],status:{type:{state:'pre',completed:false}}}]};
const board=events=>({leagues:[{id:'46',abbreviation:'NBA',uid:'s:40~l:46',season:{year:2027,type:2}}],events});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const range=url=>/dates=\d{8}-\d{8}/.test(url);
for(const failure of ['network',400,408,429,500,502,503,504,'timeout']) {
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push(url);
    if(range(url)){
      if(failure==='network')throw new TypeError('synthetic transport outage');
      if(failure==='timeout')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
      return new Response('',{status:failure});
    }
    return json(board([event]));
  };
  const result=await loadNbaData({view:'schedule',date},{fetchImpl,now,timeoutMs:10});
  assert.equal(result.status,'ready',String(failure));assert.equal(result.data.games.length,1);
  assert.equal(calls.length,3);assert.ok(calls.includes('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261028&limit=1000'));
  assert.ok(calls.includes('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261029&limit=1000'));
  assert.equal(result.sources[0].recoveredBy.length,2);assert.equal(result.sources.filter(source=>source.hash).length,2);
  assert.ok(result.qa.issues.some(issue=>issue.code==='SCHEDULE_RANGE_RECOVERED'));
  assert.equal(result.data.games[0].startTime,'2026-10-28T23:00:00.000Z');
}
for(const failure of [401,403]) {
  let calls=0;
  const result=await loadNbaData({view:'schedule',date},{now,fetchImpl:async()=>{calls++;return new Response('',{status:failure});}});
  assert.equal(calls,1);assert.equal(result.status,'unavailable');assert.equal(result.data.games.length,0);
}
let calls=0;
const wrongLeague=await loadNbaData({view:'schedule',date},{now,fetchImpl:async()=>{calls++;return json({leagues:[{id:'10',abbreviation:'MLB'}],events:[]});}});
assert.equal(calls,1);assert.equal(wrongLeague.qa.status,'BLOCK');
calls=0;
const nullEvent=await loadNbaData({view:'schedule',date},{now,fetchImpl:async()=>{calls++;return json(board([null]));}});
assert.equal(calls,1);assert.equal(nullEvent.qa.status,'BLOCK');assert.ok(nullEvent.qa.issues.some(issue=>issue.code==='SCHEMA_INVALID'));
calls=0;
const malformed=await loadNbaData({view:'schedule',date},{now,fetchImpl:async()=>{calls++;return new Response('not-json',{headers:{'content-type':'application/json'}});}});
assert.equal(calls,1);assert.equal(malformed.status,'unavailable');
const partial=await loadNbaData({view:'schedule',date},{now,fetchImpl:async url=>range(url)||url.includes('dates=20261029&')?new Response('',{status:503}):json(board([event]))});
assert.notEqual(partial.status,'ready');assert.equal(partial.data.games.length,0,'a missing UTC day never becomes an empty verified day');
assert.ok(partial.sources.some(source=>source.errorCode==='UPSTREAM_HTTP_503'&&!source.recoveredBy));
const conflict=structuredClone(event);conflict.date=conflict.competitions[0].date='2026-10-28T23:30:00Z';
const conflicting=await loadNbaData({view:'schedule',date},{now,fetchImpl:async url=>range(url)?new Response('',{status:503}):json(board([url.includes('dates=20261028&')?event:conflict]))});
assert.equal(conflicting.qa.status,'BLOCK');assert.equal(conflicting.data.games.length,0,'the same ID with changed kickoff is not repaired');

const game={id:'nba:espn:game:401909881',sourceId:'401909881',league:'NBA',taipeiDate:date,
  season:{year:2027,type:'regular'},seasonType:'regular',neutralSite:false,startTime:'2026-10-28T23:00:00.000Z',
  status:'scheduled',completed:false,timeConfirmed:true,
  home:{id:'nba:espn:team:1',sourceId:'1',league:'NBA',abbreviation:'ATL'},
  away:{id:'nba:espn:team:14',sourceId:'14',league:'NBA',abbreviation:'MIA'}};
const observedAt='2026-10-28T21:20:00Z';
const quotes={fullRunline:{line:'2+25',lineSide:'home',homeWater:.95,awayWater:.95}};
const model=analyzeNbaOpening(game,quotes);assert.equal(model.status,'ready');
const input={...model,league:'NBA',game,gameId:game.id,date,observedAt,generatedAt:observedAt,quoteHash:'a'.repeat(64)};
const capture=buildNbaAnalysisCapture(input);
const record={...capture,game_id:game.id,board_date:date,captured_at:'2026-10-28T21:20:01Z',captured_at_exact:'2026-10-28T21:20:01.000001Z'};
const original=structuredClone(record);
const db=async(strings,...params)=>{
  const sql=strings.join('');assert.match(sql,/SELECT DISTINCT ON/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
  assert.equal(params[0],date);return [record];
};
const error={code:'NBA_SCHEDULE_UNAVAILABLE',issueCodes:['UPSTREAM_UNAVAILABLE']};
const retained=await loadNbaRetainedAnalysisBoard(date,{db,now,scheduleError:error});
assert.equal(retained.scheduleStatus,'unavailable');assert.equal(retained.savedAnalysisStatus,'retained');
assert.equal(retained.readOnly,true);assert.equal(retained.scheduleVerified,false);assert.equal(retained.readerStatus,'unverified');
assert.equal(retained.emptyReason,'schedule_unavailable');assert.equal(retained.rows.length,1);assert.deepEqual(retained.tasks,[]);assert.equal(retained.total,0);
const row=retained.rows[0];assert.equal(row.readOnly,true);assert.equal(row.scheduleVerified,false);assert.equal(row.canAnalyze,false);
assert.equal(row.quote,null);assert.equal(row.observedAt,null);assert.equal(row.result.persistence.persisted,true);
assert.equal(row.result.quotes.fullRunline.line,'2+25');assert.equal(row.result.generatedAt,observedAt);
assert.equal(nbaResultQuoteCurrent({...row,quote:quotes,canAnalyze:true,observedAt,pageActivityAt:observedAt},Date.parse(observedAt)),false);
assert.deepEqual(record,original,'a read-only retained projection never changes its saved payload or timestamps');
const retainedWith=record=>loadNbaRetainedAnalysisBoard(date,{db:async()=>[record],now,scheduleError:error});
for(const mutate of [
  row=>{row.revision='b'.repeat(64);},
  row=>{row.board_date='2026-10-28';},
  row=>{row.game_id='nba:espn:game:401909882';},
  row=>{row.payload.game.home.league='MLB';row.revision=nbaCaptureRevision(row.payload);},
  row=>{row.payload.game.sourceId='401909882';row.revision=nbaCaptureRevision(row.payload);},
  row=>{row.payload.modelVersion='unreviewed-model';row.revision=nbaCaptureRevision(row.payload);},
  row=>{delete row.payload.forwardCaptureHashVersion;row.revision=nbaCaptureRevision(row.payload);},
  row=>{row.payload.generatedAt='2026-10-28T21:20:02Z';},
  row=>{row.captured_at=row.captured_at_exact='2026-10-28T23:00:00.000001Z';},
]){
  const bad=structuredClone(record);mutate(bad);assert.equal(await retainedWith(bad),null);
}
assert.equal(await loadNbaRetainedAnalysisBoard(date,{db:async()=>[],now}),null);
assert.equal(await loadNbaRetainedAnalysisBoard(date,{db:async()=>{throw Error('offline');},now}),null);
assert.equal(await loadNbaRetainedAnalysisBoard('2026-02-30',{db,now}),null);
assert.equal(await loadNbaRetainedAnalysisBoard(date,{db,now:Date.parse('2026-10-28T21:19:59Z')}),null);

const pg=new PGlite();
try {
  await pg.exec('CREATE TABLE nba_analysis_forward_v1 (revision text PRIMARY KEY, game_id text, board_date text, captured_at timestamptz, payload jsonb)');
  await pg.query('INSERT INTO nba_analysis_forward_v1 VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)',
    [record.revision,record.game_id,record.board_date,record.captured_at_exact,JSON.stringify(record.payload)]);
  const pgdb=async(strings,...values)=>{
    const sql=strings.reduce((out,part,index)=>out+(index?`$${index}`:'')+part,'');
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
    return (await pg.query(sql,values)).rows;
  };
  const real=await loadNbaRetainedAnalysisBoard(date,{db:pgdb,now,scheduleError:error});
  assert.equal(real.rows.length,1);assert.equal(real.rows[0].result.quotes.fullRunline.line,'2+25');
  assert.equal(real.readOnly,true);assert.deepEqual(real.tasks,[]);
  await pg.query("UPDATE nba_analysis_forward_v1 SET payload=jsonb_set(payload,'{marketAnalyses,fullRunline,quote,line}','\"99.5\"'::jsonb)");
  assert.equal(await loadNbaRetainedAnalysisBoard(date,{db:pgdb,now,scheduleError:error}),null,'actual stored JSONB corruption is rejected');
} finally {await pg.close();}

// Run the actual GET handler with transport boundaries injected, not a mirror.
const source=fs.readFileSync('app/api/nba/analysis-board/route.js','utf8').replace(/^import .*;\n/gm,'')
  .replace(/export const /g,'const ').replace(/export async function /g,'async function ');
let scheduleError=error,retainedValue=retained,retainedCalls=0,authorized=true;
const context=vm.createContext({URL,NextResponse:{json:(body,options)=>Response.json(body,options)},console:{error(){},warn(){}},
  requireApiAuth:async()=>authorized?null:Response.json({}, {status:401}),checkRateLimit:()=>({allowed:true}),validDate: value=>value===date,
  rateLimitResponse:()=>Response.json({}, {status:429}),loadNbaAnalysisBoard:async()=>{throw scheduleError;},
  restoreNbaAnalysisBoard:async()=>{throw Error('unexpected restore');},recoverableNbaScheduleSourceError,
  loadNbaRetainedAnalysisBoard:async(d,options)=>{retainedCalls++;assert.equal(d,date);assert.equal(options.scheduleError,scheduleError);return retainedValue;}});
vm.runInContext(source+';globalThis.shippedGET=GET;',context);
const get=()=>context.shippedGET(new Request('https://fixture.invalid/api/nba/analysis-board?date='+date));
assert.equal((await get()).status,200);assert.equal(retainedCalls,1);
retainedValue=null;assert.equal((await get()).status,503);
retainedValue=retained;scheduleError={...error,issueCodes:['STALE_CACHE','SOURCE_PUBLICATION_UNKNOWN']};assert.equal((await get()).status,200);
for(const issueCodes of [['GAME_IDENTITY_MISMATCH'],['UPSTREAM_UNAVAILABLE','SCHEMA_INVALID'],['SCORE_INVALID']]){
  const before=retainedCalls;scheduleError={...error,issueCodes};assert.equal((await get()).status,503);assert.equal(retainedCalls,before);
}
authorized=false;assert.equal((await get()).status,401);
console.log('PASS NBA schedule transport recovery: complete traced UTC boards, timeout/network/HTTP failures, identity/schema/score and partial-day rejection; NOT live-provider availability.');
console.log('PASS read-only saved-analysis outage view: actual PostgreSQL projection and JSONB hash validation, model/date/team/time checks, no current quotes/tasks/writes, real route auth/error branches, absent/corrupt/database failure stay explicit.');
