import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured,durableDatabaseUrl } from '../database-url.js';
import { soccerAnalysisHash,SOCCER_ANALYSIS_VERSION } from './analysis.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
let client,ready;
function sql(){if(!durableDatabaseConfigured())throw Object.assign(Error('SOCCER_ANALYSIS_STORAGE_UNAVAILABLE'),{status:503});return client||=neon(durableDatabaseUrl());}
async function schema(){return ready||=(async()=>{await sql()`CREATE TABLE IF NOT EXISTS sports_soccer_analysis_v1 (league TEXT NOT NULL CHECK(league IN ('epl','ucl')),game_id TEXT NOT NULL,analysis_hash TEXT NOT NULL,observed_at TIMESTAMPTZ NOT NULL,payload JSONB NOT NULL,PRIMARY KEY(league,game_id,analysis_hash))`;})().catch(e=>{ready=null;throw e;});}
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
