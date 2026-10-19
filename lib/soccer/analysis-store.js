import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured,durableDatabaseUrl } from '../database-url.js';
import { soccerAnalysisHash,SOCCER_ANALYSIS_VERSION } from './analysis.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { ensureSoccerJournal } from './journal.js';
let client;
function sql(){if(!durableDatabaseConfigured())throw Object.assign(Error('SOCCER_ANALYSIS_STORAGE_UNAVAILABLE'),{status:503});return client||=neon(durableDatabaseUrl());}
async function schema(){return ensureSoccerJournal();}
// JSONB object key order is not stable; hash a canonical serialization on both sides.
function canonical(value){return JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
const storageHash=value=>soccerAnalysisHash(canonical(value));
export async function listSoccerAnalysis(leagueValue,gameId,date){
  const league=soccerLeague(leagueValue)?.id;
  if(!league||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId)||!validSoccerDate(date))throw Error('SOCCER_ANALYSIS_SCOPE_INVALID');
  await schema();const rows=await sql()`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 WHERE league=${league} AND game_id=${gameId} AND payload->>'date'=${date} ORDER BY observed_at DESC LIMIT 5`;
  return rows.map(r=>{if(storageHash(r.payload)!==r.analysis_hash||r.payload.league!==league||r.payload.gameId!==gameId||r.payload.date!==date)throw Error('SOCCER_ANALYSIS_HISTORY_CORRUPTED');return{...r.payload,persisted:true,revision:r.analysis_hash};});
}
export async function saveSoccerAnalysis(value){
  const {analysisHash,...body}=value;
  if(value.version!==SOCCER_ANALYSIS_VERSION||!['epl','ucl'].includes(value.league)||!value.gameId.startsWith(`soccer:${value.league}:`)||value.executable!==false||analysisHash!==soccerAnalysisHash(body))throw Error('SOCCER_ANALYSIS_SNAPSHOT_INVALID');
  const hash=storageHash(value);await schema();
  await sql()`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES (${value.league},${value.gameId},${hash},${value.observedAt}::timestamptz,${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING`;
  const rows=await sql()`SELECT payload FROM sports_soccer_analysis_v1 WHERE league=${value.league} AND game_id=${value.gameId} AND analysis_hash=${hash}`;
  if(!rows[0]||storageHash(rows[0].payload)!==hash)throw Error('SOCCER_ANALYSIS_READBACK_FAILED');
  return{persisted:true,revision:hash};
}

export async function loadSoccerAnalysisRevision(league,gameId,date,revision){
  if(!['epl','ucl'].includes(league)||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId)||!validSoccerDate(date)||!/^[a-f0-9]{64}$/.test(revision||''))throw Object.assign(Error('原分析版本不正確。'),{status:400});
  await schema();
  const rows=await sql()`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 WHERE league=${league} AND game_id=${gameId} AND analysis_hash=${revision} AND payload->>'date'=${date}`;
  if(!rows[0]||storageHash(rows[0].payload)!==rows[0].analysis_hash)throw Object.assign(Error('找不到可核對的原分析版本。'),{status:400});
  return{...rows[0].payload,persisted:true,revision};
}

export async function listSoccerAnalysisBoard(league,date,through){
  if(!['epl','ucl'].includes(league)||![date,through].every(validSoccerDate)||through<date||Date.parse(through)-Date.parse(date)>14*86400000)throw Object.assign(Error('分析日期範圍不正確。'),{status:400});
  await schema();
  // A superseded request can finish with newer evidence than the active run.
  // Restore the fenced active version first; otherwise retain latest history.
  const rows=await sql()`SELECT DISTINCT ON (a.game_id,a.payload->>'date') a.analysis_hash,a.payload,
    COALESCE(h.published_revision=a.analysis_hash AND h.valid_until>clock_timestamp()
      AND h.quote_generation=COALESCE(s.quote_generation,0)
      AND r.run_id IS NOT NULL AND e.run_id IS NOT NULL
      AND a.payload->>'analysisRunId'=r.run_id
      AND a.payload->>'league'=a.league AND a.payload->>'gameId'=a.game_id,false) AS is_current
    FROM sports_soccer_analysis_v1 a
    LEFT JOIN sports_soccer_analysis_heads_v2 h ON h.league=a.league AND h.game_id=a.game_id AND h.board_date=(a.payload->>'date')::date
    LEFT JOIN sports_soccer_analysis_runs_v2 r ON r.run_id=h.requested_run_id
      AND r.league=h.league AND r.game_id=h.game_id AND r.board_date=h.board_date
      AND r.request_seq=h.requested_seq AND r.quote_generation=h.quote_generation
    LEFT JOIN sports_soccer_analysis_events_v2 e ON e.run_id=r.run_id AND e.analysis_revision=h.published_revision
      AND e.analysis_status='COMPLETED' AND e.qa_flag<>'BLOCKED' AND e.selection_result='RESEARCH_SHADOW'
    LEFT JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
    WHERE a.league=${league} AND a.payload->>'date'>=${date} AND a.payload->>'date'<=${through}
    ORDER BY a.game_id,a.payload->>'date',is_current DESC,a.observed_at DESC,a.analysis_hash DESC LIMIT 250`;
  return rows.map(r=>{
    if(storageHash(r.payload)!==r.analysis_hash||r.payload.league!==league)throw Error('SOCCER_ANALYSIS_HISTORY_CORRUPTED');
    return{...r.payload,persisted:true,revision:r.analysis_hash,publishedCurrent:r.is_current===true};
  });
}
