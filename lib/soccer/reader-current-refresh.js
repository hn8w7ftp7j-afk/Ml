import { randomUUID } from 'node:crypto';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerJournalQuery, soccerJournalTransaction, soccerBoardLock, soccerJournalHash, ensureSoccerJournal } from './journal.js';
import { soccerAnalysisHash, SOCCER_ANALYSIS_VERSION } from './analysis.js';
import { soccerMarketEconomicPriceIdentity } from './market-return-validation.js';

// Renewal is separate from the permanent economic-price capture claim. It
// creates a normal new analysis; no old observation or validity is rewritten.
export const SOCCER_READER_REFRESH_AHEAD_MS = 30000;
export const SOCCER_READER_REFRESH_SCHEMA = `CREATE TABLE IF NOT EXISTS sports_soccer_reader_current_refresh_v1 (
  league text NOT NULL CHECK(league IN ('epl','ucl')),board_date date NOT NULL,game_id text NOT NULL,
  attempt_token text NOT NULL,lease_until timestamptz NOT NULL,retry_at timestamptz NOT NULL,
  base_run_id text NOT NULL,base_request_seq bigint NOT NULL,quote_generation bigint NOT NULL,
  base_revision text NOT NULL,observation_ids jsonb NOT NULL,refresh_run_id text,
  refreshed_revision text,last_reason text,attempts integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(league,board_date,game_id))`;
let ready;
async function schema(query) {
  if(query!==soccerJournalQuery){await query(SOCCER_READER_REFRESH_SCHEMA,[]);return;}
  return ready||=(async()=>{await ensureSoccerJournal();await soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2260)'],[SOCCER_READER_REFRESH_SCHEMA],
  ]);})().catch(error=>{ready=null;throw error;});
}
const epoch=value=>value instanceof Date?value.getTime():Date.parse(value||'');
const iso=value=>new Date(value).toISOString();
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const skip=(reason,retryable=false)=>({token:null,reason,retryable});
function scope(candidate) {
  return Boolean(candidate&&soccerLeague(candidate.league)?.id===candidate.league&&validSoccerDate(candidate.date)
    &&candidate.game?.id===`soccer:${candidate.league}:${candidate.game.sourceId}`
    &&candidate.game.league===candidate.league&&candidate.game.date===candidate.date
    &&candidate.game.status==='scheduled'&&hash(candidate.identity)&&hash(candidate.modelHash)&&hash(candidate.priceHash)
    &&candidate.identityStatus==='VERIFIED_SCHEDULE_IDENTITY'&&Array.isArray(candidate.refreshQuotes));
}
function matchingGame(snapshot,candidate) {
  const game=snapshot?.evidence?.game,expected=candidate.game;
  return snapshot?.version===SOCCER_ANALYSIS_VERSION&&snapshot.league===candidate.league&&snapshot.date===candidate.date
    &&snapshot.gameId===expected.id&&game?.id===expected.id&&game.league===expected.league&&game.date===expected.date
    &&game.sourceId===expected.sourceId&&game.startTime===expected.startTime&&game.status==='scheduled'
    &&['home','away'].every(side=>game[side]?.sourceId===expected[side]?.sourceId)
    &&Boolean(game.neutralSite)===Boolean(expected.neutralSite)&&snapshot.formalScoringEnabled===false&&snapshot.executable===false;
}

// Pure deadline calculation over the immutable analysis. Only currently present
// economic quotes matter: a removed/expired period cannot create a renewal loop.
export function soccerReaderRefreshDeadline(snapshot,candidate,headUntil) {
  const scope={league:candidate.league,gameId:candidate.game.id,snapshot};
  const prices=new Set(candidate.economicPrices||[]);
  const quotes=(snapshot.directions||[]).flatMap(direction=>direction.quotes||[])
    .filter(quote=>prices.has(JSON.stringify(soccerMarketEconomicPriceIdentity(scope,quote))));
  const deadlines=[epoch(snapshot.validUntil),epoch(snapshot.observedAt)+180000,
    epoch(snapshot.evidence?.source?.fetchedAt)+180000,epoch(candidate.game.startTime)];
  if(headUntil)deadlines.push(epoch(headUntil));
  for(const quote of quotes){
    deadlines.push(epoch(quote.provenance?.observedAt)+180000);
    if(quote.predictionScore){const p=quote.predictionScore;
      deadlines.push(epoch(p.provenance?.validUntil??p.validUntil),epoch(p.provenance?.calculatedAt??p.calculatedAt)+180000);}
  }
  return quotes.length&&deadlines.every(Number.isFinite)?Math.min(...deadlines):null;
}

export async function claimSoccerReaderCurrentRefresh(candidate,{query=soccerJournalQuery}={}) {
  if(!scope(candidate))return skip('REFRESH_SCOPE_UNVERIFIED');
  await schema(query);
  const values=[candidate.league,candidate.date,candidate.game.id];
  const rows=await query(`SELECT clock_timestamp() AS checked_at,h.requested_run_id,h.requested_seq,h.quote_generation,
    h.published_revision,h.valid_until,s.quote_generation AS source_generation,a.analysis_hash,a.payload,
    EXISTS(SELECT 1 FROM sports_soccer_analysis_runs_v2 p LEFT JOIN sports_soccer_analysis_events_v2 e ON e.run_id=p.run_id
      WHERE p.league=h.league AND p.game_id=h.game_id AND p.board_date=h.board_date AND e.run_id IS NULL
        AND p.request_seq>=h.requested_seq AND (p.started_at>clock_timestamp()-interval '120 seconds'
          OR NOT EXISTS(SELECT 1 FROM sports_soccer_reader_current_refresh_v1 f WHERE f.league=p.league AND f.board_date=p.board_date
            AND f.game_id=p.game_id AND f.refresh_run_id=p.run_id AND f.lease_until<=clock_timestamp()))) AS processing
    FROM sports_soccer_analysis_heads_v2 h JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
    JOIN LATERAL (SELECT a.analysis_hash,a.payload FROM sports_soccer_analysis_runs_v2 r
      JOIN sports_soccer_analysis_events_v2 e ON e.run_id=r.run_id
      JOIN sports_soccer_analysis_v1 a ON a.league=r.league AND a.game_id=r.game_id AND a.analysis_hash=e.analysis_revision
      WHERE r.league=h.league AND r.game_id=h.game_id AND r.board_date=h.board_date
        AND e.analysis_status='COMPLETED' AND e.qa_flag<>'BLOCKED' AND e.selection_result='RESEARCH_SHADOW'
      ORDER BY r.request_seq DESC LIMIT 1) a ON true
    WHERE h.league=$1 AND h.board_date=$2::date AND h.game_id=$3`,values);
  if(rows.length!==1)return skip('REFRESH_HEAD_UNAVAILABLE');
  const row=rows[0],now=epoch(row.checked_at),snapshot=row.payload;
  if(!Number.isFinite(now)||!(epoch(candidate.game.startTime)>now))return skip('REFRESH_NOT_PREGAME');
  if(row.processing)return skip('REFRESH_ANALYSIS_PENDING',true);
  if(!matchingGame(snapshot,candidate)||soccerAnalysisHash(canonical(snapshot))!==row.analysis_hash)
    return skip('REFRESH_SNAPSHOT_UNVERIFIED');
  const deadline=soccerReaderRefreshDeadline(snapshot,candidate,row.valid_until);
  const active=row.published_revision===row.analysis_hash&&String(row.quote_generation)===String(row.source_generation);
  if(deadline===null)return skip('REFRESH_DEADLINE_UNVERIFIED');
  if(active&&deadline!==null&&deadline-now>SOCCER_READER_REFRESH_AHEAD_MS)return skip('REFRESH_NOT_DUE');

  const oldObserved=new Map((snapshot.directions||[]).flatMap(direction=>direction.quotes||[])
    .map(quote=>[JSON.stringify(soccerMarketEconomicPriceIdentity({league:candidate.league,gameId:candidate.game.id,snapshot},quote)),epoch(quote.provenance?.observedAt)]));
  const observations=new Map();let newer=false;
  for(const quote of candidate.refreshQuotes){
    const p=quote.provenance,id=p?.readerObservationId,observed=epoch(p?.observedAt);
    if(!hash(id)||p.gameId!==candidate.game.id||!Number.isFinite(observed)||observed>now||now-observed>=180000
      ||quote.fresh!==true||quote.prestart!==true)return skip('REFRESH_QUOTE_STALE');
    const price=JSON.stringify(soccerMarketEconomicPriceIdentity({league:candidate.league,gameId:candidate.game.id,
      snapshot:{inputVersions:{readerSourceObservations:candidate.sourceObservations||[]}}},quote));
    if(observed>(oldObserved.get(price)??epoch(snapshot.observedAt)))newer=true;
    observations.set(id,observed);
  }
  if(!observations.size||!newer)return skip('REFRESH_NEW_OBSERVATION_REQUIRED');
  const ids=[...observations.keys()].sort();
  const stored=await query(`SELECT o.observation_id,o.source_observed_at,o.received_at,o.persisted_at,o.payload
    FROM sports_soccer_reader_observations_v2 o WHERE o.observation_id=ANY($3::text[]) AND o.league=upper($1)
      AND o.board_date=$2::date AND EXISTS(SELECT 1 FROM sports_soccer_reader_period_heads_v2 p
        WHERE p.league=$1 AND p.board_date=$2::date AND p.observation_id=o.observation_id)`,[candidate.league,candidate.date,ids]);
  if(stored.length!==ids.length||stored.some(o=>!observations.has(o.observation_id)
    ||epoch(o.source_observed_at)!==observations.get(o.observation_id)||soccerJournalHash(o.payload)!==o.observation_id
    ||o.payload?.league!==candidate.league.toUpperCase()||o.payload?.boardDate!==candidate.date
    ||epoch(o.payload?.observedAt)!==epoch(o.source_observed_at)
    ||![o.source_observed_at,o.received_at,o.persisted_at].every(t=>Number.isFinite(epoch(t))&&epoch(t)<=now)
    ||epoch(o.source_observed_at)>epoch(o.received_at)||epoch(o.received_at)>epoch(o.persisted_at)))
    return skip('REFRESH_OBSERVATION_UNVERIFIED');

  const token=randomUUID();
  const claimed=await query(`INSERT INTO sports_soccer_reader_current_refresh_v1
    (league,board_date,game_id,attempt_token,lease_until,retry_at,base_run_id,base_request_seq,quote_generation,base_revision,observation_ids)
    SELECT h.league,h.board_date,h.game_id,$4,clock_timestamp()+interval '120 seconds',clock_timestamp(),
      h.requested_run_id,h.requested_seq,s.quote_generation,$8,$9::jsonb
    FROM sports_soccer_analysis_heads_v2 h JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
    WHERE h.league=$1 AND h.board_date=$2::date AND h.game_id=$3 AND h.requested_run_id=$5 AND h.requested_seq=$6::bigint
      AND s.quote_generation=$7::bigint
      AND NOT EXISTS(SELECT 1 FROM sports_soccer_analysis_runs_v2 p LEFT JOIN sports_soccer_analysis_events_v2 e ON e.run_id=p.run_id
        WHERE p.league=h.league AND p.game_id=h.game_id AND p.board_date=h.board_date AND e.run_id IS NULL
          AND p.request_seq>=h.requested_seq AND (p.started_at>clock_timestamp()-interval '120 seconds'
            OR NOT EXISTS(SELECT 1 FROM sports_soccer_reader_current_refresh_v1 f WHERE f.league=p.league AND f.board_date=p.board_date
              AND f.game_id=p.game_id AND f.refresh_run_id=p.run_id AND f.lease_until<=clock_timestamp())))
    ON CONFLICT(league,board_date,game_id) DO UPDATE SET attempt_token=EXCLUDED.attempt_token,lease_until=EXCLUDED.lease_until,
      retry_at=EXCLUDED.retry_at,base_run_id=EXCLUDED.base_run_id,base_request_seq=EXCLUDED.base_request_seq,
      quote_generation=EXCLUDED.quote_generation,base_revision=EXCLUDED.base_revision,observation_ids=EXCLUDED.observation_ids,
      last_reason=NULL,attempts=sports_soccer_reader_current_refresh_v1.attempts+1,updated_at=clock_timestamp()
    WHERE sports_soccer_reader_current_refresh_v1.lease_until<=clock_timestamp()
      AND sports_soccer_reader_current_refresh_v1.retry_at<=clock_timestamp() RETURNING attempt_token`,
  [...values,token,row.requested_run_id,String(row.requested_seq),String(row.source_generation),row.analysis_hash,JSON.stringify(ids)]);
  return claimed.length?{token,league:candidate.league,date:candidate.date,gameId:candidate.game.id,
    baseRunId:row.requested_run_id,baseRequestSeq:String(row.requested_seq),baseRevision:row.analysis_hash,
    quoteGeneration:String(row.source_generation),observationIds:ids,kickoffAt:candidate.game.startTime,deadline}:skip('REFRESH_LEASE_OR_HEAD_CHANGED',true);
}

// Conditional begin is the final CAS immediately before any provider/model work.
// Locking the head also fences a manual begin whose head UPDATE is in flight.
export async function beginSoccerReaderCurrentRefresh(claim,{query=soccerJournalQuery,transaction=soccerJournalTransaction}={}) {
  const runId=randomUUID();
  const sql=`WITH eligible AS MATERIALIZED (
    SELECT h.league,h.board_date,h.game_id,s.quote_generation FROM sports_soccer_analysis_heads_v2 h
    JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
    JOIN sports_soccer_reader_current_refresh_v1 f ON f.league=h.league AND f.board_date=h.board_date AND f.game_id=h.game_id
    WHERE h.league=$1 AND h.board_date=$2::date AND h.game_id=$3
      AND $6::timestamptz>clock_timestamp()
      AND f.attempt_token=$4 AND f.lease_until>clock_timestamp()
      AND h.requested_run_id=f.base_run_id AND h.requested_seq=f.base_request_seq AND s.quote_generation=f.quote_generation
      AND NOT EXISTS(SELECT 1 FROM sports_soccer_analysis_runs_v2 p LEFT JOIN sports_soccer_analysis_events_v2 e ON e.run_id=p.run_id
        WHERE p.league=h.league AND p.game_id=h.game_id AND p.board_date=h.board_date AND e.run_id IS NULL
          AND p.request_seq>=h.requested_seq AND (p.started_at>clock_timestamp()-interval '120 seconds' OR p.run_id IS DISTINCT FROM f.refresh_run_id))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(f.observation_ids) ids(id)
        WHERE NOT EXISTS(SELECT 1 FROM sports_soccer_reader_observations_v2 o
          JOIN sports_soccer_reader_period_heads_v2 p ON p.observation_id=o.observation_id AND p.league=$1 AND p.board_date=$2::date
          WHERE o.observation_id=ids.id AND o.league=upper($1) AND o.board_date=$2::date
            AND o.source_observed_at<=clock_timestamp() AND o.source_observed_at>clock_timestamp()-interval '180 seconds'
            AND o.received_at<=clock_timestamp() AND o.persisted_at<=clock_timestamp()))
    FOR UPDATE OF h,f), inserted AS (
    INSERT INTO sports_soccer_analysis_runs_v2(run_id,league,game_id,board_date,started_at,quote_generation,requirements_version)
    SELECT $5,league,game_id,board_date,clock_timestamp(),quote_generation,'2.2' FROM eligible
    RETURNING run_id,league,game_id,board_date,started_at,request_seq,quote_generation), published AS (
    UPDATE sports_soccer_analysis_heads_v2 h SET requested_run_id=r.run_id,requested_seq=r.request_seq,quote_generation=r.quote_generation,
      published_revision=NULL,valid_until=NULL,updated_at=clock_timestamp() FROM inserted r
    WHERE h.league=r.league AND h.game_id=r.game_id AND h.board_date=r.board_date
    RETURNING r.*), owned AS (
    UPDATE sports_soccer_reader_current_refresh_v1 f SET refresh_run_id=r.run_id FROM published r
    WHERE f.league=r.league AND f.game_id=r.game_id AND f.board_date=r.board_date AND f.attempt_token=$4 RETURNING r.*)
    SELECT * FROM owned`;
  const values=[claim.league,claim.date,claim.gameId,claim.token,runId,claim.kickoffAt];
  // Production shares the Reader/publication board lock. Injected PostgreSQL
  // fixtures may execute the atomic statement directly through their query.
  const rows=query===soccerJournalQuery?(await transaction([soccerBoardLock(claim.league,claim.date),[sql,values]]))[1]:await query(sql,values);
  if(rows.length!==1)throw Error('SOCCER_CURRENT_REFRESH_SUPERSEDED');
  const row=rows[0];return{runId:row.run_id,league:row.league,date:claim.date,gameId:row.game_id,
    startedAt:iso(row.started_at),requestSeq:String(row.request_seq),quoteGeneration:String(row.quote_generation)};
}

export async function finishSoccerReaderCurrentRefresh(claim,response,{query=soccerJournalQuery}={}) {
  const p=response?.payload,r=p?.currentResearch;
  const valid=response?.status===200&&p?.ok===true&&p.persisted===true&&p.journalPersisted===true
    &&p.publishedCurrent===true&&p.analysisStatus==='COMPLETED'&&p.league===claim.league&&p.date===claim.date&&p.gameId===claim.gameId
    &&p.formalScoringEnabled===false&&p.executable===false&&hash(p.revision)&&p.revision!==claim.baseRevision
    &&r?.publishedCurrent===true&&r.reason==='ACTIVE'&&r.revision===p.revision&&r.analysisRunId===p.analysisRunId
    &&String(r.quoteGeneration)===claim.quoteGeneration&&String(p.quoteGeneration)===claim.quoteGeneration;
  const rows=await query(`WITH outcome AS MATERIALIZED (SELECT f.league,f.board_date,f.game_id,
    ($5 AND EXISTS(SELECT 1 FROM sports_soccer_analysis_heads_v2 h
      JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
      WHERE h.league=f.league AND h.board_date=f.board_date AND h.game_id=f.game_id AND h.requested_run_id=f.refresh_run_id
        AND h.requested_run_id=$7 AND h.published_revision=$6 AND h.quote_generation=f.quote_generation
        AND s.quote_generation=f.quote_generation AND h.valid_until>clock_timestamp())) AS refreshed
    FROM sports_soccer_reader_current_refresh_v1 f WHERE f.league=$1 AND f.board_date=$2::date AND f.game_id=$3
      AND f.attempt_token=$4 AND f.lease_until>clock_timestamp() FOR UPDATE OF f)
    UPDATE sports_soccer_reader_current_refresh_v1 f SET lease_until=clock_timestamp(),retry_at=clock_timestamp()+interval '20 seconds',
      refreshed_revision=CASE WHEN o.refreshed THEN $6 ELSE f.refreshed_revision END,
      last_reason=CASE WHEN o.refreshed THEN 'REFRESHED' ELSE 'REFRESH_NOT_PUBLISHED' END,updated_at=clock_timestamp()
    FROM outcome o WHERE f.league=o.league AND f.board_date=o.board_date AND f.game_id=o.game_id RETURNING last_reason`,
  [claim.league,claim.date,claim.gameId,claim.token,Boolean(valid),valid?p.revision:null,valid?p.analysisRunId:null]);
  return{refreshed:rows[0]?.last_reason==='REFRESHED',reason:rows[0]?.last_reason||'REFRESH_LEASE_EXPIRED'};
}
