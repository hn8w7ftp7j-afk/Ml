import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from '../database-url.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerReaderHash } from './reader.js';
import { ensureSoccerJournal, soccerJournalHash, soccerJournalQuery, soccerJournalTransaction, soccerBoardLock } from './journal.js';

let legacyClient;
export const soccerReaderStorageConfigured=()=>durableDatabaseConfigured();
function check(p){return ['EPL','UCL'].includes(p?.league)&&validSoccerDate(p?.boardDate)&&p.executable===false&&p.contentHash===soccerReaderHash(canonicalSoccerPayload(p));}
function envelope(row){
  if(!check(row.payload)||soccerJournalHash(row.payload)!==row.observation_id)throw Error('SOCCER_READER_SNAPSHOT_CORRUPTED');
  return {...row.payload,revision:row.observation_id,observationId:row.observation_id,
    firstFetchedAt:new Date(row.content_first_fetched_at||row.received_at).toISOString(),
    receivedAt:new Date(row.received_at).toISOString(),persistedAt:new Date(row.persisted_at).toISOString(),
    sourceObservedAt:row.payload.observedAt,timeEvidence:'SERVER_RECEIPT_RECORDED',historicalAvailabilityVerified:false};
}
export async function loadSoccerReaderSnapshot(league,date,{asOf=null}={}){
  const id=soccerLeague(league)?.id.toUpperCase();
  if(!id||!validSoccerDate(date)||(asOf!==null&&!Number.isFinite(Date.parse(asOf))))throw Error('SOCCER_READER_SCOPE_INVALID');
  await ensureSoccerJournal();
  const rows=await soccerJournalQuery(`SELECT o.observation_id,o.received_at,o.persisted_at,o.payload,
    (SELECT min(v.received_at) FROM sports_soccer_reader_observations_v2 AS v
      WHERE v.league=o.league AND v.board_date=o.board_date AND v.content_hash=o.content_hash) AS content_first_fetched_at
    FROM sports_soccer_reader_observations_v2 AS o
    WHERE o.league=$1 AND o.board_date=$2::date
      AND (($3::timestamptz IS NULL AND o.observation_id=(SELECT observation_id FROM sports_soccer_source_heads_v2
        WHERE league=lower($1) AND board_date=$2::date))
        OR ($3::timestamptz IS NOT NULL AND o.received_at<=$3::timestamptz AND o.persisted_at<=$3::timestamptz))
    ORDER BY o.source_observed_at DESC,o.received_at DESC,o.observation_id DESC LIMIT 1`,[id,date,asOf]);
  if(rows[0])return envelope(rows[0]);
  // Legacy history remains readable, but overwritten receipt times are never
  // retrospectively certified as original point-in-time availability.
  if(asOf!==null)return null;
  const sql=legacyClient||=neon(durableDatabaseUrl());
  let legacy;
  try{legacy=await sql`SELECT revision,payload FROM sports_soccer_reader_snapshots_v1 WHERE league=${id} AND board_date=${date}::date ORDER BY observed_at DESC LIMIT 1`;}
  catch(error){if(error.code==='42P01')return null;throw error;}
  if(!legacy[0])return null;if(!check(legacy[0].payload))throw Error('SOCCER_READER_SNAPSHOT_CORRUPTED');
  return {...legacy[0].payload,revision:legacy[0].revision,observationId:null,firstFetchedAt:null,
    timeEvidence:'LEGACY_ACQUISITION_UNKNOWN',historicalAvailabilityVerified:false};
}
export async function saveSoccerReaderSnapshot(payload,{receivedAt=new Date().toISOString()}={}){
  if(!check(payload)||!Number.isFinite(Date.parse(receivedAt)))throw Object.assign(Error('SOCCER_READER_SNAPSHOT_INVALID'),{status:422});
  await ensureSoccerJournal();
  const previous=await loadSoccerReaderSnapshot(payload.league,payload.boardDate);
  if(previous&&Date.parse(payload.observedAt)<Date.parse(previous.observedAt))throw Object.assign(Error('SOCCER_READER_REPLAY'),{status:409});
  const revision=soccerJournalHash(payload);
  // Distinct observations append even when prices do not change. Exact transport
  // retries deduplicate without changing the original server receipt timestamp.
  await soccerJournalTransaction([
    soccerBoardLock(payload.league,payload.boardDate),
    [`INSERT INTO sports_soccer_reader_observations_v2
      (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
      VALUES ($1,$2,$3::date,$4,$5::timestamptz,$6::timestamptz,$7::jsonb) ON CONFLICT DO NOTHING`,
      [revision,payload.league,payload.boardDate,payload.contentHash,payload.observedAt,receivedAt,JSON.stringify(payload)]],
    [`INSERT INTO sports_soccer_source_heads_v2 (league,board_date,quote_generation,content_hash,source_observed_at,observation_id)
      VALUES ($1,$2::date,1,$3,$4::timestamptz,$5)
      ON CONFLICT (league,board_date) DO UPDATE SET
        quote_generation=sports_soccer_source_heads_v2.quote_generation+
          CASE WHEN sports_soccer_source_heads_v2.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 1 ELSE 0 END,
        content_hash=EXCLUDED.content_hash,source_observed_at=EXCLUDED.source_observed_at,
        observation_id=EXCLUDED.observation_id,updated_at=clock_timestamp()
      WHERE sports_soccer_source_heads_v2.source_observed_at IS NULL
        OR sports_soccer_source_heads_v2.source_observed_at<=EXCLUDED.source_observed_at`,
      [payload.league.toLowerCase(),payload.boardDate,payload.contentHash,payload.observedAt,revision]],
    [`UPDATE sports_soccer_analysis_heads_v2 AS h SET published_revision=NULL,valid_until=NULL,updated_at=clock_timestamp()
      WHERE h.league=$1 AND h.board_date=$2::date AND h.quote_generation<>
        (SELECT quote_generation FROM sports_soccer_source_heads_v2 WHERE league=$1 AND board_date=$2::date)`,
      [payload.league.toLowerCase(),payload.boardDate]],
  ]);
  const rows=await soccerJournalQuery(`SELECT o.observation_id,o.received_at,o.persisted_at,o.payload,
    (SELECT min(v.received_at) FROM sports_soccer_reader_observations_v2 AS v
      WHERE v.league=o.league AND v.board_date=o.board_date AND v.content_hash=o.content_hash) AS content_first_fetched_at
    FROM sports_soccer_reader_observations_v2 AS o WHERE observation_id=$1`,[revision]);
  if(!rows[0]||soccerJournalHash(rows[0].payload)!==revision)throw Error('SOCCER_READER_READBACK_FAILED');
  const saved=envelope(rows[0]);
  return {persisted:true,revision,observationId:revision,observedAt:saved.observedAt,firstFetchedAt:saved.firstFetchedAt,receivedAt:saved.receivedAt,
    timeEvidence:saved.timeEvidence,historicalAvailabilityVerified:false};
}
