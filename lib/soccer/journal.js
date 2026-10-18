import { randomUUID, createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from '../database-url.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { SOCCER_JOURNAL_SCHEMA } from './journal-schema.js';

let client, ready;
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const soccerJournalHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function soccerJournalConfigured(){return durableDatabaseConfigured();}
function sql(){
  if(!soccerJournalConfigured())throw Object.assign(Error('SOCCER_JOURNAL_UNAVAILABLE'),{status:503});
  return client||=neon(durableDatabaseUrl());
}
export async function soccerJournalQuery(query,values=[]){return sql().query(query,values);}
export async function soccerJournalTransaction(queries){return sql().transaction(queries.map(([query,values=[]])=>sql().query(query,values)),{isolationLevel:'ReadCommitted'});}
export function soccerBoardLock(league,date){return ['SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`soccer:2.2:${league.toLowerCase()}:${date}`]];}
export async function ensureSoccerJournal(){
  return ready||=(async()=>{
    // Serialize schema initialization across workers in a transaction-scoped lock.
    await soccerJournalTransaction([
      ['SELECT pg_advisory_xact_lock(221019,2202)'],
      ...SOCCER_JOURNAL_SCHEMA.map(statement=>[statement]),
    ]);
  })().catch(error=>{ready=null;throw error;});
}
function scope(league,date,gameId){
  if(!soccerLeague(league)||league!==league.toLowerCase()||!validSoccerDate(date)||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId||''))throw Error('SOCCER_JOURNAL_SCOPE_INVALID');
}
export async function recordSoccerCohort(games,receivedAt=new Date().toISOString()){
  await ensureSoccerJournal();
  const records=games.map(game=>{
    scope(game.league,game.date,game.id);
    const payload={game,receivedAt,requirementsVersion:'2.2'},id=soccerJournalHash(payload);
    return {snapshot_id:id,league:game.league,game_id:game.id,board_date:game.date,received_at:receivedAt,payload};
  });
  if(records.length)await soccerJournalQuery(`INSERT INTO sports_soccer_cohort_v2
    (snapshot_id,league,game_id,board_date,received_at,payload)
    SELECT snapshot_id,league,game_id,board_date,received_at,payload FROM jsonb_to_recordset($1::jsonb)
      AS r(snapshot_id text,league text,game_id text,board_date date,received_at timestamptz,payload jsonb)
    ON CONFLICT DO NOTHING`,[JSON.stringify(records)]);
  return {persisted:true,gameCount:games.length};
}
export async function beginSoccerAnalysisRun({league,date,gameId,now=Date.now()}){
  scope(league,date,gameId);if(!Number.isFinite(now))throw Error('SOCCER_RUN_TIME_INVALID');
  await ensureSoccerJournal();
  const runId=randomUUID(),startedAt=new Date(now).toISOString();
  const rows=await soccerJournalQuery(`INSERT INTO sports_soccer_analysis_runs_v2
    (run_id,league,game_id,board_date,started_at,quote_generation,requirements_version)
    VALUES ($1,$2,$3,$4::date,$5::timestamptz,
      COALESCE((SELECT quote_generation FROM sports_soccer_source_heads_v2 WHERE league=$2 AND board_date=$4::date),0),'2.2')
    RETURNING request_seq,quote_generation`,[runId,league,gameId,date,startedAt]);
  const row=rows[0];if(!row)throw Error('SOCCER_RUN_NOT_RECORDED');
  const run={runId,league,date,gameId,startedAt,requestSeq:String(row.request_seq),quoteGeneration:String(row.quote_generation)};
  // An earlier INSERT finishing late cannot replace a later requested run.
  await soccerJournalQuery(`INSERT INTO sports_soccer_analysis_heads_v2
    (league,game_id,board_date,requested_run_id,requested_seq,quote_generation)
    VALUES ($1,$2,$3::date,$4,$5::bigint,$6::bigint)
    ON CONFLICT (league,game_id,board_date) DO UPDATE SET
      requested_run_id=EXCLUDED.requested_run_id,requested_seq=EXCLUDED.requested_seq,
      quote_generation=EXCLUDED.quote_generation,published_revision=NULL,valid_until=NULL,updated_at=clock_timestamp()
    WHERE sports_soccer_analysis_heads_v2.requested_seq<EXCLUDED.requested_seq`,
    [league,gameId,date,runId,run.requestSeq,run.quoteGeneration]);
  return run;
}
export async function finishSoccerAnalysisRun(run,{analysisStatus,qaFlag='BLOCKED',selectionResult=null,revision=null,reasons=[],validUntil=null}){
  scope(run.league,run.date,run.gameId);
  if(!['COMPLETED','FAILED','INSUFFICIENT_DATA'].includes(analysisStatus)||!['PASS','WARN','BLOCKED'].includes(qaFlag)||
    (selectionResult!==null&&selectionResult!=='RESEARCH_SHADOW')||
    (selectionResult!==null&&(analysisStatus!=='COMPLETED'||qaFlag==='BLOCKED'))||
    (analysisStatus==='COMPLETED'&&qaFlag==='BLOCKED'))throw Error('SOCCER_RUN_STATE_INVALID');
  const finishedAt=new Date().toISOString();
  const insert=[`INSERT INTO sports_soccer_analysis_events_v2
    (run_id,finished_at,analysis_status,qa_flag,selection_result,analysis_revision,reasons)
    VALUES ($1,$2::timestamptz,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [run.runId,finishedAt,analysisStatus,qaFlag,selectionResult,revision,JSON.stringify(reasons)]];
  const canPublish=Boolean(revision&&analysisStatus==='COMPLETED'&&Number.isFinite(Date.parse(validUntil||'')));
  // Quote adoption and result publication share this scope lock. A scalar
  // generation check alone would still allow an MVCC cross-row write race.
  const queries=[soccerBoardLock(run.league,run.date),insert];
  if(canPublish)queries.push([`UPDATE sports_soccer_analysis_heads_v2 AS h
    SET published_revision=$1,valid_until=$2::timestamptz,updated_at=clock_timestamp()
    WHERE h.league=$3 AND h.game_id=$4 AND h.board_date=$5::date
      AND h.requested_run_id=$6 AND h.requested_seq=$7::bigint AND h.quote_generation=$8::bigint
      AND COALESCE((SELECT quote_generation FROM sports_soccer_source_heads_v2
        WHERE league=h.league AND board_date=h.board_date),0)=$8::bigint
      AND $2::timestamptz>clock_timestamp()
      AND EXISTS (SELECT 1 FROM sports_soccer_analysis_events_v2 AS e
        WHERE e.run_id=$6 AND e.analysis_revision=$1 AND e.analysis_status='COMPLETED' AND e.qa_flag<>'BLOCKED')
    RETURNING requested_run_id`,[revision,validUntil,run.league,run.gameId,run.date,run.runId,run.requestSeq,run.quoteGeneration]]);
  // Terminal event and conditional publication commit together. A failure cannot
  // leave a published head pointing at a noncommitted result event.
  const results=await soccerJournalTransaction(queries);
  const stored=await soccerJournalQuery(`SELECT analysis_status,qa_flag,selection_result,analysis_revision
    FROM sports_soccer_analysis_events_v2 WHERE run_id=$1`,[run.runId]);
  if(!stored[0]||stored[0].analysis_status!==analysisStatus||stored[0].qa_flag!==qaFlag||
    stored[0].selection_result!==selectionResult||stored[0].analysis_revision!==revision)throw Error('SOCCER_RUN_TERMINAL_CONFLICT');
  return {publishedCurrent:canPublish&&results[2].length===1};
}
export async function listSoccerRunHistory(league,date,gameId){
  scope(league,date,gameId);await ensureSoccerJournal();
  const rows=await soccerJournalQuery(`SELECT r.run_id,r.started_at,r.request_seq,r.quote_generation,
    e.finished_at,e.analysis_status,e.qa_flag,e.selection_result,e.analysis_revision,e.reasons
    FROM sports_soccer_analysis_runs_v2 AS r LEFT JOIN sports_soccer_analysis_events_v2 AS e ON e.run_id=r.run_id
    WHERE r.league=$1 AND r.game_id=$2 AND r.board_date=$3::date ORDER BY r.request_seq DESC LIMIT 50`,[league,gameId,date]);
  return rows.map(row=>({analysisRunId:row.run_id,startedAt:row.started_at,finishedAt:row.finished_at||null,
    analysisStatus:row.analysis_status||'PROCESSING',qaFlag:row.qa_flag||null,selectionResult:row.selection_result||null,
    revision:row.analysis_revision||null,reasons:row.reasons||[],requestSeq:String(row.request_seq),quoteGeneration:String(row.quote_generation)}));
}
