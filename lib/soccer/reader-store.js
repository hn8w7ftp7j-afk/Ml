import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from '../database-url.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerReaderHash } from './reader.js';
let client,ready;
export const soccerReaderStorageConfigured=()=>durableDatabaseConfigured();
function sql(){if(!soccerReaderStorageConfigured())throw Object.assign(Error('SOCCER_READER_DATABASE_UNAVAILABLE'),{status:503});return client||=neon(durableDatabaseUrl());}
async function schema(){return ready||=(async()=>{await sql()`CREATE TABLE IF NOT EXISTS sports_soccer_reader_snapshots_v1 (
  league TEXT NOT NULL CHECK(league IN ('EPL','UCL')), board_date DATE NOT NULL,
  revision TEXT NOT NULL, content_hash TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL, PRIMARY KEY(league,board_date,revision))`;})().catch(e=>{ready=null;throw e;});}
function check(p){return ['EPL','UCL'].includes(p?.league)&&validSoccerDate(p?.boardDate)&&p.executable===false&&p.contentHash===soccerReaderHash(canonicalSoccerPayload(p));}
export async function loadSoccerReaderSnapshot(league,date){
  const id=soccerLeague(league)?.id.toUpperCase();if(!id||!validSoccerDate(date))throw Error('SOCCER_READER_SCOPE_INVALID');
  await schema();const rows=await sql()`SELECT revision,payload FROM sports_soccer_reader_snapshots_v1 WHERE league=${id} AND board_date=${date}::date ORDER BY observed_at DESC LIMIT 1`;
  if(!rows[0])return null;if(!check(rows[0].payload))throw Error('SOCCER_READER_SNAPSHOT_CORRUPTED');
  return {...rows[0].payload,revision:rows[0].revision};
}
export async function saveSoccerReaderSnapshot(payload){
  if(!check(payload))throw Object.assign(Error('SOCCER_READER_SNAPSHOT_INVALID'),{status:422});
  const previous=await loadSoccerReaderSnapshot(payload.league,payload.boardDate);
  if(previous&&Date.parse(payload.observedAt)<Date.parse(previous.observedAt))throw Object.assign(Error('SOCCER_READER_REPLAY'),{status:409});
  const revision=previous?.contentHash===payload.contentHash?previous.revision:soccerReaderHash(`${payload.contentHash}:${payload.observedAt}`);
  // Unchanged rescans refresh liveness; distinct observed price changes retain their own revision.
  await sql()`INSERT INTO sports_soccer_reader_snapshots_v1 (league,board_date,revision,content_hash,observed_at,last_seen_at,payload)
    VALUES (${payload.league},${payload.boardDate}::date,${revision},${payload.contentHash},${payload.observedAt}::timestamptz,${payload.observedAt}::timestamptz,${JSON.stringify(payload)}::jsonb)
    ON CONFLICT(league,board_date,revision) DO UPDATE SET observed_at=EXCLUDED.observed_at,last_seen_at=EXCLUDED.last_seen_at,payload=EXCLUDED.payload
    WHERE sports_soccer_reader_snapshots_v1.observed_at<=EXCLUDED.observed_at`;
  const saved=await loadSoccerReaderSnapshot(payload.league,payload.boardDate);
  if(!saved||saved.contentHash!==payload.contentHash||saved.observedAt!==payload.observedAt)throw Error('SOCCER_READER_READBACK_FAILED');
  return {persisted:true,revision,observedAt:saved.observedAt};
}
