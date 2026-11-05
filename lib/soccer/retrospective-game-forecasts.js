// Private research input. One bounded PostgreSQL MVCC statement, no writes.
// Never return payloads from an API or treat loaded captures as model approval.
import { soccerJournalQuery } from './journal.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerForwardAnalysisRevision, SOCCER_FORWARD_VERSION } from './forward-validation.js';

const MAX_ROWS=500,MAX_BYTES=24*1024*1024;
export async function loadSoccerRetrospectiveGameForecasts(league,date,gameId,
  {query=soccerJournalQuery,maxRows=MAX_ROWS,maxBytes=MAX_BYTES}={}) {
  const id=soccerLeague(league)?.id;
  if(!id||league!==id||!validSoccerDate(date)||typeof gameId!=='string'
    ||!new RegExp(`^soccer:${id}:\\d{1,16}$`).test(gameId)||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>MAX_ROWS
    ||!Number.isSafeInteger(maxBytes)||maxBytes<4||maxBytes>MAX_BYTES||typeof query!=='function')
    throw Error('SOCCER_RETROSPECTIVE_GAME_FORECAST_SCOPE_INVALID');
  // Materialize at most maxRows+1 receipts and each distinct original once.
  // LEFT JOIN detects a missing original instead of silently omitting a receipt.
  // Bounds and returned rows share this exact one-statement database snapshot.
  const rows=await query(`WITH candidates AS MATERIALIZED (
    SELECT c.capture_id,c.capture_sequence,c.league,c.game_id,c.board_date,c.period,c.variant,c.model_hash,
      c.analysis_revision,c.captured_at
    FROM sports_soccer_forward_captures_v1 c
    WHERE c.protocol_version=$1 AND c.league=$2 AND c.board_date=$3::date AND c.game_id=$4
    ORDER BY c.capture_sequence LIMIT ($5::integer+1)
  ), originals AS MATERIALIZED (
    SELECT DISTINCT c.analysis_revision,a.payload FROM candidates c
    LEFT JOIN sports_soccer_analysis_v1 a ON a.league=c.league AND a.game_id=c.game_id AND a.analysis_hash=c.analysis_revision
  ), encoded_captures AS MATERIALIZED (
    SELECT capture_sequence,jsonb_build_object('captureId',capture_id,'captureSequence',capture_sequence::text,
      'league',league,'gameId',game_id,'date',board_date::text,'period',period,'variant',variant,'modelHash',model_hash,
      'revision',analysis_revision,'capturedAt',to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS item
    FROM candidates
  ), encoded_originals AS MATERIALIZED (
    SELECT analysis_revision,payload,jsonb_build_object('revision',analysis_revision,'snapshot',payload) AS item FROM originals
  ), bounds AS (
    SELECT (SELECT count(*) FROM candidates) AS n,
      (SELECT count(*) FROM encoded_originals WHERE payload IS NULL) AS missing,
      4 + COALESCE((SELECT sum(octet_length(item::text))+GREATEST(count(*)-1,0)*2 FROM encoded_captures),0)
        + COALESCE((SELECT sum(octet_length(item::text))+GREATEST(count(*)-1,0)*2 FROM encoded_originals),0) AS bytes
  ) SELECT n::text AS n,missing::text AS missing,bytes::text AS bytes,
    CASE WHEN n<=$5::integer AND missing=0 AND bytes<=$6::integer THEN
      COALESCE((SELECT jsonb_agg(item ORDER BY capture_sequence) FROM encoded_captures),'[]'::jsonb) ELSE '[]'::jsonb END AS captures,
    CASE WHEN n<=$5::integer AND missing=0 AND bytes<=$6::integer THEN
      COALESCE((SELECT jsonb_agg(item ORDER BY analysis_revision) FROM encoded_originals),'[]'::jsonb) ELSE '[]'::jsonb END AS originals
    FROM bounds`,[SOCCER_FORWARD_VERSION,id,date,gameId,maxRows,maxBytes]);
  const row=rows[0];
  if(!row||!Array.isArray(row.captures)||!Array.isArray(row.originals))throw Error('SOCCER_RETROSPECTIVE_GAME_FORECAST_READ_FAILED');
  const count=Number(row.n),bytes=Number(row.bytes),missing=Number(row.missing);
  if(!Number.isSafeInteger(count)||!Number.isSafeInteger(bytes)||!Number.isSafeInteger(missing)||count<0||bytes<0||missing<0)
    throw Error('SOCCER_RETROSPECTIVE_GAME_FORECAST_READ_FAILED');
  const reasons=[...(count>maxRows?['FORECAST_ROW_BUDGET']:[]),...(bytes>maxBytes?['FORECAST_PAYLOAD_BYTE_BUDGET']:[]),
    ...(missing?['FORECAST_ORIGINAL_ANALYSIS_MISSING']:[])];
  if(reasons.length)return {status:'PARTIAL',captures:[],reasonCodes:reasons,countsDescribe:'BOUNDED_PREFIX_ONLY',observedCount:count,observedBytes:bytes};
  const snapshots=new Map();
  for(const original of row.originals){
    if(!original?.snapshot||typeof original.snapshot!=='object'||original.snapshot.league!==id
      ||original.snapshot.date!==date||original.snapshot.gameId!==gameId
      ||soccerForwardAnalysisRevision(original.snapshot)!==original.revision||snapshots.has(original.revision))
      return {status:'PARTIAL',captures:[],reasonCodes:['FORECAST_ORIGINAL_ANALYSIS_CORRUPTED']};
    snapshots.set(original.revision,original.snapshot);
  }
  if(row.captures.length!==count||row.captures.some(c=>c.league!==id||c.date!==date||c.gameId!==gameId
    ||!snapshots.has(c.revision)||!/^\d+$/.test(c.captureSequence)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(c.capturedAt)))
    return {status:'PARTIAL',captures:[],reasonCodes:['FORECAST_ORIGINAL_RECEIPT_MISMATCH']};
  const captures=row.captures.map(c=>({...c,snapshot:snapshots.get(c.revision)}));
  return {status:'COMPLETE',captures,reasonCodes:[],observedCount:count,observedBytes:bytes};
}
